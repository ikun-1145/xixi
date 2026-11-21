#!/bin/zsh
# Isolated throwaway PostgreSQL; no network exposure, container removed on exit.
set -eu
D=${0:A:h}; M=${0:A:h}/../../migrations; R=${TMPDIR:-/tmp}
C=sunland-unified-pgtest
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --rm --name $C -e POSTGRES_PASSWORD=x postgres:17 >/dev/null
trap 'docker rm -f $C >/dev/null 2>&1 || true' EXIT
until docker exec $C pg_isready -U postgres -q 2>/dev/null; do sleep 0.5; done
sleep 1
P() { docker exec -i $C psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
P -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role; alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;" >/dev/null
P < $D/00_fixture.sql >/dev/null
P -c "grant select,insert,update,delete on all tables in schema public to service_role;" >/dev/null
P < $M/20261115003339_phone_registration_verified_email.sql >/dev/null
P < $M/20261119125119_phone_unified_verified_registration.sql >/dev/null
# Migration must be re-runnable.
P < $M/20261119125119_phone_unified_verified_registration.sql >/dev/null
P < $D/10_cases.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
# Concurrency: hold the phone lock so three calls queue, then release together.
P -c "set role service_role; select public.sunland_otp('reserve',encode(sha256('sc'::bytea),'hex'),encode(sha256('ip'::bytea),'hex'),'cccccccc-cccc-4ccc-8ccc-cccccccccccc',encode(sha256('123456'::bytea),'hex'))" >/dev/null
call() { # op candidate phone email
  P -At -c "set role service_role; select public.sunland_phone_register_unified(jsonb_build_object('operation_id','$1','candidate_id','$2',
    'request_hash',encode(sha256(convert_to('$1'||'$4','UTF8')),'hex'),'phone_hash',encode(sha256(convert_to('$3','UTF8')),'hex'),
    'encrypted_phone','ciphertext','last4','0000','email','$4','lookup_key_id','v1','lookup_check',repeat('c',64)),
    encode(sha256('sc'::bytea),'hex'),encode(sha256('ip'::bytea),'hex'),
    (select request_id from public.sunland_otp_challenges where subject=encode(sha256('sc'::bytea),'hex')),encode(sha256('123456'::bytea),'hex'))->>'code'" ; }
( P -c "begin; select pg_advisory_xact_lock(20261024,2); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.5
call dddddddd-0000-4000-8000-000000000001 e0000000-0000-4000-8000-000000000001 pc race@example.test > $R/pgtest-r1 &
call dddddddd-0000-4000-8000-000000000001 e0000000-0000-4000-8000-000000000002 pc race@example.test > $R/pgtest-r2 &
call dddddddd-0000-4000-8000-000000000003 e0000000-0000-4000-8000-000000000003 pc2 race@example.test > $R/pgtest-r3 &
wait
echo "concurrent same-op: $(cat $R/pgtest-r1) $(cat $R/pgtest-r2); different-op same email/code: $(cat $R/pgtest-r3)"
P -At -c "select 'accounts for race@example.test: '||count(*) from public.user_profiles where email='race@example.test'"
