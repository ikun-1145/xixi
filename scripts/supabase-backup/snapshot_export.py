#!/usr/bin/env python3
"""Keep one READ ONLY snapshot alive for pg_dump, business catalog and counts."""
import datetime,json,os,pathlib,re,select,signal,subprocess,sys
HERE=pathlib.Path(__file__).resolve().parent

def import_snapshot(sql,snapshot):
    if not re.fullmatch(r'[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+',snapshot):raise ValueError('Invalid snapshot identifier')
    if sql.count('BEGIN TRANSACTION READ ONLY;')!=1:raise ValueError('Expected exactly one read-only transaction')
    return sql.replace('BEGIN TRANSACTION READ ONLY;',f"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT '{snapshot}';")

def command(tool,*args):
    return ['bash','-c','source "$1/common.sh";shift;production_tool "$@"','sunland-backup',str(HERE),tool,*args]

def main():
    dest=pathlib.Path(sys.argv[1]);key=sys.argv[2];work=dest/'.work'
    def sql_file(sql,path):
        with path.open('xb') as out:
            subprocess.run(command('psql','-X','-qAt','-v','ON_ERROR_STOP=1'),input=sql.encode(),stdout=out,check=True)
    started=datetime.datetime.now(datetime.timezone.utc).isoformat()
    keeper=subprocess.Popen(command('psql','-X','-qAt','-v','ON_ERROR_STOP=1'),stdin=subprocess.PIPE,stdout=subprocess.PIPE,start_new_session=True)
    try:
        keeper.stdin.write(b'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n');keeper.stdin.flush()
        if not select.select([keeper.stdout],[],[],40)[0]:raise RuntimeError('Snapshot export timed out')
        snapshot=keeper.stdout.readline().decode().strip()
        catalog=import_snapshot((HERE/'inventory.sql').read_text(),snapshot)
        sql_file(catalog,dest/'source-inventory.json')
        subprocess.run(['python3',str(HERE/'row_counts.py'),str(dest/'source-inventory.json'),str(work/'counts.sql')],check=True)
        sql_file(import_snapshot((work/'counts.sql').read_text(),snapshot),dest/'source-row-counts.json')
        sql_file(import_snapshot("BEGIN TRANSACTION READ ONLY;\nSELECT json_build_object('verification_transaction_started_at',now(),'pooler_backend_tls',(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),'readonly',current_setting('transaction_read_only'));\nCOMMIT;",snapshot),dest/'snapshot-evidence.json')
        print('Read-only shared snapshot established; exporting encrypted database...',flush=True)
        encoder=subprocess.Popen(['node',str(HERE/'aead-file.mjs'),'encrypt',key,str(dest/'database.dump.aesgcm')],stdin=subprocess.PIPE)
        try:
            result=subprocess.run(command('pg_dump','--format=custom','--quote-all-identifiers','--snapshot='+snapshot),stdout=encoder.stdin)
            encoder.stdin.close();code=encoder.wait()
            if result.returncode or code:raise RuntimeError('Database export or encryption failed')
        finally:
            if encoder.poll() is None:encoder.kill();encoder.wait()
        keeper.stdin.write(b'ROLLBACK;\n');keeper.stdin.close()
        if keeper.wait(timeout=20):raise RuntimeError('Snapshot holder failed')
        evidence=json.load(open(dest/'snapshot-evidence.json'))
        evidence.update(client_sslmode='verify-full',snapshot_id=snapshot,started_at=started,ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='pg_dump + business catalog + exact table counts share imported PostgreSQL snapshot; roles/Storage are separate')
        (dest/'snapshot-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
    finally:
        if keeper.poll() is None:
            os.killpg(keeper.pid,signal.SIGTERM)
            try:keeper.wait(timeout=10)
            except subprocess.TimeoutExpired:os.killpg(keeper.pid,signal.SIGKILL);keeper.wait()
    print('Shared snapshot database export completed',flush=True)
if __name__=='__main__':main()
