"""Independent PostgreSQL connections; synthetic data only, no provider/production calls.

Hard-bound to an owned ephemeral container on 127.0.0.1:55435 and a fresh named DB.
Requires psycopg3 in a temporary venv. No production DSN/environment overrides accepted.
"""
import concurrent.futures as futures
import hashlib
import json
import pathlib
import threading
import time
import uuid

import psycopg
from psycopg.types.json import Jsonb

ROOT = pathlib.Path(__file__).resolve().parents[3]
HERE = pathlib.Path(__file__).resolve().parent
DB = 'afdian_merchandise_concurrency_lab'
RUN = uuid.uuid4().hex[:8]
APP = 'afdian-merchandise-lab:' + RUN
PRODUCT = '16b23966c0a711f183dc5254001e7c00'
SKU = '16b98478c0a711f1bb735254001e7c00'
OLD = '4c2527fc6c7411f1bbe45254001e7c00'
REPORT = []
PIDS = set()
RETRIES = []
COMPLETED = False


def connect(label, role=None, autocommit=True, database=DB):
    assert database in [DB, 'postgres']
    c = psycopg.connect(host='127.0.0.1', port=55435, dbname=database,
                        user='postgres', sslmode='disable', connect_timeout=5,
                        application_name=APP + ':' + label, autocommit=autocommit)
    assert c.execute('select current_database()').fetchone()[0] == database
    c.execute("set statement_timeout='12s'")
    c.execute("set lock_timeout='8s'")
    if role:
        assert role in ['service_role', 'authenticated', 'anon']
        c.execute('set role ' + role)
    return c


def read(path):
    return (ROOT / path).read_text()


with connect('bootstrap', database='postgres') as bootstrap:
    # A fresh DB is mandatory: reruns never drop/reset another run's data.
    assert not bootstrap.execute('select 1 from pg_database where datname=%s', (DB,)).fetchone()
    bootstrap.execute('create database ' + DB)

control = connect('control')
base = read('supabase/migrations/20260905014430_pro_payment_activation_reliability.sql')
control.execute("""create role anon; create role authenticated; create role service_role bypassrls;
create schema extensions;
create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
create schema auth;
create function auth.jwt() returns jsonb language sql as $$
 select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create table public.user_profiles(user_id text primary key,pro boolean default false,
 identity_status text default 'active',is_banned boolean default false,updated_at timestamptz default now());
create table public.pro_activations(id uuid default gen_random_uuid(),user_id text,source text,order_id text unique,
 activated_at timestamptz default now(),created_at timestamptz default now());
grant select,insert,update on public.user_profiles,public.pro_activations to service_role;
""" + base[base.index('create table'):base.index('create or replace function')]
    + read('tests/fixtures/waffo-legacy-payment-rpc.sql')
    + (HERE / 'live-rpc-baseline.sql').read_text()
    + (HERE / 'live-deletion-baseline.sql').read_text() + """
create trigger pro_payment_orders_serialize_insert before insert on public.pro_payment_orders
 for each row execute function public.sunland_serialize_pro_payment_order_insert();
revoke all on function public.sunland_activate_pro_from_payment(text,text,text,text,numeric,timestamptz) from public,anon,authenticated;
revoke all on function public.sunland_delete_account_business_data(text) from public,anon,authenticated;
grant execute on function public.sunland_activate_pro_from_payment(text,text,text,text,numeric,timestamptz) to service_role;
grant execute on function public.sunland_resolve_pro_payment(text,text) to service_role;
insert into user_profiles(user_id,pro) values('existing-pro',true),('existing-free',false);
""" + read('supabase/migrations/20261002071010_waffo_production_entitlement_sources.sql'))

# Only synthetic deletion fixtures, preserving the observed live function body.
for table in ['chat_message_images','chat_turns','chat_messages','chat_usage_entries','chat_daily_usage','chat_threads',
              'sunland_ai_turn_results','sunland_ai_migration_receipts','sunland_ai_context','sunland_ai_knowledge',
              'sunland_ai_memory','sunland_ai_user_state','comment_copilot_context','comment_copilot_usage',
              'conversations','deleted_conversations','usage','usage_logs','request_logs']:
    control.execute('create table public.' + table + '(user_id text)')
control.execute('create function public.chat_prepare_account_delete(text) returns void language plpgsql as $$begin return;end;$$')

