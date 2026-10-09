import assert from 'node:assert/strict';
import test from 'node:test';
import { HistorySync, HistoryConflict } from '../ai/history-sync.js';
const copy = value => structuredClone(value);
const record = (texts = ['M1'], title = '会话', updatedAt = 1) => ({ id: 'same', title, createdAt: 1, provider: 'deepseek', model: 'deepseek-v4-flash', updatedAt, history: texts.map(content => ({ role: 'user', content })) });
const regenRecord = () => ({...record(['M1','old']),history:[{role:'user',content:'M1'},{role:'assistant',content:'old'}]});
const storage = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key,value) }; };
function server() {
  return {
    rows: [record()], receipts: new Set(), deleted: new Set(), calls: [], loseReply: false,
    async rpc(params) {
      this.calls.push(copy(params));
      if (!this.receipts.has(params.p_operation_id)) {
        let workingRows=copy(this.rows); const workingDeleted=new Set(this.deleted);
        for (const item of params.p_upserts) {
          const current = workingRows.find(row => String(row.id) === String(item.record.id)) || null;
          if (!assertionEqual(current,item.expected_record) || workingDeleted.has(String(item.record.id))) return { error: { code:'PT409', details: JSON.stringify({conversation_id:String(item.record.id)}) } };
          workingRows = workingRows.filter(row => String(row.id) !== String(item.record.id)); workingRows.push(copy(item.record));
        }
        for (const item of params.p_deletes) {
          const current = workingRows.find(row => String(row.id) === item.id) || null;
          if (!assertionEqual(current,item.expected_record)) return { error: { code:'PT409', details: JSON.stringify({conversation_id:item.id}) } };
          workingRows = workingRows.filter(row => String(row.id) !== item.id); workingDeleted.add(item.id);
        }
        this.rows=workingRows; this.deleted=workingDeleted;
        this.receipts.add(params.p_operation_id);
      }
      if (this.loseReply) { this.loseReply = false; throw new Error('reply lost after commit'); }
      return { data:copy(this.rows) };
    },
  };
}
function assertionEqual(a,b) { try { assert.deepEqual(a,b); return true; } catch { return false; } }
function device(remote, localStorage = storage(), isCurrent = () => true) {
  const sync = new HistorySync({ userId:'user',storage:localStorage,rpc:params=>remote.rpc(params),isCurrent });
  sync.reconcile([],copy(remote.rows)); return sync;
}

