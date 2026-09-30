"""Synthetic PG17 laboratory. Requires psycopg3; never accepts another DB/host.
Run: PYTHONPATH=<isolated driver directory> python3 tests/afdianpay-lab.py
No production credentials or customer data. Evidence is written outside the checkout.
"""
import json, os, pathlib, time, uuid, threading, socket, struct, hashlib, subprocess
import psycopg
from psycopg.types.json import Jsonb
DB='sunland_payment_phase3_lab'
PREFIX='sunland-payment-phase3:'
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=pathlib.Path(os.environ.get('SUNLAND_LAB_OUTPUT','/tmp/sunland-payment-phase3'))
OUT.mkdir(exist_ok=True,parents=True)
RUN=uuid.uuid4().hex[:8]
RESULTS=[]
OWNED_PIDS=set()
TRACE=str(uuid.uuid4())
PLAN='4c2527fc6c7411f1bbe45254001e7c00'

def snapshot(name):
    paths=['workers/afdianpay/worker.js','ai/pro-payment.js','ai/app.js','ai.html','ai_settings.html']
    paths += [str(p.relative_to(ROOT)) for p in (ROOT/'supabase/migrations').glob('*.sql') if 'payment' in p.name]
    paths += [str(p.relative_to(ROOT)) for p in (ROOT/'tests').glob('*payment*') if p.is_file()]
    paths += [str(p.relative_to(ROOT)) for p in (ROOT/'tests').glob('afdianpay*') if p.is_file()]
    data={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
          'status':subprocess.check_output(['git','status','--short'],cwd=ROOT,text=True),
          'hashes':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sorted(set(paths))}}
    (OUT/(name+'.json')).write_text(json.dumps(data,indent=2));return data

def connection(name, role=None, autocommit=True, port=54322, client=False):
    c=psycopg.connect(host='127.0.0.1',port=port,dbname=DB,user='postgres',password='postgres',
      sslmode='disable',application_name=PREFIX+name,autocommit=autocommit,
      cursor_factory=psycopg.ClientCursor if client else psycopg.Cursor)
    assert c.execute('select current_database()').fetchone()[0]==DB
    OWNED_PIDS.add(c.info.backend_pid)
    if role:c.execute('set role '+role)
    return c

control=connection('control')

def sql(q,args=None):return control.execute(q,args)
def fixture(label,reference=None,user=None):
    user=user or 'lab-'+RUN+'-'+label
    reference=reference or str(uuid.uuid4())
    sql('insert into public.user_profiles(user_id,pro) values(%s,false) on conflict(user_id) do nothing',(user,))
    sql('insert into public.pro_payment_intents(payment_reference,user_id) values(%s,%s) on conflict(user_id) do nothing',(reference,user))
    return user,reference

def order(label,ref,**overrides):
    return dict(order_id='lab-'+RUN+'-'+label,payment_status='paid',plan_id=PLAN,product_type=0,
      amount_cents=1000,total_amount='10.00',currency='CNY',binding_reference=ref,binding_source='intent',paid_at=None,**overrides)

def call(c,value,source='webhook',cached=False,name='sunland_process_verified_pro_order'):
    return c.execute('select public.'+name+'(%s,%s,%s,%s)',(Jsonb(value),source,TRACE,cached)).fetchone()[0]

def rows(ids,users):
    return {'orders':sql('select order_id,status,payment_status,bound_user_id,last_error_code,next_retry_at,verified_binding_reference,last_verified_at,binding_reference_verified_at from pro_payment_orders where order_id=any(%s) order by order_id',(ids,)).fetchall(),
     'profiles':sql('select user_id,pro,identity_status from user_profiles where user_id=any(%s) order by user_id',(users,)).fetchall(),
     'intents':sql('select payment_reference,user_id,status from pro_payment_intents where user_id=any(%s) order by user_id',(users,)).fetchall()}