protected_query = """select oid::regprocedure::text,pg_get_functiondef(oid) from pg_proc
 where pronamespace in ('public'::regnamespace,'waffo_prod'::regnamespace)
 and (proname like 'sunland_waffo_%' or proname in
 ('sunland_activate_pro_from_payment','sunland_resolve_pro_payment','sunland_delete_account_business_data',
 'sunland_get_or_create_pro_payment_intent','capture_legacy_payment','capture_profile_source')) order by 1"""
before_definitions = control.execute(protected_query).fetchall()
# Seed historical rows before migration; use only synthetic identities and orders.
control.execute("insert into user_profiles(user_id,pro) values('historical-pro',true),('historical-pending',false)")
control.execute("""insert into pro_payment_orders(order_id,plan_id,total_amount,bound_user_id,binding_source,status)
 values('historical-paid',%s,10,'historical-pro','legacy','activated'),
 ('historical-unresolved',%s,10,null,'unresolved','unresolved');""", (OLD,OLD), prepare=False)
old_columns='order_id,plan_id,total_amount,paid_at,bound_user_id,binding_source,status,attempt_count,last_error_code,first_seen_at,last_seen_at,activated_at,resolved_at'
historical_before=control.execute('select '+old_columns+' from pro_payment_orders order by order_id').fetchall()
before_profiles = control.execute('select * from user_profiles order by user_id').fetchall()
draft = (HERE / 'schema.DRAFT.sql').read_text()
control.execute(draft)
assert control.execute('select * from user_profiles order by user_id').fetchall() == before_profiles
assert control.execute('select '+old_columns+' from pro_payment_orders order by order_id').fetchall()==historical_before
expected_definitions = []
for signature, definition in before_definitions:
    if signature.startswith('sunland_activate_pro_from_payment(text,text,text,'):
        definition = definition.replace('  select pro_payment_orders.status',
                         '  perform pg_advisory_xact_lock(hashtext(p_order_id));\n\n  select pro_payment_orders.status')
    elif signature == 'sunland_resolve_pro_payment(text,text)':
        definition = definition.replace('  select payment_order.status, payment_order.plan_id',
                         '  perform pg_advisory_xact_lock(hashtext(p_order_id));\n\n  select payment_order.status, payment_order.plan_id')
    elif signature == 'sunland_delete_account_business_data(text)':
        definition = definition.replace('  perform public.chat_prepare_account_delete(p_user_id);',
                         '  perform public.sunland_scrub_afdian_user_references(p_user_id);\n  perform public.chat_prepare_account_delete(p_user_id);')
    expected_definitions.append((signature, definition))
assert control.execute(protected_query).fetchall() == expected_definitions


def record(name, **detail):
    REPORT.append({'test': name, 'result': 'PASS', **detail})
    print(name + ' PASS', flush=True)


record('migration-preserves-profiles-and-protected-definitions')


def fixture(label, intent=True):
    user = 'lab-' + RUN + '-' + label
    reference = str(uuid.uuid4())
    control.execute('insert into user_profiles(user_id) values(%s)', (user,))
    if intent:
        control.execute('insert into pro_payment_intents(payment_reference,user_id) values(%s,%s)', (reference,user))
    return user, reference


def order(label, reference, **patch):
    value = dict(order_id='lab-' + RUN + '-' + label, provider='afdian',payment_status='paid',
                 plan_id=PRODUCT,product_type=1,amount_cents=1500,total_amount='15.00',currency='CNY',
                 sku_detail=[dict(sku_id=SKU,count=1)],binding_source='intent',binding_reference=reference,paid_at=None)
    value.update(patch)
    return value


def rpc(c, value, source='webhook', cached=False):
    return c.execute('select public.sunland_process_verified_pro_order(%s,%s,%s,%s)',
                     (Jsonb(value),source,str(uuid.uuid4()),cached)).fetchone()[0]


def ispro(user):
    return control.execute('select pro from user_profiles where user_id=%s', (user,)).fetchone()[0]


def ledger(order_id):
    return control.execute('select status,bound_user_id,verified_binding_reference,last_error_code from pro_payment_orders where order_id=%s', (order_id,)).fetchone()


def sources(user):
    return control.execute('select provider,source_id,active from waffo_prod.entitlement_sources where user_id=%s order by 1,2', (user,)).fetchall()


def single(value, source='webhook'):
    with connect('single', 'service_role') as c:
        return rpc(c,value,source)


