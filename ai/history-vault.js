// Each document owns a different durable key. Another tab can never replace it.
const copy = value => JSON.parse(JSON.stringify(value));
export const vaultPrefix = owner => 'sunland_history_v1_' + encodeURIComponent(owner) + '_';
export function recoveredAttachments(entry,owner) {
  if (!entry || entry.ownerId !== owner) throw new Error('附件归属无效');
  const values=entry.imageBytesBase64 ?? [];
  if (!Array.isArray(values)) throw new Error('附件格式无效');
  let size=0;
  return values.map((encoded,index)=>{
    if (typeof encoded !== 'string' || encoded.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
        (encoded && btoa(atob(encoded.slice(-4))) !== encoded.slice(-4))) throw new Error('附件编码无效');
    size+=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);
    if (size>16*1024*1024) throw new Error('附件超过16MB');
    const header=atob(encoded.slice(0,16));
    const ext=header.startsWith('\x89PNG')?'png':header.startsWith('\xff\xd8')?'jpg':
      header.startsWith('GIF8')?'gif':header.startsWith('RIFF')&&header.slice(8,12)==='WEBP'?'webp':'bin';
    return {fileName:'restored-attachment-'+(index+1)+'.'+ext,
      bytes:()=>Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))};
  });
}
export function validateRecords(records, owner) {
  if (!Array.isArray(records) || records.length > 10000) throw new Error('历史记录格式无效');
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        !['string', 'number'].includes(typeof record.id) || !String(record.id) ||
        ids.has(String(record.id)) || (record.userId != null && record.userId !== owner) ||
        !Array.isArray(record.history)) throw new Error('历史归属、ID或格式无效');
    ids.add(String(record.id));
    const messages = new Set();
    for (const message of record.history) {
      if (!message || !['system','user','assistant','tool'].includes(message.role) ||
          typeof message.content !== 'string') throw new Error('消息格式无效');
      if (message.recoveryOutbox) recoveredAttachments(message.recoveryOutbox,owner);
      const id = message.id ?? message.message_id;
      if (id != null && messages.has(String(id))) throw new Error('消息ID重复');
      if (id != null) messages.add(String(id));
    }
  }
}
export class HistoryVault {
  constructor({owner, storage, tabStorage, uuid = () => crypto.randomUUID()}) {
    this.owner = owner; this.storage = storage; this.tabStorage = tabStorage;
    this.pointer = vaultPrefix(owner) + 'tab';
    const previous = tabStorage.getItem(this.pointer);
    let old = previous ? this.read(previous) : null;
    // Never reuse the old writer ID: duplicated tabs can inherit sessionStorage.
    this.id = uuid(); this.key = vaultPrefix(owner) + this.id;
    if (!old) {
      const legacy = storage.getItem('conversations_' + owner);
      const records = legacy ? JSON.parse(legacy) : [];
      validateRecords(records, owner);
      old = {records, sync: null, regenerations: {}, currentId: null};
    }
    this.snapshot = {...copy(old), owner, branchId: this.id, revision: 0};
    // Original import envelope stays in its dedicated archive key.
    delete this.snapshot.sourceArchive;
    this.persist();
    tabStorage.setItem(this.pointer, this.key);
  }
  read(key) {
    if (!key.startsWith(vaultPrefix(this.owner)) || key === this.pointer) return null;
    const text = this.storage.getItem(key);
    if (text == null) return null;
    const value = JSON.parse(text);
    if (value.owner !== this.owner) return null;
    if (!value.branchId || !Number.isInteger(value.revision)) throw new Error('分支归属无效');
    validateRecords(value.records, this.owner);
    return value;
  }
  persist() { this.storage.setItem(this.key, JSON.stringify(this.snapshot)); }
  update(changes) {
    const next = {...copy(this.snapshot), ...copy(changes), revision: this.snapshot.revision + 1};
    validateRecords(next.records, this.owner);
    // Commit the entire snapshot before mutating in-memory state.
    this.storage.setItem(this.key, JSON.stringify(next)); this.snapshot = next;
  }
  syncStorage() {
    return {
      getItem: () => this.snapshot.sync ? JSON.stringify(this.snapshot.sync) : null,
      setItem: (_, text) => this.update({sync: JSON.parse(text)}),
    };
  }
  branches() {
    const branches = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(vaultPrefix(this.owner)) && key !== this.pointer) {
        const branch = this.read(key); if (branch) branches.push(branch);
      }
    }
    return branches;
  }
}
const format = 'sunland-history';
async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
const checksumInput = (owner, payload) => format + '\n1\n' + owner + '\n' + payload;
export async function exportHistory(owner, branches, chatOutbox = []) {
  for (const branch of branches) validateRecords(branch.records, owner);
  const payload = JSON.stringify({branches, chatOutbox}, null, 2);
  return JSON.stringify({format, version: 1, ownerId: owner, payload,
    sha256: await digest(checksumInput(owner,payload))}, null, 2);
}
export async function decodeHistory(text, owner) {
  if (new TextEncoder().encode(text).length > 50 * 1024 * 1024) throw new Error('备份超过50MB');
  const envelope = JSON.parse(text);
  if (envelope.format !== format || envelope.version !== 1 || envelope.ownerId !== owner ||
      typeof envelope.payload !== 'string' || envelope.sha256 !== await digest(checksumInput(owner,envelope.payload))) {
    throw new Error('备份账号、版本或完整性校验失败');
  }
  const payload = JSON.parse(envelope.payload);
  if (!Array.isArray(payload.branches) || !Array.isArray(payload.chatOutbox)) throw new Error('备份结构无效');
  for (const branch of payload.branches) {
    if (!branch || typeof branch.id !== 'string' && typeof branch.branchId !== 'string') throw new Error('分支ID无效');
    validateRecords(branch.records, owner);
  }
  for (const entry of payload.chatOutbox) {
    if (!entry || entry.ownerId !== owner || typeof entry.client_message_id !== 'string' ||
        !entry.client_message_id || typeof entry.text !== 'string') throw new Error('待发消息归属或格式无效');
    recoveredAttachments(entry,owner);
  }
  return {...envelope, data: payload};
}
// Deterministic new IDs make crash/retry/duplicate import idempotent. No old ID
// or old Core semanticContext is ever used as a write target.
export async function recoveryRecords(archive, owner) {
  const records = [];
  for (const [branchIndex,branch] of archive.data.branches.entries()) {
    for (const [recordIndex,record] of branch.records.entries()) {
      if (record.id === '__xixi_user_profile__') continue;
      const identity = await digest(checksumInput(owner,archive.sha256+'\nrecord\n'+branchIndex+'\n'+recordIndex));
      const id = 'recovery-' + identity;
      const clone = {...copy(record), id, userId: owner, title: '恢复 · ' + (record.title || '新对话'),
        recoverySourceId: String(record.id), recoveryDigest: identity};
      delete clone.semanticContext;
      records.push(clone);
    }
  }
  for (const [index,entry] of archive.data.chatOutbox.entries()) {
    const identity = await digest(checksumInput(owner,archive.sha256+'\noutbox\n'+index));
    const id = 'recovery-' + identity;
    records.push({id,userId:owner,title:'恢复 · 保留消息',provider:'deepseek',model:'deepseek-v4-flash',
      createdAt:0,updatedAt:0,recoveryDigest:identity,history:[{
        id:entry.client_message_id,role:'user',content:entry.text,recoveryOutbox:copy(entry),
      }]});
  }
  return records;
}