def record(name,detail):
    RESULTS.append({'test':name,'result':'PASS',**detail});(OUT/'pg-lab-results.json').write_text(json.dumps(RESULTS,default=str,indent=2));print(name+' PASS',flush=True)

def acl():
    for role in ['anon','authenticated']:
      with connection('acl-'+role,role) as c:
       denials=[]
       cases=[('v2',lambda:call(c,order('acl',str(uuid.uuid4())))),
         ('scan',lambda:c.execute("select sunland_claim_pro_payment_scan('history')")),
         ('ledger',lambda:c.execute('select * from pro_payment_orders')),
         ('state',lambda:c.execute('select * from pro_payment_reconciliation_state')),
         ('pro-update',lambda:c.execute("update user_profiles set pro=true where user_id='lab-acl'")),
         ('pro-insert',lambda:c.execute("insert into user_profiles(user_id,pro) values('lab-acl',true)"))]
       for name,fn in cases:
        try:fn();raise AssertionError('unauthorized '+name)
        except psycopg.errors.InsufficientPrivilege as e:denials.append({'operation':name,'sqlstate':e.sqlstate})
       funcs=c.execute("select p.oid::regprocedure::text,has_function_privilege(current_user,p.oid,'execute') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like '%pro_payment%' or p.proname='sunland_activate_pro_from_payment' or p.proname='sunland_process_verified_pro_order') order by 1").fetchall()
       assert all(not allowed for name,allowed in funcs if 'get_or_create_pro_payment_intent' not in name)
       record('ACL-'+role,{'real_role':role,'denials':denials,'all_overloads':funcs})
    with connection('acl-service','service_role') as c:
      user,ref=fixture('acl-service');r=call(c,order('acl-service',ref));assert r['status']=='activated'
      record('ACL-service-role',{'rpc':r,'rows':rows([order('acl-service',ref)['order_id']],[user])})