test('two independent devices conflict explicitly and preserve the losing local branch on refresh', async () => {
  const remote=server(), a=device(remote), b=device(remote);
  const results=await Promise.allSettled([a.save(()=>[record(['M1','A1'])]),b.save(()=>[record(['M1','B1'],'会话',100)])]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.ok(results.find(result=>result.status==='rejected').reason instanceof HistoryConflict);
  const kept=b.reconcile([record(['M1','B1'],'会话',100)],remote.rows);
  assert.equal(kept[0].history.at(-1).content,'B1');
  assert.equal(remote.rows[0].history.at(-1).content,'A1');
  await assert.rejects(b.save(()=>kept),HistoryConflict);
});
test('stale rename cannot use a newly downloaded base, even with a newer client clock', async () => {
  const remote=server(), sync=device(remote);
  remote.rows=[record(['M1'],'远端名称',10)];
  const local=sync.reconcile([record(['M1'],'本机名称',20)],remote.rows);
  await assert.rejects(sync.save(()=>local),HistoryConflict);
  assert.equal(remote.rows[0].title,'远端名称'); assert.equal(local[0].title,'本机名称');
});
test('unknown initial local branch conflicts without acquiring the current remote version', async () => {
  const remote=server(); remote.rows=[record(['M1','A1'])];
  const sync=new HistorySync({userId:'user',storage:storage(),rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const kept=sync.reconcile([record(['M1','B1'])],remote.rows);
  await assert.rejects(sync.save(()=>kept),HistoryConflict); assert.equal(remote.calls.length,0);
});
test('offline append with a persisted base and duplicate save do not repeat delivery', async () => {
  const remote=server(),tab=storage(); device(remote,tab);
  const sync=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const local=sync.reconcile([record(['M1','offline'])],remote.rows);
  await sync.save(()=>local); await sync.save(()=>local);
  assert.equal(remote.calls.length,1); assert.equal(remote.rows[0].history.length,2);
});
test('lost response survives reload of this tab and retries exactly the same operation', async () => {
  const remote=server(),tab=storage(),sync=device(remote,tab); remote.loseReply=true;
  const local=[record(['M1','A1'])]; await assert.rejects(sync.save(()=>local));
  const restarted=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  await restarted.save(()=>local);
  assert.equal(remote.calls.length,2); assert.deepEqual(remote.calls[0],remote.calls[1]);
  assert.equal(remote.rows[0].history.length,2);
});
test('receipt replay with newer server data cannot authorize a later stale edit', async () => {
  const remote=server(),tab=storage(),sync=device(remote,tab); remote.loseReply=true;
  await assert.rejects(sync.save(()=>[record(['M1','A1'])]));
  remote.rows=[record(['M1','A1','B1'],'远端名称',10)];
  const restarted=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  await assert.rejects(restarted.save(()=>[record(['M1','A1','A2'])]),HistoryConflict);
  assert.equal(remote.rows[0].history.at(-1).content,'B1'); assert.equal(remote.rows[0].title,'远端名称');
});
test('out-of-order cloud read cannot roll back an acknowledged write', async () => {
  const remote=server(),sync=device(remote),old=copy(remote.rows),revision=sync.revision;
  const local=[record(['M1','A1'])]; await sync.save(()=>local);
  assert.equal(sync.reconcile(local,old,[],revision)[0].history.at(-1).content,'A1');
});
test('delete conflicts before Core cleanup and tombstones retain unsynced local content', async () => {
  const remote=server(),sync=device(remote); remote.rows=[record(['M1','A1'])];
  await assert.rejects(sync.delete('same',true),HistoryConflict);
  assert.deepEqual(sync.state.contextDeletes,[]); assert.equal(remote.rows.length,1);
  const kept=sync.reconcile([record(['M1','offline'])],[],['same']);
  assert.equal(kept[0].history.at(-1).content,'offline');
});
test('unknown delete reply resumes by receipt, removes own stale cache and schedules cleanup once', async () => {
  const remote=server(),tab=storage(),sync=device(remote,tab); remote.loseReply=true;
  await assert.rejects(sync.delete('same',true));
  const restarted=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  await restarted.save(()=>[record()]);
  assert.deepEqual(restarted.reconcile([record()],[],['same']),[]);
  assert.deepEqual(restarted.state.contextDeletes,['same']); assert.equal(remote.rows.length,0);
});
test('bases retain numeric IDs and unknown fields; different tabs do not share edit bases', async () => {
  const remote=server(); remote.rows=[{...record(),id:123,unknown:{nested:42}}];
  const tabA=storage(),tabB=storage();
  const sync=new HistorySync({userId:'user',storage:tabA,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const local=sync.reconcile([],remote.rows); const original=copy(remote.rows[0]);
  local[0].history.push({role:'assistant',content:'A1'}); await sync.save(()=>local);
  assert.deepEqual(remote.calls[0].p_upserts[0].expected_record,original);
  assert.equal(tabB.getItem(sync.key),undefined);
});
test('a late response after account invalidation cannot rewrite cleared tab state', async () => {
  const remote=server(),tab=storage(); let current=true,resolve;
  const gate=new Promise(r=>resolve=r);
  const sync=new HistorySync({userId:'user',storage:tab,rpc:()=>gate,isCurrent:()=>current}); sync.reconcile([],remote.rows);
  const pending=sync.save(()=>[record(['M1','new'])]); await new Promise(r=>setImmediate(r));
  const previous=tab.getItem(sync.key); current=false; resolve({data:[record(['M1','new'])]}); await pending;
  assert.equal(tab.getItem(sync.key),previous); assert.ok(sync.state.pending);
});

test('a started provider cannot be replaced by cloud data, while safe records keep their sealed provider', async () => {
  const remote=server(),sync=device(remote);
  const kept=sync.reconcile([record()],[{...record(),provider:'sunland',model:'frost',userId:'user'}]);
  assert.equal(kept[0].provider,'deepseek'); assert.ok(sync.state.blocked.includes('same'));
  const fresh=new HistorySync({userId:'user',storage:storage(),rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const loaded=fresh.reconcile([],remote.rows);
  assert.throws(()=>{loaded[0].provider='sunland'},TypeError);
});
test('raw bases survive legacy/provider projection and are not rebuilt from normalized UI data', async () => {
  const remote=server(); const raw=record(); delete raw.provider; delete raw.model;
  raw.semanticContext={unknown:'preserve'}; remote.rows=[raw];
  const sync=new HistorySync({userId:'user',storage:storage(),rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const local=sync.reconcile([],remote.rows); const original=copy(remote.rows[0]);
  local[0].history.push({role:'assistant',content:'A1'}); await sync.save(()=>local);
  assert.deepEqual(remote.calls[0].p_upserts[0].expected_record,original);
});
test('a conflicted branch does not prevent copying content into an independent new chat', async () => {
  const remote=server(),sync=device(remote); remote.rows=[record(['M1','remote'])];
  const branch=record(['M1','offline']); await assert.rejects(sync.save(()=>[branch]),HistoryConflict);
  const fresh={...record(['offline']),id:'fresh'};
  await assert.rejects(sync.save(()=>[branch,fresh]),HistoryConflict);
  assert.equal(remote.rows.find(row=>row.id==='fresh').history[0].content,'offline');
});

test('identical old cache without a trustworthy base conflicts explicitly', async () => {
  const remote=server();
  const sync=new HistorySync({userId:'user',storage:storage(),rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const kept=sync.reconcile([record()],remote.rows);
  assert.equal(kept[0].history[0].content,'M1');
  await assert.rejects(sync.save(()=>kept),HistoryConflict);
  assert.equal(remote.calls.length,0);
});
test('reload resumes a lost delete receipt without another save', async () => {
  const remote=server(),tab=storage(),sync=device(remote,tab); remote.loseReply=true;
  await assert.rejects(sync.delete('same',true));
  const restarted=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  await restarted.enqueue(()=>restarted.deliver());
  await restarted.enqueue(()=>restarted.deliver());
  assert.equal(remote.calls.length,2); assert.deepEqual(remote.calls[0],remote.calls[1]);
  assert.deepEqual(restarted.reconcile([record()],[],['same']),[]);
  assert.deepEqual(restarted.state.contextDeletes,['same']);
});

test('a single stale record in an atomic batch cannot permanently block an independent chat', async () => {
  const remote=server(),sync=device(remote); remote.rows=[record(['M1','remote'])];
  const branch=record(['M1','offline']),fresh={...record(['fresh']),id:'fresh'};
  await assert.rejects(sync.save(()=>[fresh,branch]),HistoryConflict);
  assert.equal(remote.rows.some(row=>row.id==='fresh'),false);
  await assert.rejects(sync.save(()=>[branch,fresh]),HistoryConflict);
  assert.equal(remote.rows.find(row=>row.id==='fresh').history[0].content,'fresh');
  assert.equal(remote.rows.find(row=>row.id==='same').history.at(-1).content,'remote');
});
test('missing, malformed or foreign conflict details never upgrade the original edit base', async () => {
  for(const details of [undefined,'not-json','{}','{"conversation_id":"foreign"}','{"conversation_id":42}']) {
    const remote=server();let calls=0;
    const sync=new HistorySync({userId:'user',storage:storage(),isCurrent:()=>true,rpc:async()=>{calls++;return {error:{code:'PT409',details}};}});
    sync.reconcile([],remote.rows);
    const before=copy(sync.state.bases),branch=record(['M1','offline']),fresh={...record(['fresh']),id:'fresh'};
    await assert.rejects(sync.save(()=>[branch,fresh]),HistoryConflict);
    await assert.rejects(sync.save(()=>[fresh]),HistoryConflict);
    assert.equal(calls,1);assert.deepEqual(sync.state.bases,before);assert.equal(branch.history.at(-1).content,'offline');
  }
});
test('regeneration intent keeps the original answer and fixed request ID across a lost worker response',async()=>{
  const remote=server(),tab=storage(),sync=device(remote,tab),original=regenRecord();
  remote.rows=[copy(original)];sync.reconcile([],remote.rows);
  const intent=sync.beginRegeneration(original);
  sync.checkpointRegeneration('same','partial before refresh');
  const refreshed=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  assert.equal(refreshed.state.regenerations.same.draft,'partial before refresh');
  assert.equal(refreshed.state.regenerations.same.requestId,intent.requestId);
  sync.markRegenerationUnknown('same','partial');
  const resumed=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  assert.equal(resumed.state.regenerations.same.requestId,intent.requestId);
  assert.equal(resumed.state.regenerations.same.original.history.at(-1).content,'old');
  await resumed.save(()=>[original]);assert.equal(remote.calls.length,0);
  assert.throws(()=>resumed.beginRegeneration(original),HistoryConflict);
});
test('ready regen survives crash and receipt retry without adding a second user message',async()=>{
  const remote=server(),tab=storage(),sync=device(remote,tab),original=regenRecord();
  remote.rows=[copy(original)];sync.reconcile([],remote.rows);
  sync.beginRegeneration(original);
  const next=sync.completeRegeneration(original,{role:'assistant',content:'new'});
  remote.loseReply=true;
  await assert.rejects(sync.save(()=>[next]));
  const resumed=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  await resumed.save(()=>[next]);
  assert.deepEqual(remote.calls[0],remote.calls[1]);assert.equal(remote.calls[0].p_upserts[0].mode,'replace');
  assert.equal(remote.rows[0].history.length,2);assert.equal(remote.rows[0].history.at(-1).content,'new');
});
test('crash between ready intent and snapshot cannot upgrade CAS to another devices new answer',async()=>{
  const remote=server(),tab=storage(),sync=device(remote,tab),original=regenRecord();
  remote.rows=[copy(original)];sync.reconcile([],remote.rows);
  sync.beginRegeneration(original);sync.completeRegeneration(original,{role:'assistant',content:'A1'});
  remote.rows=[record(['M1','B1'])];
  const resumed=new HistorySync({userId:'user',storage:tab,rpc:p=>remote.rpc(p),isCurrent:()=>true});
  const kept=resumed.reconcile([original],remote.rows);
  await assert.rejects(resumed.save(()=>kept),HistoryConflict);
  assert.equal(remote.calls.length,0);assert.equal(remote.rows[0].history.at(-1).content,'B1');
  assert.equal(kept[0].history.at(-1).content,'A1');
  assert.deepEqual(resumed.state.regenerations.same.expected,original);
});
test('persistence failure prevents regen from mutating an original or sending a request',()=>{
  const remote=server(),tab=storage(),sync=device(remote,tab),original=regenRecord();
  sync.reconcile([], [original]);tab.setItem=()=>{throw new Error('full')};
  assert.throws(()=>sync.beginRegeneration(original),/full/);
  assert.equal(original.history.at(-1).content,'old');assert.equal(remote.calls.length,0);
});
