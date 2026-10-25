#!/usr/bin/env python3
"""Frozen Phase 5 SQL preparation; no credentials or general-purpose SQL input."""
import hashlib,json,pathlib,re,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS=[('20261021010000','atomic_email_otp',pathlib.Path('/Users/liuxize/sunland_ai_app/supabase/migrations/20261021010000_atomic_email_otp.sql'),'21ed65f1ba19e41a8940a2495fb479b874cb2bbbabd868c84654751d3f36e15c'),('20261024003756','phone_identity',ROOT/'supabase/migrations/20261024003756_phone_identity.sql','0022b4274f19dc61de8b53c2023aa0e5f1668aeb6f69868131063983cafce835')]
TABLES=['auth.identities','auth.users','public.account_deletion_jobs','public.activation_codes','public.chat_messages','public.chat_threads','public.conversations','public.email_codes','public.oc_profiles','public.orders','public.profiles','public.request_logs','public.thanks','public.thanks_likes','public.usage','public.usage_logs','public.user_profiles','storage.buckets','storage.objects']
def quote(s):return "'"+s.replace("'","''")+"'"
def fingerprint():
    return 'jsonb_build_object('+','.join(quote(t)+f",(SELECT jsonb_build_object('rows',count(*),'digest',md5(coalesce(string_agg(md5(to_jsonb(x)::text),'' ORDER BY md5(to_jsonb(x)::text)),''))) FROM {t} x)" for t in TABLES)+')'
def body(source):
    if len(re.findall(r'^begin;$',source,re.M))!=1 or not re.search(r'\ncommit;\s*$',source):raise ValueError('Unexpected transaction boundary')
    return re.sub(r'^begin;\n','',re.sub(r'\ncommit;\s*$','\n',source),count=1,flags=re.M)
def assertions(phone):
    tables=['sunland_phone_identities','sunland_phone_auth_state','sunland_phone_auth_grants','sunland_phone_auth_operations','sunland_phone_auth_config'] if phone else ['sunland_otp_challenges','sunland_otp_limits']
    funcs=['sunland_phone_identity(text,jsonb)','sunland_phone_identity_lifecycle()'] if phone else ['sunland_otp(text,text,text,uuid,text,text)','sunland_otp_budget(text,integer,integer)','sunland_otp_cleanup()']
    out=[]
    for table in tables:
        out.append(f"IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.{table}'::regclass) THEN RAISE EXCEPTION 'RLS check failed'; END IF;")
        for role in ['anon','authenticated','service_role']:
            for priv in ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']:
                allowed=phone and role=='service_role' and (priv=='SELECT' if table.endswith('auth_config') else priv in ['SELECT','INSERT','UPDATE','DELETE'])
                out.append(f"IF has_table_privilege('{role}','public.{table}','{priv}') IS DISTINCT FROM {'true' if allowed else 'false'} THEN RAISE EXCEPTION 'Table ACL check failed: {table}/{role}/{priv}'; END IF;")
    for fn in funcs:
        out.append(f"IF NOT EXISTS(SELECT FROM pg_proc WHERE oid='public.{fn}'::regprocedure AND proowner='postgres'::regrole AND prosecdef={'false' if phone else 'true'}) THEN RAISE EXCEPTION 'Function owner/security check failed'; END IF;")
        if not phone:out.append(f"IF (SELECT proconfig @> ARRAY['search_path=\"\"'] FROM pg_proc WHERE oid='public.{fn}'::regprocedure) IS DISTINCT FROM true THEN RAISE EXCEPTION 'OTP search_path check failed'; END IF;")
        for role in ['anon','authenticated','service_role']:
            allow=role=='service_role' and not fn.startswith('sunland_otp_budget')
            out.append(f"IF has_function_privilege('{role}','public.{fn}','EXECUTE') IS DISTINCT FROM {'true' if allow else 'false'} THEN RAISE EXCEPTION 'Function ACL check failed'; END IF;")
    if phone:
        out.append("IF (SELECT count(*) FROM public.sunland_phone_auth_config WHERE singleton AND lookup_key_id IS NULL AND lookup_check IS NULL)<>1 THEN RAISE EXCEPTION 'Canary must remain uninitialized'; END IF;")
        out.extend(f"IF EXISTS(SELECT FROM public.{t}) THEN RAISE EXCEPTION 'Unexpected new phone business rows'; END IF;" for t in tables[:-1])
        out.append("IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.user_profiles'::regclass AND tgname='sunland_phone_identity_lifecycle' AND tgfoid='public.sunland_phone_identity_lifecycle()'::regprocedure AND tgenabled='O' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Phone lifecycle trigger missing'; END IF;")
    else:
        out.append("IF (SELECT pronargdefaults FROM pg_proc WHERE oid='public.sunland_otp(text,text,text,uuid,text,text)'::regprocedure)<>3 THEN RAISE EXCEPTION 'OTP signature defaults mismatch'; END IF;")
        out.append("IF to_regclass('public.sunland_otp_challenges_expiry') IS NULL OR to_regclass('public.sunland_otp_limits_expiry') IS NULL THEN RAISE EXCEPTION 'OTP indexes missing'; END IF;")
    return '\n'.join(out)