def integration():
    with connection('integration','service_role') as c:
      ref=str(uuid.uuid4());o=order('outage-cache',ref);first=call(c,o)
      assert first['reason_code']=='INTENT_NOT_FOUND'
      before=rows([o['order_id']],[]);user,_=fixture('outage-cache',ref)
      result=call(c,{'order_id':o['order_id']},cached=True);after=rows([o['order_id']],[user])
      assert result['reason_code']=='PROVIDER_VERIFICATION_REQUIRED' and result['status']=='unresolved'
      assert not after['profiles'][0][1] and before['orders'][0][-2:]==after['orders'][0][-2:]
      record('I-Cache-Provider-Offline-Blocked',{'before':before,'after':after,'first':first,'cached':result,'provider_calls_after_intent_created':0})
      assert call(c,o)['status']=='activated'
      refund={**o,'payment_status':'refunded'};r=call(c,refund);after=rows([o['order_id']],[user]);assert after['orders'][0][1:3]==('activated','refunded');assert after['profiles'][0][1]
      record('I-refund-independent',{'observation':'synthetic canonical refund, not confirmed provider enum','rpc':r,'after':after})
      ref=str(uuid.uuid4());o=order('refund-before-intent',ref);call(c,o)
      sql("update pro_payment_orders set last_verified_at=now()-interval '6 minutes' where order_id=%s",(o['order_id'],))
      r=call(c,{**o,'payment_status':'refunded'});user,_=fixture('refund-before-intent',ref)
      cached=call(c,{'order_id':o['order_id']},cached=True);after=rows([o['order_id']],[user])
      assert r['payment_status']=='refunded' and cached['reason_code']=='PROVIDER_VERIFICATION_REQUIRED'
      assert after['orders'][0][2]=='refunded' and not after['profiles'][0][1]
      record('I-Paid-Refunded-Provider-Offline-No-Grant',{'refund':r,'cached':cached,'after':after})
      ref_a=str(uuid.uuid4());ref_b=str(uuid.uuid4());o=order('metadata-change',ref_a);call(c,o)
      user_a,_=fixture('metadata-a',ref_a);user_b,_=fixture('metadata-b',ref_b)
      changed=call(c,{**o,'binding_reference':ref_b});after=rows([o['order_id']],[user_a,user_b])
      assert changed['reason_code']=='BINDING_CONFLICT' and all(not p[1] for p in after['profiles'])
      assert after['orders'][0][6]==ref_a
      record('I-Provider-Metadata-Changed-No-Rebind',{'rpc':changed,'after':after})
      ref=str(uuid.uuid4());o=order('expired-cache',ref);call(c,o);user,_=fixture('expired-cache',ref)
      sql("update pro_payment_orders set last_verified_at=now()-interval '16 minutes',binding_reference_verified_at=now()-interval '16 minutes' where order_id=%s",(o['order_id'],))
      r=call(c,{'order_id':o['order_id']},cached=True);assert r['reason_code']=='PROVIDER_VERIFICATION_REQUIRED';assert not rows([o['order_id']],[user])['profiles'][0][1]
      assert call(c,o)['status']=='activated';record('I-expired-cache',{'cached':r,'fresh_query':'activated'})
      for legacy in ['two','six','manual']:
       user,ref=fixture('legacy-'+legacy);o=order('legacy-'+legacy,ref)
       if legacy=='two':r=c.execute('select sunland_activate_pro_from_payment(%s,%s)',(user,o['order_id'])).fetchone()[0]
       elif legacy=='six':r=c.execute('select * from sunland_activate_pro_from_payment(%s,%s,%s,%s,%s,%s)',(o['order_id'],ref,'intent',PLAN,10,None)).fetchone()[0]
       else:r=c.execute('select * from sunland_resolve_pro_payment(%s,%s)',(o['order_id'],user)).fetchone()[0]
       assert not rows([o['order_id']],[user])['profiles'][0][1];record('I-legacy-'+legacy,{'rpc':r,'after':rows([o['order_id']],[user])})
      user,ref=fixture('historic');o=order('historic',ref)
      sql("insert into pro_activations(user_id,source,order_id) values(%s,'payment',%s)",(user,o['order_id']))
      r=call(c,o);assert r['reason_code']=='HISTORICAL_PAYMENT_ACTIVATION';assert not rows([o['order_id']],[user])['profiles'][0][1]
      record('I-historical-payment-consumed',{'rpc':r,'after':rows([o['order_id']],[user])})
      # Runtime boundary validation, beyond SQL text matching.
      for label,patch in [('cents',{'amount_cents':999}),('scientific',{'total_amount':'1e1'}),('product-type',{'product_type':'0'}),('paid-type',{'payment_status':2})]:
       bad={**order('invalid-'+label,str(uuid.uuid4())),**patch}
       try:call(c,bad);raise AssertionError('invalid scalar accepted')
       except psycopg.errors.InvalidParameterValue:pass
      for label,patch in [('wrong-plan',{'plan_id':'another-plan'}),('amount-zero',{'total_amount':'0.00','amount_cents':0}),('amount-nine',{'total_amount':'9.99','amount_cents':999}),('foreign-currency',{'currency':'USD'})]:
       u,reference=fixture('policy-'+label);o={**order('policy-'+label,reference),**patch};r=call(c,o)
       assert r['status']!='activated' and not rows([o['order_id']],[u])['profiles'][0][1]
       record('I-policy-'+label,{'rpc':r,'after':rows([o['order_id']],[u])})
      retired='33333333333333333333333333333333';sql("insert into user_profiles(user_id,identity_status) values(%s,'retired') on conflict do nothing",(retired,))
      o={**order('bad-retired',None),'binding_source':'legacy','binding_reference':retired,'product_type':1};r=call(c,o)
      assert rows([o['order_id']],[retired])['orders'][0][6] is None;record('I-rejected-ref-privacy',{'rpc':r,'after':rows([o['order_id']],[retired])})
      # Claims are real simultaneous sessions; only one provider request can start.
      o=order('replay',str(uuid.uuid4()));c.execute('select sunland_record_pro_payment_hints(%s,%s,%s)',([o['order_id']],'webhook',TRACE))
      barrier=threading.Barrier(12);claims=[]
      def claim(i):
       with connection('claim-'+str(i),'service_role') as d:
        barrier.wait();claims.append(d.execute('select sunland_claim_pro_payment_order_query(%s)',(o['order_id'],)).fetchone()[0])
      ts=[threading.Thread(target=claim,args=(i,)) for i in range(12)];[t.start() for t in ts];[t.join() for t in ts]
      assert sum(r['acquired'] for r in claims)==1;record('I-12-signed-replay-query-claims',{'claimed':claims,'allowed_provider_requests':1})