def race(label, tasks, blocked_order=None, role='service_role'):
    barrier = threading.Barrier(len(tasks) + 1)
    observed = set()
    lock = threading.Lock()
    # PostgreSQL truncates application_name at 63 bytes; keep the observed group short.
    group = 'race-' + hashlib.sha256(label.encode()).hexdigest()[:8]
    gate = connect('gate-' + label) if blocked_order else None
    if gate:
        gate.execute('select pg_advisory_lock(hashtext(%s))',(blocked_order,))
    def run(index, task):
        for attempt in range(5):
            with connect(group + '-' + str(index), role, autocommit=False) as c:
                with lock:
                    observed.add(c.info.backend_pid)
                    PIDS.add(c.info.backend_pid)
                if attempt == 0:
                    barrier.wait(timeout=10)
                try:
                    result = task(c)
                    c.commit()
                    return result
                except psycopg.Error as error:
                    c.rollback()
                    if error.sqlstate in ['40P01','40001','55P03'] and attempt < 4:
                        with lock:
                            RETRIES.append(error.sqlstate)
                        time.sleep(0.03 * (attempt + 1))
                        continue
                    return {'sqlstate': error.sqlstate}
        raise AssertionError('retry exhausted')
    with futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        jobs = [pool.submit(run,i,t) for i,t in enumerate(tasks)]
        barrier.wait(timeout=10)
        waiters = 0
        if gate:
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    waiters = control.execute("select count(*) from pg_stat_activity where application_name like %s and wait_event='advisory'", (APP + ':' + group + '-%',)).fetchone()[0]
                    if waiters == len(tasks):
                        break
                    time.sleep(0.02)
                assert waiters >= 2, 'did not observe independent concurrent advisory waiters'
            finally:
                gate.execute('select pg_advisory_unlock(hashtext(%s))',(blocked_order,))
                gate.close()
        result = [job.result(timeout=20) for job in jobs]
    assert len(observed) >= len(tasks), 'connections were not independent'
    record(label, connections=len(observed), observed_advisory_waiters=waiters)
    return result


def tasks_for(value, count=12):
    return [lambda c,i=i:rpc(c,value,source='webhook' if i % 2 == 0 else 'user_reconcile') for i in range(count)]


def ordered_duel(label, first, second):
    """Force the first transaction to own locks before admitting the second connection."""
    first_conn=connect('ordered-first','service_role',autocommit=False)
    started=threading.Event()
    second_pid=[]
    first(first_conn)
    PIDS.add(first_conn.info.backend_pid)
    def run_second():
        with connect('ordered-second','service_role',autocommit=False) as c:
            second_pid.append(c.info.backend_pid);PIDS.add(c.info.backend_pid);started.set()
            value=second(c);c.commit();return value
    with futures.ThreadPoolExecutor(max_workers=1) as pool:
        job=pool.submit(run_second)
        assert started.wait(5)
        wait=None
        try:
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                row=control.execute('select wait_event from pg_stat_activity where pid=%s',(second_pid[0],)).fetchone()
                wait=row[0] if row else None
                if wait in ['advisory','transactionid','tuple']:
                    break
                time.sleep(0.02)
            assert wait in ['advisory','transactionid','tuple'], 'second transaction did not wait for first'
        finally:
            first_conn.commit();first_conn.close()
        result=job.result(timeout=15)
    record(label,connections=2,forced_first_transaction=True,observed_wait=wait)
    return result