def transaction(index):
    version,name,path,sha=MIGRATIONS[index];raw=path.read_bytes();source=raw.decode()
    if hashlib.sha256(raw).hexdigest()!=sha:raise ValueError('Frozen migration changed')
    prefix='sunland_phone' if index else 'sunland_otp'
    guard=f"IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='{version}' OR name={quote(name)}) OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE '{prefix}%') OR EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE '{prefix}%') THEN RAISE EXCEPTION 'Migration/object collision'; END IF;"
    if index:guard+="\nIF EXISTS(SELECT FROM pg_trigger WHERE tgrelid='public.user_profiles'::regclass AND tgname='sunland_phone_identity_lifecycle') THEN RAISE EXCEPTION 'Trigger collision'; END IF;"
    return f"""DO $phase5$
DECLARE before_data jsonb; after_data jsonb;
BEGIN
{guard}
SELECT {fingerprint()} INTO before_data;
EXECUTE {quote(body(source))};
{assertions(bool(index))}
SELECT {fingerprint()} INTO after_data;
IF before_data IS DISTINCT FROM after_data THEN RAISE EXCEPTION 'Existing business data changed'; END IF;
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES('{version}',{quote(name)},ARRAY[{quote(source)}]);
PERFORM pg_notify('pgrst','reload schema');
END $phase5$;
"""
def main():
    target=pathlib.Path(sys.argv[1]);target.mkdir(mode=0o700,exist_ok=False)
    manifest=[]
    for i,(version,name,path,sha) in enumerate(MIGRATIONS):
        sql="BEGIN ISOLATION LEVEL REPEATABLE READ;\nSET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s';\nSELECT pg_advisory_xact_lock(20261025,5);\n"+transaction(i)+f"COMMIT;\nSELECT json_build_object('applied_version','{version}','name','{name}','verified_at',clock_timestamp(),'existing_business_fingerprints_match',true);\n"
        (target/f'{version}.sql').write_text(sql);(target/f'{version}.sql').chmod(0o600)
        manifest.append({'version':version,'name':name,'source_sha256':sha,'execution_sql_sha256':hashlib.sha256(sql.encode()).hexdigest()})
    # The local rehearsal uses the exact same guarded/verified DDL bodies, then rolls back.
    local='BEGIN ISOLATION LEVEL REPEATABLE READ;\n'+transaction(0)+"\nSAVEPOINT otp_fixture;\nSET LOCAL ROLE service_role;\nDO $test$ DECLARE r jsonb; BEGIN\n"
    local+="r:=public.sunland_otp('reserve',repeat('a',64),repeat('b',64),'00000000-0000-4000-8000-000000000505',repeat('c',64),NULL);IF r->>'code'<>'OK' THEN RAISE EXCEPTION 'Local OTP reserve failed';END IF;\n"
    local+="r:=public.sunland_otp('delivery',repeat('a',64),repeat('b',64),'00000000-0000-4000-8000-000000000505',NULL,'delivered');\n"
    local+="r:=public.sunland_otp('consume',repeat('a',64),repeat('b',64),'00000000-0000-4000-8000-000000000505',repeat('c',64),NULL);IF r->>'code'<>'OK' THEN RAISE EXCEPTION 'Local OTP consume failed';END IF;\n"
    local+="r:=public.sunland_otp('consume',repeat('a',64),repeat('b',64),'00000000-0000-4000-8000-000000000505',repeat('c',64),NULL);IF r->>'code'<>'INVALID' THEN RAISE EXCEPTION 'Local OTP replay rejection failed';END IF;END $test$;RESET ROLE;ROLLBACK TO SAVEPOINT otp_fixture;\n"
    local+=transaction(1)+"\nROLLBACK;\nSELECT '{\"phase5_local_rehearsal_passed\":true,\"existing_business_fingerprints_match\":true,\"otp_reserve_consume_replay\":true}'::json;\n"
    (target/'rehearsal.sql').write_text(local);(target/'rehearsal.sql').chmod(0o600)
    (target/'migration-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Prepared only two frozen migrations with collision, effective ACL and business-data checks')
if __name__=='__main__':main()