def wait_locked(pids):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
      activity=sql('select pid,application_name,state,wait_event_type,wait_event,query from pg_stat_activity where pid=any(%s)',(pids,)).fetchall()
      if any(r[3]=='Lock' for r in activity):
       locks=sql('select pid,locktype,mode,granted,relation::regclass::text,classid,objid from pg_locks where pid=any(%s) order by pid,granted',(pids,)).fetchall()
       return {'pg_stat_activity':activity,'pg_locks':locks}
      time.sleep(.02)
    raise AssertionError('expected real blocked session')

def pair(name,valueA,valueB,users,sourceA='webhook',sourceB='cron_recent',fnA=None,fnB=None,expected_error=None):
    a=connection(name+'-A','service_role',False);b=connection(name+'-B','service_role',False)
    ids=list(dict.fromkeys([valueA['order_id'],valueB['order_id']]));before=rows(ids,users);timeline=[];errors=[];resultB=[]
    timeline.append({'A':'BEGIN','time':time.monotonic()});rA=fnA(a) if fnA else call(a,valueA,sourceA);timeline.append({'A':'RPC returned; transaction uncommitted','result':rA,'time':time.monotonic()})
    def runB():
      try:
       timeline.append({'B':'BEGIN/RPC started','time':time.monotonic()});r=fnB(b) if fnB else call(b,valueB,sourceB);resultB.append(r);b.commit();timeline.append({'B':'COMMIT','result':r,'time':time.monotonic()})
      except Exception as e:
       b.rollback()
       if expected_error and getattr(e,'sqlstate',None)==expected_error:
        resultB.append({'sqlstate':e.sqlstate,'message':str(e)});timeline.append({'B':'ROLLBACK expected denial','time':time.monotonic()})
       else:errors.append(str(e))
    t=threading.Thread(target=runB);t.start();evidence=wait_locked([a.info.backend_pid,b.info.backend_pid]);a.commit();timeline.append({'A':'COMMIT','time':time.monotonic()});t.join(8)
    assert not t.is_alive() and not errors,errors;after=rows(ids,users);a.close();b.close()
    record(name,{'session_A_timeline':timeline,'locks_while_B_waited':evidence,'before':before,'after':after,'rpc_A':rA,'rpc_B':resultB[0]})
    return after,rA,resultB[0]

def deletion(c,user):
    job=str(uuid.uuid4());attempt='lab-delete-attempt-0001'
    begin=c.execute('select sunland_account_delete_begin(%s,%s,%s,%s)',(user,job,attempt,1)).fetchone()[0]
    assert begin['code'] in ['revoked','already_revoked']
    cleanup=c.execute('select * from sunland_delete_account_business_data(%s)',(user,)).fetchone()[0]
    end=c.execute('select sunland_account_delete_finalize(%s,%s,%s,%s)',(user,job,attempt,1)).fetchone()[0]
    c.execute('select sunland_account_delete_sanitize_profile(%s,%s,%s,%s)',(user,job,attempt,1))
    return {'begin':begin,'business':cleanup,'finalize':end}

