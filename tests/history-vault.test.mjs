import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {HistoryVault,exportHistory,decodeHistory,vaultPrefix,recoveredAttachments} from '../ai/history-vault.js';
import {buildVisionMessages} from '../ai/multimodal.js';
import {stageHistoryRecovery,readHistoryBranches} from '../ai/history-controls.js';
const record = text => ({id:'same',userId:'a',provider:'deepseek',title:'原始',history:[
  {id:'m1',role:'user',content:' M1 🧊 ',unknown:{x:1}},
  {id:'m2',role:'assistant',content:text}],unknown:42});
function storage(initial={}) {
  const values=new Map(Object.entries(initial));
  return {get length(){return values.size},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,
    setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
}
test('two tabs preserve stale branches and cloned tab pointers never reuse a writer',async()=>{
  const shared=storage({'conversations_a':JSON.stringify([record('M1')])}),tabA=storage(),tabB=storage();
  const a=new HistoryVault({owner:'a',storage:shared,tabStorage:tabA,uuid:()=> 'A'});
  const b=new HistoryVault({owner:'a',storage:shared,tabStorage:tabB,uuid:()=> 'B'});
  a.update({records:[record('A1')]});b.update({records:[record('B1')]});
  assert.equal(a.branches().find(x=>x.branchId==='A').records[0].history[1].content,'A1');
  assert.equal(a.branches().find(x=>x.branchId==='B').records[0].history[1].content,'B1');
  const reload=new HistoryVault({owner:'a',storage:shared,tabStorage:tabA,uuid:()=> 'C'});
  assert.equal(reload.snapshot.records[0].history[1].content,'A1');
  reload.update({records:[record('A2')]});
  assert.equal(b.branches().find(x=>x.branchId==='A').records[0].history[1].content,'A1');
  const text=await exportHistory('a',readHistoryBranches(shared,'a')),restored=storage(),restoredTab=storage();
  await stageHistoryRecovery(restored,restoredTab,'a',text);
  const records=JSON.parse(restored.getItem(restoredTab.getItem(vaultPrefix('a')+'tab'))).records;
  for (const content of ['A1','B1','A2']) assert.ok(records.some(r=>r.history[1].content===content));
});
test('shared raw backup yields the same recovery ID in JavaScript and Dart',async()=>{
  const text=await readFile(new URL('./fixtures/history-backup-v1.json',import.meta.url),'utf8');
  const who='interop-owner',archive=await decodeHistory(text,who),shared=storage(),tab=storage();
  assert.ok(archive.payload.includes('0.0'));
  assert.ok(JSON.stringify(archive.data).includes('"ratio":0'));
  await stageHistoryRecovery(shared,tab,who,text);
  const saved=JSON.parse(shared.getItem(tab.getItem(vaultPrefix(who)+'tab')));
  assert.equal(saved.records[0].id,'recovery-49ca145af6cfd7dcc9388947847bc0002b0ee210e8887553a1354faf4989b056');
  assert.equal(saved.records[0].history[0].content,'  原始\u2028🐾  ');
  assert.equal(saved.sourceArchive,text);
  assert.equal((await stageHistoryRecovery(shared,tab,who,text)).duplicate,true);
});
test('account switch isolates namespaces and lost session pointers retain recoverable branches',()=>{
  const shared=storage(),tab=storage();
  const a=new HistoryVault({owner:'a',storage:shared,tabStorage:tab,uuid:()=> 'A'});
  a.update({records:[record('offline')]});
  const b=new HistoryVault({owner:'a_secondary',storage:shared,tabStorage:tab,uuid:()=> 'B'});
  assert.deepEqual(b.snapshot.records,[]);assert.equal(b.branches().length,1);
  assert.equal(readHistoryBranches(shared,'a')[0].records[0].history[1].content,'offline');
  assert.equal(a.branches().length,1);
});
test('quota/storage write failure leaves the previous durable snapshot unchanged',()=>{
  const shared=storage(),a=new HistoryVault({owner:'a',storage:shared,tabStorage:storage(),uuid:()=> 'A'});
  a.update({records:[record('old')]});const old=shared.getItem(a.key);
  shared.setItem=()=>{throw new Error('full')};
  assert.throws(()=>a.update({records:[record('new')]}),/full/);
  assert.equal(shared.getItem(a.key),old);assert.equal(a.snapshot.records[0].history[1].content,'old');
});
test('raw history IDs, order, whitespace and metadata survive export and deterministic fresh recovery',async()=>{
  const shared=storage(),tab=storage(),raw=record('A1');
  const text=await exportHistory('a',[{id:'offline',records:[raw],sync:{pending:{id:'operation'}}}]);
  const parsed=await decodeHistory(text,'a');assert.deepEqual(parsed.data.branches[0].records[0],raw);
  const result=await stageHistoryRecovery(shared,tab,'a',text);
  assert.equal(result.count,1);
  const branch=JSON.parse(shared.getItem(tab.getItem(vaultPrefix('a')+'tab')));
  assert.notEqual(branch.records[0].id,'same');assert.deepEqual(branch.records[0].history,raw.history);
  assert.equal(branch.sourceArchive,text);assert.equal(branch.sync,null);
  assert.deepEqual(await stageHistoryRecovery(shared,tab,'a',text),{duplicate:true,count:0});
});
test('corruption, wrong account, invalid messages and duplicate IDs reject before storage mutation',async()=>{
  const raw=record('A1'),text=await exportHistory('a',[{id:'local',records:[raw]}]);
  await assert.rejects(decodeHistory(text.replace('A1','broken'),'a'),/校验/);
  await assert.rejects(decodeHistory(text,'b'),/账号/);
  await assert.rejects(exportHistory('a',[{id:'x',records:[raw,raw]}]),/ID/);
  await assert.rejects(exportHistory('a',[{id:'x',records:[{...raw,history:[{role:'user',content:null}]}]}]),/消息/);
});
test('damaged legacy bytes are retained and never replaced by an empty cache',()=>{
  const shared=storage({'conversations_a':'{damaged'});
  assert.throws(()=>new HistoryVault({owner:'a',storage:shared,tabStorage:storage()}));
  assert.equal(shared.getItem('conversations_a'),'{damaged');
  assert.equal(shared.length,1);
});
test('Flutter pending image intent is validated and preserved in a fresh recovered chat',async()=>{
  const entry={ownerId:'a',client_message_id:'stable',text:'offline',generation:2,
    reply_to_message_id:'old-reply',imageBytesBase64:['AQID'],status:'pending'};
  const text=await exportHistory('a',[],[entry]),shared=storage(),tab=storage();
  assert.equal((await stageHistoryRecovery(shared,tab,'a',text)).count,1);
  const branch=JSON.parse(shared.getItem(tab.getItem(vaultPrefix('a')+'tab')));
  assert.deepEqual(branch.records[0].history[0].recoveryOutbox,entry);
  await assert.rejects(decodeHistory(await exportHistory('a',[],[{...entry,ownerId:'b'}]),'a'),/归属/);
});
test('attachment downloads preserve exact bytes but recovery metadata is not forwarded to models',async()=>{
  const entry={ownerId:'a',client_message_id:'image',text:'image',imageBytesBase64:['AQID']};
  assert.deepEqual([...recoveredAttachments(entry,'a')[0].bytes()],[1,2,3]);
  assert.throws(()=>recoveredAttachments(entry,'b'),/归属/);
  const text=await exportHistory('a',[],[{...entry,imageBytesBase64:['AQI?']}]),shared=storage();
  await assert.rejects(stageHistoryRecovery(shared,storage(),'a',text),/编码/);
  assert.equal(shared.length,0);
  assert.deepEqual(buildVisionMessages([{role:'user',content:'image',recoveryOutbox:entry}]),[{role:'user',content:'image'}]);
});
test('account changes during async recovery and corrupted duplicate archive fail closed',async()=>{
  const text=await exportHistory('a',[{id:'local',records:[record('A1')]}]);
  const shared=storage(),tab=storage();
  await assert.rejects(stageHistoryRecovery(shared,tab,'a',text,()=>false),/账号/);
  assert.equal(shared.length,0);
  await stageHistoryRecovery(shared,tab,'a',text);
  const key=tab.getItem(vaultPrefix('a')+'tab'),saved=JSON.parse(shared.getItem(key));
  saved.sourceArchive='corrupted';shared.setItem(key,JSON.stringify(saved));
  await assert.rejects(stageHistoryRecovery(shared,tab,'a',text),/冲突/);
  assert.equal(JSON.parse(shared.getItem(key)).sourceArchive,'corrupted');
});
test('export and tab reload keep original archives without recursively nesting their envelopes',async()=>{
  const text=await exportHistory('a',[{id:'local',records:[record('A1')]}]),shared=storage(),tab=storage();
  await stageHistoryRecovery(shared,tab,'a',text);
  const original=tab.getItem(vaultPrefix('a')+'tab');
  const vault=new HistoryVault({owner:'a',storage:shared,tabStorage:tab,uuid:()=> 'new'});
  assert.equal(vault.snapshot.sourceArchive,undefined);
  assert.equal(JSON.parse(shared.getItem(original)).sourceArchive,text);
  assert.ok(readHistoryBranches(shared,'a').every(branch=>branch.sourceArchive===undefined));
});