try:
    user,ref = fixture('same-order'); o = order('same-order',ref)
    results = race('webhook-vs-reconcile',tasks_for(o),o['order_id'])
    assert all(r.get('status')=='activated' for r in results)
    assert ledger(o['order_id'])[:3] == ('activated',user,ref)
    assert ispro(user)
    assert control.execute('select count(*) from pro_activations where order_id=%s',(o['order_id'],)).fetchone()[0] == 1
    assert sources(user).count(('other','payment:' + o['order_id'],True)) == 1
    before = sources(user)
    race('duplicate-webhook-after-activation',tasks_for(o),o['order_id'])
    assert sources(user) == before
    assert control.execute('select count(*) from pro_payment_orders where order_id=%s',(o['order_id'],)).fetchone()[0] == 1

    a,ra = fixture('owner-a'); b,rb = fixture('owner-b'); oa = order('owner-competition',ra); ob = dict(oa,binding_reference=rb)
    results = race('same-order-competing-users', [lambda c,i=i:rpc(c,oa if i%2==0 else ob) for i in range(12)],oa['order_id'])
    winner = ledger(oa['order_id'])[1]
    assert winner in [a,b] and int(ispro(a))+int(ispro(b)) == 1
    loser = b if winner == a else a
    assert control.execute('select status from pro_payment_intents where user_id=%s',(winner,)).fetchone()[0]=='activated'
    assert control.execute('select status from pro_payment_intents where user_id=%s',(loser,)).fetchone()[0]=='pending'
    assert control.execute('select user_id from waffo_prod.entitlement_sources where source_id=%s',('payment:'+oa['order_id'],)).fetchall()==[(winner,)]
    assert any(r.get('reason_code')=='BINDING_CONFLICT' for r in results)
    assert control.execute('select count(*) from pro_activations where order_id=%s',(oa['order_id'],)).fetchone()[0] == 1

    u,_ = fixture('intent-contention',intent=False)
    def create_intent(c):
        c.execute("select set_config('request.jwt.claims',%s,true)",(json.dumps({'role':'authenticated','id':u}),))
        return c.execute('select * from public.sunland_get_or_create_pro_payment_intent()').fetchone()[0]
    intents = race('same-user-idempotent-intent', [create_intent]*12,role='authenticated')
    assert len(set(intents)) == 1
    assert control.execute('select count(*) from pro_payment_intents where user_id=%s',(u,)).fetchone()[0] == 1
    def extra_intent(c):
        c.execute('insert into pro_payment_intents(user_id) values(%s)',(u,))
    blocked = race('same-user-extra-intents-rejected',[extra_intent]*4)
    assert all(r.get('sqlstate')=='23505' for r in blocked)

    u,r = fixture('many-orders')
    many = [order('many-' + str(i),r) for i in range(12)]
    assert all(x.get('status')=='activated' for x in race('same-user-many-orders',[lambda c,o=o:rpc(c,o) for o in many]))
    assert len([x for x in sources(u) if x[1].startswith('payment:') and x[2]]) == 12

    for kind in ['legacy-six','legacy-manual']:
        for run in range(4):
            u,r = fixture(kind + str(run)); old = order(kind + str(run),r,plan_id=OLD,product_type=0,total_amount='10.00',amount_cents=1000,sku_detail=[])
            if kind=='legacy-manual':
                control.execute("insert into pro_payment_orders(order_id,plan_id,total_amount,binding_source,status) values(%s,%s,10,'unresolved','unresolved')",(old['order_id'],OLD))
                other = lambda c,o=old,u=u: c.execute('select * from public.sunland_resolve_pro_payment(%s,%s)',(o['order_id'],u)).fetchone()[0]
            else:
                other = lambda c,o=old: c.execute('select * from public.sunland_activate_pro_from_payment(%s,%s,%s,%s,10,null)',(o['order_id'],r,'intent',OLD)).fetchone()[0]
            tasks = [lambda c,o=old:rpc(c,o),other]
            if run % 2:
                tasks.reverse()
            race(kind + '-mixed-' + str(run),tasks,old['order_id'])
            assert ispro(u) and ledger(old['order_id'])[1] == u
        for first_is_verified in [False,True]:
            u,r=fixture(kind+'-ordered-'+str(first_is_verified))
            old=order(kind+'-ordered-'+str(first_is_verified),r,plan_id=OLD,product_type=0,total_amount='10.00',amount_cents=1000,sku_detail=[])
            verified=lambda c,o=old:rpc(c,o)
            if kind=='legacy-manual':
                control.execute("insert into pro_payment_orders(order_id,plan_id,total_amount,binding_source,status) values(%s,%s,10,'unresolved','unresolved')",(old['order_id'],OLD))
                legacy=lambda c,o=old,u=u:c.execute('select * from public.sunland_resolve_pro_payment(%s,%s)',(o['order_id'],u)).fetchone()[0]
            else:
                legacy=lambda c,o=old,r=r:c.execute('select * from public.sunland_activate_pro_from_payment(%s,%s,%s,%s,10,null)',(o['order_id'],r,'intent',OLD)).fetchone()[0]
            ordered_duel(kind+'-verified-first-'+str(first_is_verified),verified if first_is_verified else legacy,legacy if first_is_verified else verified)
            assert ispro(u) and ledger(old['order_id'])[1]==u

    u,r = fixture('coexist'); old = order('coexist-old',r,plan_id=OLD,product_type=0,total_amount='10.00',amount_cents=1000,sku_detail=[]); new=order('coexist-new',r)
    race('old-and-merchandise-coexist',[lambda c:rpc(c,old),lambda c:rpc(c,new)])
    assert ispro(u) and ledger(old['order_id'])[0]=='activated' and ledger(new['order_id'])[0]=='activated'

    config=dict(mode='prod',merchant_id='MER_6mey7SY5b0KXN1W7JiZYSz',store_id='STO_4gmpGF9UEj1SO6vpelNcmy',product_id='PROD_5buXbrDEzQX6Nya6p1wMC5',currency='CNY',amount_minor=1500)
    def waffo_fixture(label,u):
        ref=str(uuid.uuid4()); req=str(uuid.uuid4())
        control.execute('select public.sunland_waffo_register_intent(%s)',(Jsonb(dict(config,user_id=u,payment_reference=ref,request_key=req)),))
        return dict(config,user_id=u,payment_reference=ref,order_id='ORD_'+RUN+label,payment_id='PAY_'+RUN+label,event_id='PAY_'+RUN+label,event_type='order.completed',event_sha256='a'*64,proof_sha256='b'*64,charged_minor=1500,payment_status='succeeded',order_status='completed',entitlement_enabled=True)
    def wcall(c,event):
        return c.execute('select public.sunland_waffo_apply_event(%s)',(Jsonb(event),)).fetchone()[0]
    for run in range(6):
        u,r=fixture('dual-'+str(run)); o=order('dual-'+str(run),r); e=waffo_fixture('dual'+str(run),u)
        race('waffo-and-afdian-grant-'+str(run),[lambda c,o=o:rpc(c,o),lambda c,e=e:wcall(c,e)])
        assert ispro(u) and ('other','payment:'+o['order_id'],True) in sources(u) and ('waffo',e['order_id'],True) in sources(u)
        refund=dict(e,event_type='refund.succeeded',event_id='RFD_'+RUN+str(run),refund_status='succeeded',event_sha256='c'*64)
        race('waffo-refund-and-afdian-replay-'+str(run),[lambda c,o=o:rpc(c,o),lambda c,e=refund:wcall(c,e)])
        assert ispro(u) and ('waffo',e['order_id'],False) in sources(u) and ('other','payment:'+o['order_id'],True) in sources(u)

    for refund_first in [False,True]:
        u,r=fixture('ordered-refund-'+str(refund_first));o=order('ordered-refund-'+str(refund_first),r);e=waffo_fixture('orderedrefund'+str(refund_first),u)
        wcall(control,e)
        refund=dict(e,event_type='refund.succeeded',event_id='RFD_ordered'+RUN+str(refund_first),refund_status='succeeded',event_sha256='c'*64)
        grant=lambda c,o=o:rpc(c,o)
        revoke=lambda c,e=refund:wcall(c,e)
        ordered_duel('refund-first-'+str(refund_first),revoke if refund_first else grant,grant if refund_first else revoke)
        assert ispro(u) and ('waffo',e['order_id'],False) in sources(u) and ('other','payment:'+o['order_id'],True) in sources(u)

    for status in ['refunded','cancelled']:
        u,r=fixture('terminal-'+status);o=order('terminal-'+status,r)
        ordered_duel('terminal-before-paid-'+status,lambda c,o=o,s=status:rpc(c,dict(o,payment_status=s)),lambda c,o=o:rpc(c,o))
        assert not ispro(u) and not sources(u)
    for run in range(6):
        u,r=fixture('refund-new-'+str(run)); o=order('refund-new-'+str(run),r); e=waffo_fixture('refundnew'+str(run),u)
        control.execute('select public.sunland_waffo_apply_event(%s)',(Jsonb(e),))
        refund=dict(e,event_type='refund.succeeded',event_id='RFD_new'+RUN+str(run),refund_status='succeeded',event_sha256='c'*64)
        race('waffo-refund-and-new-afdian-'+str(run),[lambda c,o=o:rpc(c,o),lambda c,e=refund:wcall(c,e)])
        assert ispro(u) and ('waffo',e['order_id'],False) in sources(u) and ('other','payment:'+o['order_id'],True) in sources(u)

    for field,patch in [('product',{'plan_id':'a'*32}),('sku',{'sku_detail':[dict(sku_id='b'*32,count=1)]}),
                       ('quantity',{'sku_detail':[dict(sku_id=SKU,count=2)]}),('amount',{'amount_cents':1499,'total_amount':'14.99'}),
                       ('currency',{'currency':'USD'}),('status',{'payment_status':'unknown'})]:
        u,r=fixture('wrong-'+field); bad=order('wrong-'+field,r,**patch)
        race('reject-'+field,tasks_for(bad,4),bad['order_id'])
        assert not ispro(u) and not sources(u)

    for legacy in [False,True]:
        u,r=fixture('erasure-'+str(legacy),intent=not legacy)
        if legacy:
            # Historical legacy references require UUID/hex-shaped user IDs.
            replacement=str(uuid.uuid4())
            control.execute('update user_profiles set user_id=%s where user_id=%s',(replacement,u));u=replacement
        o=order('erasure-'+str(legacy),r if not legacy else u,**({'plan_id':OLD,'product_type':0,'total_amount':'10.00','amount_cents':1000,'binding_source':'legacy','sku_detail':[]} if legacy else {}))
        def delete(c,u=u):
            c.execute("update user_profiles set identity_status='retired' where user_id=%s",(u,))
            return c.execute('select * from public.sunland_delete_account_business_data(%s)',(u,)).fetchone()[0]
        # Deletion is a definer-only server operation; use owned fixture admin, never a production credential.
        race('grant-vs-account-erasure-'+str(legacy),[lambda c,o=o:rpc(c,o),delete],role=None)
        row=ledger(o['order_id'])
        assert row[1] is None and row[2] is None
        result=single(o)
        assert result.get('reason_code') in ['DATA_DELETED','ACCOUNT_RETIRED','OWNER_ANONYMIZED']

    u,r=fixture('failure'); o=order('failure',r)
    control.execute("""create function public.lab_fail() returns trigger language plpgsql as $$begin
      if new.order_id=%s and new.status='activated' then raise exception 'LAB_FAILURE';end if;return new;end;$$;
      create trigger lab_fail before update on public.pro_payment_orders for each row execute function public.lab_fail();""" % ("'"+o['order_id']+"'"))
    failed=race('rpc-failure-atomic-rollback',tasks_for(o,6),o['order_id'])
    assert all(x.get('sqlstate')=='P0001' for x in failed)
    assert not ispro(u) and not sources(u) and ledger(o['order_id']) is None
    control.execute('drop trigger lab_fail on pro_payment_orders;drop function public.lab_fail()')
    race('retry-after-failure',tasks_for(o,6),o['order_id']);assert ispro(u)

    u,r=fixture('lost-commit-response'); o=order('lost-commit-response',r)
    with connect('committed-response-lost','service_role',autocommit=False) as c:
        rpc(c,o);c.commit()
        # Intentionally discard the committed result and close the connection.
    before=sources(u)
    race('retry-after-committed-response-loss',tasks_for(o,6),o['order_id'])
    assert sources(u)==before and ispro(u)

    u,r=fixture('crashed-transaction');o=order('crashed-transaction',r)
    c=connect('crash','service_role',autocommit=False)
    rpc(c,o)
    control.execute('select pg_terminate_backend(%s)',(c.info.backend_pid,))
    c.close()
    assert not ispro(u) and not sources(u) and ledger(o['order_id']) is None
    race('retry-after-backend-termination',tasks_for(o,6),o['order_id']);assert ispro(u)

    keep=control.execute('select user_id,pro from user_profiles order by user_id').fetchall()
    control.execute((HERE/'rollback.DRAFT.sql').read_text())
    with connect('rollback-acl','service_role') as c:
        try:rpc(c,o);raise AssertionError('rollback did not block RPC')
        except psycopg.errors.InsufficientPrivilege:pass
    assert control.execute('select user_id,pro from user_profiles order by user_id').fetchall()==keep
    control.execute('grant execute on function public.sunland_process_verified_pro_order(jsonb,text,uuid,boolean) to service_role')
    before=sources(u);race('retry-after-forward-rollback',tasks_for(o,6),o['order_id']);assert sources(u)==before
    assert control.execute(protected_query).fetchall()==expected_definitions
    assert ispro('existing-pro') and not ispro('existing-free')
    record('final-backward-compatibility-and-existing-pro-preserved')
    COMPLETED=True
finally:
    result={'overall':'PASS' if COMPLETED else 'FAIL','schema_sha256':hashlib.sha256(draft.encode()).hexdigest(),'postgres':control.execute('show server_version').fetchone()[0],
            'database':DB,'cases':REPORT,'distinct_backends':len(PIDS),'retry_sqlstates':RETRIES,
            'production_access':False,'provider_calls':False}
    (pathlib.Path('/tmp')/'afdian-merchandise-concurrency-results.json').write_text(json.dumps(result,indent=2))
    control.close()

print(json.dumps({'passed':len(REPORT),'distinct_backends':len(PIDS),'retry_sqlstates':RETRIES}),flush=True)