def concurrency():
    for num,sa,sb in [(1,'webhook','webhook'),(3,'webhook','cron_recent'),(4,'webhook','manual_query'),(5,'cron_recent','cron_history')]:
      u,r=fixture('pg'+str(num));o=order('pg'+str(num),r);after,a,b=pair('PG-'+str(num),o,o,[u],sa,sb)
      assert after['orders'][0][1]=='activated' and after['profiles'][0][1] and after['intents'][0][2]=='activated';assert b['already_processed']
    ua,ra=fixture('pg2a');ub,rb=fixture('pg2b');o=order('pg2',ra)
    after,a,b=pair('PG-2',o,{**o,'binding_reference':rb},[ua,ub]);assert after['orders'][0][3]==ua;assert next(p for p in after['profiles'] if p[0]==ub)[1] is False;assert b['reason_code']=='BINDING_CONFLICT'
    u,r=fixture('pg6');after,a,b=pair('PG-6',order('pg6a',r),order('pg6b',r),[u]);assert all(o[1]=='activated' for o in after['orders'])
    u,r=fixture('pg7');o=order('pg7',r);after,a,b=pair('PG-7',o,o,[u],fnB=lambda c:deletion(c,u));assert after['profiles'][0][2]=='retired' and not after['profiles'][0][1] and after['orders'][0][3] is None
    u,r=fixture('pg8');o=order('pg8',r);after,a,b=pair('PG-8',o,o,[u],fnA=lambda c:deletion(c,u));assert b['status']!='activated' and not after['profiles'][0][1]
    u,r=fixture('pg9');o=order('pg9',r)
    after,a,b=pair('PG-9',o,o,[u],fnA=lambda c:c.execute('select user_id from user_profiles where user_id=%s for update',(u,)).fetchone()[0],fnB=lambda c:c.execute('select * from sunland_delete_account_business_data(%s)',(u,)).fetchone()[0],expected_error='42501')
    assert b['sqlstate']=='42501' and after['profiles'][0][2]=='active' and len(after['intents'])==1
    u,r=fixture('pg10');o=order('pg10',r);after,a,b=pair('PG-10',o,o,[u],fnA=lambda c:c.execute('select * from sunland_activate_pro_from_payment(%s,%s,%s,%s,%s,%s)',(o['order_id'],r,'intent',PLAN,10,None)).fetchone()[0]);assert a=='unresolved' and b['status']=='activated'
    u,r=fixture('pg11');o=order('pg11',r)
    with connection('PG11-seed','service_role') as c:call(c,o);deletion(c,u)
    after,a,b=pair('PG-11',o,o,[u]);assert a['already_processed'] and b['already_processed'] and after['orders'][0][3] is None and after['orders'][0][6] is None and not after['profiles'][0][1]
    r=str(uuid.uuid4());o=order('pg12',r)
    with connection('PG12-seed','service_role') as c:assert call(c,o)['reason_code']=='INTENT_NOT_FOUND'
    u,_=fixture('pg12',r)
    after,a,b=pair('PG-12',o,o,[u],fnA=lambda c:deletion(c,u));assert b['status']!='activated' and after['orders'][0][6] is None and after['orders'][0][3] is None and not after['profiles'][0][1]
    # Historical anonymous U has no old owner/ref and must never be re-bound.
    u,r=fixture('anonymous-U');o=order('anonymous-U',r);sql("insert into pro_payment_orders(order_id,plan_id,total_amount,status,binding_source) values(%s,%s,10,'unresolved','intent')",(o['order_id'],PLAN))
    with connection('anonU','service_role') as c:result=call(c,o)
    assert result['reason_code']=='OWNER_ANONYMIZED';record('I-historical-anonymous-U',{'rpc':result,'after':rows([o['order_id']],[u])})

def kill(pid):
    assert pid in OWNED_PIDS
    actual=sql('select pid,datname,application_name from pg_stat_activity where pid=%s',(pid,)).fetchone()
    assert actual and actual[0]==pid and actual[1]==DB and actual[2].startswith(PREFIX) and pid!=control.info.backend_pid
    return {'guard':actual,'terminated':sql('select pg_terminate_backend(%s)',(pid,)).fetchone()[0]}

