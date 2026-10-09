// The server RPC owns concurrency. These bases record the version each local
// edit actually saw; downloading another snapshot must not rewrite that base.
import { filterConversationsForUser } from './conversation-recovery.js';
import { hasConversationStarted } from './providers/conversation.js';
export const newHistoryOperationId = () => crypto.randomUUID();
const copy = value => JSON.parse(JSON.stringify(value));
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const view = record => {
  const result = copy(record);
  delete result.updatedAt;
  result.id = String(result.id);
  result.history = (result.history || []).filter(message => message.role !== 'system');
  return result;
};
const equal = (a, b) => stable(a) === stable(b);
const prefix = (a, b) => {
  const left = { ...a }, right = { ...b };
  delete left.history; delete right.history;
  return equal(left, right) && a.history.length <= b.history.length && a.history.every((message, index) => equal(message, b.history[index]));
};
export class HistoryConflict extends Error {}

export class HistorySync {
  constructor({ userId, storage, rpc, isCurrent }) {
    this.userId = userId; this.storage = storage; this.rpc = rpc; this.isCurrent = isCurrent;
    this.key = `conversation_sync_${userId}`;
    // sessionStorage isolates the bases of concurrent tabs; localStorage remains
    // the existing conversation cache. A new tab with an unknown branch conflicts.
    this.state = JSON.parse(storage.getItem(this.key) || 'null') || { bases: {}, acknowledged: {}, blocked: [], deleted: [], contextDeletes: [], pending: null };
    this.queue = Promise.resolve(); this.revision = 0;
    this.replacements = new Set();
  }
  persist() { if (this.isCurrent()) this.storage.setItem(this.key, JSON.stringify(this.state)); }
  enqueue(action) {
    const next = this.queue.then(() => this.isCurrent() ? action() : undefined);
    this.queue = next.catch(() => {});
    return next;
  }
  reconcile(local, cloud, deleted = [], readRevision = this.revision) {
    if (readRevision !== this.revision) return local;
    const byId = Object.fromEntries(cloud.filter(row => row.id !== '__xixi_user_profile__' && this.project(row)).map(row => [String(row.id), row]));
    const cached = Object.fromEntries(local.map(row => [String(row.id), row]));
    const result = [];
    for (const id of new Set([...Object.keys(cached), ...Object.keys(byId)])) {
      if (this.state.deleted.includes(id)) continue;
      const record = cached[id], raw = byId[id], remote = raw && this.project(raw), old = this.state.acknowledged[id];
      if (record && remote && hasConversationStarted(record) && record.provider !== remote.provider) {
        this.block(id); result.push(record); continue;
      }
      const clean = !record || (old && equal(old, view(record)));
      if (deleted.includes(id)) {
        if (!clean) { this.block(id); result.push(record); }
        else { delete this.state.bases[id]; delete this.state.acknowledged[id]; this.state.blocked = this.state.blocked.filter(key => key !== id); }
      } else if (!remote) {
        if (record) result.push(record);
      } else if (clean || (!old && !hasConversationStarted(record) && prefix(view(record), view(remote)))) {
        this.state.bases[id] = copy(raw); this.state.acknowledged[id] = view(remote);
        this.state.blocked = this.state.blocked.filter(key => key !== id); result.push(remote);
      } else { if (!old) this.block(id); result.push(record); }
    }
    ++this.revision; this.persist(); return result;
  }
  block(id) { if (!this.state.blocked.includes(id)) this.state.blocked.push(id); }
  project(record) { return filterConversationsForUser([copy(record)], this.userId)[0]; }
  async deliver() {
    const operation = this.state.pending;
    if (!operation || !this.isCurrent()) return;
    const { data, error } = await this.rpc({ p_operation_id: operation.id, p_upserts: operation.upserts, p_deletes: operation.deletes });
    if (!this.isCurrent()) return;
    if (error) {
      if (error.code === 'PT409' || error.status === 409) {
        for (const item of operation.upserts) this.block(String(item.record.id));
        for (const item of operation.deletes) this.block(String(item.id));
        this.state.pending = null; this.persist(); throw new HistoryConflict('HISTORY_CONFLICT');
      }
      throw error;
    }
    if (!Array.isArray(data) || data.some(row => !row || row.id == null)) throw new Error('Invalid history acknowledgement');
    for (const item of operation.upserts) {
      const id = String(item.record.id), remote = data.find(row => String(row.id) === id);
      if (remote && this.project(remote) && equal(view(this.project(remote)), view(item.record))) this.state.bases[id] = copy(remote);
      else this.block(id); // Receipt replay may return a newer version or deletion.
      this.state.acknowledged[id] = view(item.record);
      this.replacements.delete(id);
    }
    for (const item of operation.deletes) {
      const id = String(item.id);
      delete this.state.bases[id]; delete this.state.acknowledged[id];
      this.state.blocked = this.state.blocked.filter(key => key !== id);
      if (!this.state.deleted.includes(id)) this.state.deleted.push(id);
    }
    if (operation.contextDelete && !this.state.contextDeletes.includes(operation.contextDelete)) this.state.contextDeletes.push(operation.contextDelete);
    this.state.pending = null; ++this.revision; this.persist();
  }
  save(source) {
    return this.enqueue(async () => {
      await this.deliver();
      if (!this.isCurrent()) return;
      const upserts = [];
      let conflicted = false;
      for (const record of source()) {
        const id = String(record.id);
        if (this.state.deleted.includes(id) || equal(this.state.acknowledged[id], view(record))) continue;
        if (this.state.blocked.includes(id)) { conflicted = true; continue; }
        upserts.push({ expected_record: this.state.bases[id] || null, record: copy(record),
          ...(this.replacements.has(id) ? { mode: 'replace' } : {}) });
      }
      if (!upserts.length) { if (conflicted) throw new HistoryConflict('HISTORY_CONFLICT'); return; }
      this.state.pending = { id: newHistoryOperationId(), upserts, deletes: [] };
      this.persist(); await this.deliver();
      if (conflicted) throw new HistoryConflict('HISTORY_CONFLICT');
    });
  }
  delete(id, clearContext = false) {
    id = String(id);
    return this.enqueue(async () => {
      await this.deliver();
      if (!this.isCurrent()) return;
      if (this.state.blocked.includes(id)) throw new HistoryConflict('HISTORY_CONFLICT');
      this.state.pending = { id: newHistoryOperationId(), upserts: [], deletes: [{ id, expected_record: this.state.bases[id] || null }],
        ...(clearContext ? { contextDelete: id } : {}) };
      this.persist(); await this.deliver();
    });
  }
}
