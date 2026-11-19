#!/bin/zsh
# Isolated throwaway PostgreSQL; no network, container removed on exit.
set -eu
D=${0:A:h}; R=${0:A:h}/../../..; M=$R/supabase/migrations
C=sunland-phone-only-pgtest-$$
docker run -d --rm --name $C --network none -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
trap 'docker rm -f $C >/dev/null 2>&1 || true' EXIT
until docker exec $C pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; do sleep 0.5; done
P() { docker exec -i $C psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
SCHEMA=$(python3 -c "import re,sys;print(re.search(r\"conn\.execute\('''(create table public\.user_profiles[\s\S]*?)'''\)\",open(sys.argv[1]).read()).group(1))" $R/workers/phone-auth/tests/initialization-full-postgres.py)
P -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema extensions; create function extensions.gen_random_uuid() returns uuid language sql volatile as \$\$ select pg_catalog.gen_random_uuid() \$\$;
  grant usage on schema public to anon, authenticated, service_role;" >/dev/null
print -r -- "$SCHEMA;" | P >/dev/null
P -c "create unique index user_profiles_email_unique_idx on public.user_profiles(lower(email)) where email is not null and identity_status is distinct from 'retired';" >/dev/null
P < $R/workers/phone-auth/tests/fixtures/phone-identity-reviewed.sql >/dev/null
P < $M/20261115003339_phone_registration_verified_email.sql >/dev/null
# The reviewed fixtures must still match the production catalog (md5 of prosrc,
# captured read-only on 2026-11-19) before this test means anything.
P -At -c "select string_agg(proname||'='||md5(prosrc),' ' order by proname) from pg_proc where pronamespace='public'::regnamespace
  and proname in ('sunland_phone_identity','sunland_phone_identity_lifecycle','sunland_phone_register','sunland_phone_require_email')" |
  grep -qx 'sunland_phone_identity=892b79b851ca1d06dcd4d7da064ef119 sunland_phone_identity_lifecycle=2673cddbf76b53348beedff9422730a3 sunland_phone_register=80862c4acb20b8dedea339646b640ffd sunland_phone_require_email=ec5abdc3a60f41294ea9bd7d7e2e678e' ||
  { echo 'FAIL: fixture drifted from production catalog'; exit 1; }
echo 'PASS: fixture matches production function bodies'
P -c "grant select,insert,update,delete on all tables in schema public to service_role;
  update public.sunland_phone_auth_config set lookup_key_id='v1', lookup_check=repeat('c',64);" >/dev/null
P < $M/20261119200000_phone_only_registration.sql >/dev/null
# Migration must be re-runnable.
P < $M/20261119200000_phone_only_registration.sql >/dev/null
P < $D/10_cases.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
# Concurrency: hold the phone lock so calls queue, then release together.
call() { # op candidate phone
  P -At -c "set role service_role; select r->>'code'||':'||coalesce(r->>'user_id','') from (select public.sunland_phone_register_phone_only(jsonb_build_object(
    'operation_id','$1','candidate_id','$2','request_hash',encode(sha256(convert_to('$1','UTF8')),'hex'),
    'phone_hash',encode(sha256(convert_to('$3','UTF8')),'hex'),'encrypted_phone','ciphertext','last4','0000',
    'lookup_key_id','v1','lookup_check',repeat('c',64))) r) x" ; }
T=$(mktemp -d)
( P -c "begin; select pg_advisory_xact_lock(20261024,2); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.5
call 99999999-0000-4000-8000-000000000001 e0000000-0000-4000-8000-000000000001 race > $T/r1 &
call 99999999-0000-4000-8000-000000000001 e0000000-0000-4000-8000-000000000002 race > $T/r2 &
call 99999999-0000-4000-8000-000000000003 e0000000-0000-4000-8000-000000000003 race > $T/r3 &
wait
r1=$(cat $T/r1) r2=$(cat $T/r2) r3=$(cat $T/r3); rm -rf $T
[[ $r1 == $r2 && $r1 == $r3 && $r1 == OK:e0000000-0000-4000-8000-00000000000[123] ]] &&
  echo "PASS: concurrent same/different operation converge on one account ($r1 | $r3)" || echo "FAIL: concurrency $r1 $r2 $r3"
P -At -c "select case when count(*)=1 then 'PASS' else 'FAIL' end||': one identity for raced phone' from public.sunland_phone_identities where phone_hash=encode(sha256(convert_to('race','UTF8')),'hex')"