def crash_hooks():
    sql("create or replace function public.sunland_lab_pause(point text) returns void language plpgsql as $$ begin if current_setting('sunland.lab_point',true)=point then perform pg_sleep(30); end if; end $$")
    definition=sql("select pg_get_functiondef('sunland_process_verified_pro_order(jsonb,text,uuid,boolean)'::regprocedure)").fetchone()[0]
    definition=definition.replace('public.sunland_process_verified_pro_order(', 'public.sunland_lab_process_verified_pro_order(',1).replace('perform pg_advisory_xact_lock(hashtext(v_order_id));',"perform pg_advisory_xact_lock(hashtext(v_order_id)); perform public.sunland_lab_pause('after-lock');")
    sql(definition);sql('grant execute on function sunland_lab_process_verified_pro_order(jsonb,text,uuid,boolean) to service_role')
    sql("create or replace function sunland_lab_crash_trigger() returns trigger language plpgsql as $$ begin if TG_TABLE_NAME='user_profiles' then if NEW.pro and not OLD.pro then perform sunland_lab_pause('after-grant'); end if; elsif TG_OP='INSERT' or NEW.status='unresolved' then perform sunland_lab_pause('after-ledger-write'); elsif NEW.status='activated' and OLD.status is distinct from 'activated' then perform sunland_lab_pause('after-activated'); end if; return NEW; end $$")
    sql('drop trigger if exists sunland_lab_crash_order on pro_payment_orders');sql('drop trigger if exists sunland_lab_crash_profile on user_profiles')
    sql('create trigger sunland_lab_crash_order after insert or update on pro_payment_orders for each row execute function sunland_lab_crash_trigger()')
    sql('create trigger sunland_lab_crash_profile after update on user_profiles for each row execute function sunland_lab_crash_trigger()')
    record('lab-hook-provenance',{'candidate_sha':hashlib.sha256(definition.encode()).hexdigest(),'modification':'lab-only renamed copy; after-lock sleep, AFTER triggers for ledger/grant/activation; no candidate modification'})

def crashes():
    crash_hooks()
    points=['before-provider-query','after-provider-query','after-BEGIN-before-lock','after-lock','after-ledger-write','after-grant','after-activated','after-COMMIT-before-HTTP']
    for i,point in enumerate(points):
      user,ref=fixture('crash'+str(i));o=order('crash'+str(i),ref);c=connection('crash-'+point,'service_role',False);pid=c.info.backend_pid
      # Committed durable hint, valid provider fixture is available independently of the DB txn.
      sql('select sunland_record_pro_payment_hints(%s,%s,%s)',([o['order_id']],'webhook',TRACE));before=rows([o['order_id']],[user]);errors=[]
      c.execute("select set_config('sunland.lab_point',%s,false)",(point,));c.commit()
      def work():
       try:
        if point in ['before-provider-query','after-provider-query','after-BEGIN-before-lock']:c.execute('begin');c.execute('select pg_sleep(30)')
        else:
         call(c,o,name='sunland_lab_process_verified_pro_order');
         if point=='after-COMMIT-before-HTTP':c.commit();c.execute('select pg_sleep(30)')
       except Exception as e:errors.append(type(e).__name__)
      t=threading.Thread(target=work);t.start();deadline=time.monotonic()+5;activity=None
      while time.monotonic()<deadline:
       activity=sql('select pid,state,wait_event_type,wait_event,query from pg_stat_activity where pid=%s',(pid,)).fetchone()
       if activity and activity[3]=='PgSleep':break
       time.sleep(.02)
      assert activity and activity[3]=='PgSleep',(point,activity)
      terminated=kill(pid);t.join(5);c.close();after=rows([o['order_id']],[user])
      committed=point=='after-COMMIT-before-HTTP';assert after['profiles'][0][1]==committed
      assert (after['orders'][0][1]=='activated')==committed
      with connection('crash-recovery-'+str(i),'service_role') as recovery:r=call(recovery,o)
      final=rows([o['order_id']],[user]);assert final['orders'][0][1]=='activated' and final['profiles'][0][1] and final['intents'][0][2]=='activated'
      record('CRASH-'+str(i+1),{'point':point,'provider':'synthetic verified fixture; network-stage crash represented by stopping the lab session before RPC','before':before,'activity':activity,'termination':terminated,'after_crash':after,'recovery_rpc':r,'after_recovery':final,'exception':errors})

