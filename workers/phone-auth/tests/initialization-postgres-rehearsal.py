import subprocess, time, uuid
name='phone-pg-isolated-'+uuid.uuid4().hex[:10]
image='public.ecr.aws/docker/library/postgres:16-alpine'

def run(args, data=None, timeout=15):
 return subprocess.run(args,input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=timeout).stdout.strip()
def psql(sql, app='control'):
 return run(['docker','exec','-i','-e','PGAPPNAME='+app,name,'psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],sql+'\n;\n')
def proc(sql,app):
 p=subprocess.Popen(['docker','exec','-i','-e','PGAPPNAME='+app,name,'psql','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 p.stdin.write(sql); p.stdin.close();return p
def finish(p):
 p.wait(timeout=15); out=p.stdout.read().strip(); err=p.stderr.read().strip(); assert p.returncode==0,err; return out
def wait(query):
 for _ in range(100):
  if psql(query)=='1':return
  time.sleep(.05)
 raise AssertionError('lock state not observed')
def wait_block(app):
 wait("select count(*) from pg_stat_activity where application_name='"+app+"' and wait_event_type='Lock';")
tables=['sunland_phone_identities','sunland_phone_auth_state','sunland_phone_auth_grants','sunland_phone_auth_operations']
lock='lock table '+','.join(tables)+' in share row exclusive mode;'
update="update sunland_phone_auth_config set lookup_key_id='v1',lookup_check=repeat('a',64) where singleton=true and lookup_key_id is null and lookup_check is null "+''.join('and not exists (select 1 from '+t+') ' for t in tables)+'returning 1;'
init='begin; select pg_advisory_xact_lock(20261024,2); '+lock+update+' commit;'
try:
 run(['docker','run','-d','--rm','--name',name,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,size=256m','-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'postgres','-c','fsync=off'],timeout=30)
 for _ in range(200):
  try:
   if psql('select 1')=='1': break
  except Exception: time.sleep(.1)
 else:raise RuntimeError('database startup failed')
 psql('create table sunland_phone_auth_config(singleton boolean primary key check(singleton),lookup_key_id text,lookup_check text); insert into sunland_phone_auth_config values(true,null,null); '+''.join('create table '+t+'(id text primary key);' for t in tables))
 # Two initializers must serialize on the actual advisory lock, second must update zero rows.
 first=proc('begin; select pg_advisory_xact_lock(20261024,2); '+lock+'select pg_sleep(1.5); '+update+' commit;','first_init')
 wait("select count(*) from pg_stat_activity where application_name='first_init' and wait_event='PgSleep';")
 second=proc(init,'second_init');wait_block('second_init'); assert finish(first).endswith('1');assert finish(second)=='';assert psql('select count(*) from sunland_phone_auth_config where lookup_key_id=\'v1\'')=='1'
 print('PASS concurrent initializers serialize; exactly one initializes')
 for table in tables:
  psql('update sunland_phone_auth_config set lookup_key_id=null,lookup_check=null; '+''.join('delete from '+t+';' for t in tables))
  writer=proc('begin; insert into '+table+" values('synthetic'); select pg_sleep(1.5); commit;",'writer')
  wait("select count(*) from pg_stat_activity where application_name='writer' and wait_event='PgSleep';")
  initializer=proc(init,'waiting_init');wait_block('waiting_init');finish(writer);assert finish(initializer)=='';assert psql('select count(*) from sunland_phone_auth_config where lookup_key_id is null and lookup_check is null')=='1'
  print('PASS committed in-flight '+table+' write blocks initialization and is observed')
  psql('delete from '+table+';')
  first=proc('begin; select pg_advisory_xact_lock(20261024,2); '+lock+'select pg_sleep(1.5); '+update+' commit;','locking_init')
  wait("select count(*) from pg_stat_activity where application_name='locking_init' and wait_event='PgSleep';")
  writer=proc('insert into '+table+" values('synthetic');",'waiting_writer');wait_block('waiting_writer');assert finish(first).endswith('1');finish(writer)
  print('PASS '+table+' write waits for initializer commit')
 print('POSTGRESQL',psql('show server_version'), 'NETWORK none; STORAGE ephemeral; DATA synthetic')
finally:
 subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
