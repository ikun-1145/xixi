import {exportHistory,decodeHistory,recoveryRecords,validateRecords,vaultPrefix} from './history-vault.js';

export function readHistoryBranches(storage,owner) {
  const branches = [];
  for (let i=0;i<storage.length;i++) {
    const key = storage.key(i);
    if (!key?.startsWith(vaultPrefix(owner))) continue;
    const branch = JSON.parse(storage.getItem(key));
    if (branch.owner !== owner) continue;
    validateRecords(branch.records,owner);
    // Keep raw records/state without nesting previous full backup envelopes.
    branches.push({branchId:branch.branchId,records:branch.records,sync:branch.sync,currentId:branch.currentId});
    const bases = Object.values(branch.sync?.bases || {});
    if (bases.length) branches.push({id:branch.branchId+'-server-base',records:bases});
    for (const [id,intent] of Object.entries(branch.sync?.regenerations || {})) {
      branches.push({id:branch.branchId+'-original-'+id,records:[intent.original]});
      if (intent.draft) branches.push({id:branch.branchId+'-draft-'+id,records:[{
        ...intent.original,id:'draft-'+id,history:[...intent.original.history,{role:'assistant',content:intent.draft}],
      }]});
    }
  }
  const legacy = storage.getItem('conversations_'+owner);
  if (legacy) { const records=JSON.parse(legacy);validateRecords(records,owner);branches.push({id:'legacy',records}); }
  return branches;
}
export async function stageHistoryRecovery(storage,tabStorage,owner,text,isCurrent=()=>true) {
  const archive = await decodeHistory(text,owner);
  const key = vaultPrefix(owner)+'import-'+archive.sha256;
  if (storage.getItem(key)) {
    const saved = JSON.parse(storage.getItem(key));
    if (saved.owner !== owner || saved.sourceArchive !== text) throw new Error('恢复归档冲突，原数据已保留');
    validateRecords(saved.records,owner);
    return {duplicate:true,count:0};
  }
  const records = await recoveryRecords(archive,owner);
  if (!isCurrent()) throw new Error('账号已变化');
  // Raw original archive and clones are committed together. No server write.
  storage.setItem(key,JSON.stringify({owner,branchId:'import-'+archive.sha256,revision:0,
    records,sync:null,regenerations:{},currentId:records[0]?.id || null,sourceArchive:text,
    chatOutbox:archive.data.chatOutbox}));
  tabStorage.setItem(vaultPrefix(owner)+'tab',key);
  return {duplicate:false,count:records.length};
}
async function identity() {
  const token = localStorage.getItem('token'), payment=window.SunlandProPayment;
  if (!token || !payment) throw new Error('请先登录');
  const result = await payment.getVerifiedDatabaseIdentity();
  if (localStorage.getItem('token') !== token || !result.userId) throw new Error('账号已变化，请重试');
  return {owner:result.userId,token};
}
async function act(task) {
  const status=document.getElementById('historyBackupStatus');
  try {
    const who=await identity();
    await task(who,status);
  } catch(error) { status.textContent=error.message || '历史操作失败，原数据已保留'; }
}
if (typeof document !== 'undefined' && document.getElementById('historyExportBtn')) {
  document.getElementById('historyExportBtn').onclick=()=>act(async({owner,token},status)=>{
    const text=await exportHistory(owner,readHistoryBranches(localStorage,owner));
    if (localStorage.getItem('token')!==token) throw new Error('账号已变化');
    const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='sunland-history.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.textContent='已导出本机全部分支；文件包含私密消息，请妥善保存。远程附件为原始引用。';
  });
  document.getElementById('historyImportFile').onchange=event=>act(async({owner,token},status)=>{
    const file=event.target.files[0];if(!file)return;
    if(file.size>50*1024*1024)throw new Error('备份超过50MB');
    const text=await file.text();await decodeHistory(text,owner);
    if(localStorage.getItem('token')!==token)throw new Error('账号已变化');
    if(!confirm('恢复到新的会话，不覆盖云端原会话。原始备份将继续保留，是否继续？'))return;
    const result=await stageHistoryRecovery(localStorage,sessionStorage,owner,text,()=>localStorage.getItem('token')===token);
    status.textContent=result.duplicate?'已保留这份备份，无需重复导入。':'已恢复'+result.count+'个新会话；打开聊天后尝试同步，冲突数据会保留。';
    event.target.value='';
  });
  document.getElementById('historyRecoverBtn').onclick=()=>act(async({owner,token},status)=>{
    const text=await exportHistory(owner,readHistoryBranches(localStorage,owner));
    if(localStorage.getItem('token')!==token)throw new Error('账号已变化');
    if(!confirm('将保留的本机分支复制到新会话，不覆盖原会话。是否继续？'))return;
    const result=await stageHistoryRecovery(localStorage,sessionStorage,owner,text,()=>localStorage.getItem('token')===token);
    status.textContent=result.duplicate?'这份历史已恢复，请打开聊天查看。':'已保留原分支并恢复'+result.count+'个新会话，请打开聊天。';
  });
}