class CommitDropProxy:
    def __init__(self,persist):
      self.persist=persist;self.listener=socket.socket();self.listener.bind(('127.0.0.1',0));self.listener.listen(1);self.port=self.listener.getsockname()[1];self.commit_seen=False;self.drop=False;self.events=[]
      self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def run(self):
      client,_=self.listener.accept();server=socket.create_connection(('127.0.0.1',54322));
      def exact(s,n):
       b=b''
       while len(b)<n:
        chunk=s.recv(n-len(b))
        if not chunk:raise EOFError()
        b+=chunk
       return b
      def upstream():
       try:
        while True:
         header=exact(server,5);body=exact(server,struct.unpack('!I',header[1:])[0]-4)
         if self.drop:
          if header[:1]==b'Z':self.events.append('server processed COMMIT; HTTP/SQL response dropped');client.close();server.close();return
         else:client.sendall(header+body)
       except (OSError,EOFError):
        try:client.close();server.close()
        except OSError:pass
      try:
       header=exact(client,4);server.sendall(header+exact(client,struct.unpack('!I',header)[0]-4))
       threading.Thread(target=upstream,daemon=True).start()
       while True:
        header=exact(client,5);body=exact(client,struct.unpack('!I',header[1:])[0]-4)
        if header[:1]==b'Q' and body.rstrip(b'\0').strip().upper()==b'COMMIT':
         self.commit_seen=True;self.events.append('client sent COMMIT on TCP')
         if not self.persist:self.events.append('COMMIT not forwarded; upstream TCP dropped');server.close();client.close();return
         self.drop=True
        server.sendall(header+body)
      except (OSError,EOFError):pass
      finally:self.listener.close()

def commit_unknown():
    for persisted in [True,False]:
      label='persisted' if persisted else 'rolled-back';user,ref=fixture('unknown-'+label);o=order('unknown-'+label,ref);proxy=CommitDropProxy(persisted)
      c=connection('commit-unknown-'+label,'service_role',False,proxy.port,True);before=rows([o['order_id']],[user]);result=call(c,o)
      try:c.commit();raise AssertionError('expected lost COMMIT response')
      except psycopg.OperationalError:pass
      c.close();deadline=time.monotonic()+3
      while sql("select count(*) from pg_stat_activity where datname=%s and application_name=%s",(DB,PREFIX+'commit-unknown-'+label)).fetchone()[0] and time.monotonic()<deadline:time.sleep(.02)
      after=rows([o['order_id']],[user]);assert proxy.commit_seen;assert after['profiles'][0][1]==persisted
      with connection('unknown-recovery-'+label,'service_role') as r:recovered=call(r,o)
      assert recovered['already_processed']==persisted
      record('COMMIT-UNKNOWN-'+label,{'TCP_events':proxy.events,'before':before,'uncommitted_rpc':result,'authoritative_after_drop':after,'retry_rpc':recovered,'after_retry':rows([o['order_id']],[user])})

if __name__=='__main__':
    before=snapshot('destructive-start')
    try:
      acl();integration();concurrency();crashes();commit_unknown()
      after=snapshot('destructive-end');assert before['head']==after['head'];assert before['hashes']==after['hashes'],'target drift; rerun affected cases'
      print(json.dumps({'passed':len(RESULTS),'hashes_unchanged':True,'database':DB}),flush=True)
    finally:control.close()
