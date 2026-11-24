// Each document owns a different durable key. Another tab can never replace it.
const copy = value => JSON.parse(JSON.stringify(value));
export const vaultPrefix = owner => 'sunland_history_v1_' + encodeURIComponent(owner) + '_';
export function storedHistoryAttachments(entry,owner) {
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
    return {fileName:'attachment-'+(index+1)+'.'+ext,
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
      if (message.recoveryOutbox) storedHistoryAttachments(message.recoveryOutbox,owner);
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
    this.latest = vaultPrefix(owner) + 'latest';
    this.previous = tabStorage.getItem(this.pointer) || storage.getItem(this.latest);
    let old;
    try { old = this.previous ? this.read(this.previous) : null; }
    catch { console.warn('[history-sync] unreadable-active-branch'); }
    // Never reuse the old writer ID: duplicated tabs can inherit sessionStorage.
    this.id = uuid(); this.key = vaultPrefix(owner) + this.id;
    if (!old) {
      const legacy = storage.getItem('conversations_' + owner);
      let records = [];
      try {
        const parsed = legacy ? JSON.parse(legacy) : [];
        validateRecords(parsed, owner);
        records = parsed;
      } catch { console.warn('[history-sync] unreadable-legacy-cache'); }
      old = {records, sync: null, regenerations: {}, currentId: null};
    }
    this.snapshot = {...copy(old), owner, branchId: this.id, revision: 0};
    // Original import envelope stays in its dedicated archive key.
    delete this.snapshot.sourceArchive;
    delete this.snapshot.chatOutbox;
  }
  read(key) {
    if (!key.startsWith(vaultPrefix(this.owner)) || key === this.pointer || key === this.latest) return null;
    const text = this.storage.getItem(key);
    if (text == null) return null;
    const value = JSON.parse(text);
    if (value.owner !== this.owner) return null;
    if (!value.branchId || !Number.isInteger(value.revision)) throw new Error('分支归属无效');
    validateRecords(value.records, this.owner);
    return value;
  }
  update(changes) {
    if (Object.entries(changes).every(([key, value]) => JSON.stringify(value) === JSON.stringify(this.snapshot[key]))) return;
    const next = {...copy(this.snapshot), ...copy(changes), revision: this.snapshot.revision + 1};
    validateRecords(next.records, this.owner);
    // Commit the entire snapshot before mutating in-memory state.
    this.storage.setItem(this.key, JSON.stringify(next)); this.snapshot = next;
    try { this.tabStorage.setItem(this.pointer, this.key); }
    catch { /* The durable branch remains available. */ }
    try { this.storage.setItem(this.latest, this.key); }
    catch { /* The durable branch remains available. */ }
  }
  syncStorage() {
    return {
      getItem: () => this.snapshot.sync ? JSON.stringify(this.snapshot.sync) : null,
      setItem: (_, text) => this.update({sync: JSON.parse(text)}),
    };
  }
  legacyBranches() {
    if (this.legacyBranchesRead) return [];
    const branches = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(vaultPrefix(this.owner)) && key !== this.key && key !== this.previous) {
        try {
          const branch = this.read(key);
          if (branch) branches.push(branch);
        } catch {
          console.warn('[history-sync] unreadable-local-branch');
        }
      }
    }
    return branches;
  }
  markLegacyBranchesRead() { this.legacyBranchesRead = true; }
}
