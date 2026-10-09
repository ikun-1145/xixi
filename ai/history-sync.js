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
    // The adapter stores each tab's bases with its independent durable branch.
    // A cache with an unknown base produces a conflict instead of an overwrite.
    this.state = JSON.parse(storage.getItem(this.key) || 'null') || { bases: {}, acknowledged: {}, blocked: [], deleted: [], contextDeletes: [], pending: null };
    this.queue = Promise.resolve(); this.revision = 0;
    this.replacements = new Set(this.state.replacements || []);
    this.state.regenerations ||= {};
  }
  persist() { this.state.replacements = [...this.replacements]; if (this.isCurrent()) this.storage.setItem(this.key, JSON.stringify(this.state)); }
  hasUnresolvedRegeneration(id) { return ["pending","unknown","ready"].includes(this.state.regenerations[String(id)]?.status); }
  beginRegeneration(record) {
    const id = String(record.id);
    if (!this.isCurrent() || this.hasUnresolvedRegeneration(id) || this.state.pending ||
        this.state.blocked.includes(id) || !equal(this.state.acknowledged[id],view(record)) ||
        record.history.at(-1)?.role !== "assistant") throw new HistoryConflict("请先同步或恢复冲突，原回答已保留");
    const intent = {requestId:newHistoryOperationId(),original:copy(record),
      expected:copy(this.state.bases[id]),status:"pending",draft:""};
    this.state.regenerations[id] = intent;
    try { this.persist(); } catch(error) { delete this.state.regenerations[id]; throw error; }
    return intent;
  }
  markRegenerationUnknown(id,draft) {
    const intent = this.state.regenerations[String(id)];
    if (!intent || intent.status !== "pending") return;
    intent.status = "unknown"; intent.draft = draft; this.persist();
  }
  checkpointRegeneration(id,draft) {
    const intent = this.state.regenerations[String(id)];
    if (!intent || intent.status !== "pending") return;
    intent.draft = draft; this.persist();
  }
  completeRegeneration(record,message) {
    const id = String(record.id), intent = this.state.regenerations[id];
    if (!intent || intent.status !== "pending" || !message.content?.trim() ||
        !equal(record,intent.original) || !equal(this.state.bases[id],intent.expected)) {
      throw new HistoryConflict("重新生成冲突，原回答已保留");
    }
    const next = {...copy(record),history:[...copy(record.history.slice(0,-1)),copy(message)]};
    intent.status = "ready"; intent.result = copy(next);
    this.replacements.add(id);
    try { this.persist(); } catch(error) { intent.status="unknown"; this.replacements.delete(id); throw error; }
    return next;
  }
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
      const intent = this.state.regenerations[id];
      if (intent && ["pending","unknown","ready"].includes(intent.status)) {
        if (deleted.includes(id) || !equal(raw,intent.expected)) this.block(id);
        result.push(intent.status === "ready" ? copy(intent.result) : (record || copy(intent.original)));
        continue;
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
        const ids = [...operation.upserts.map(item => String(item.record.id)), ...operation.deletes.map(item => String(item.id))];
        let conflictingId;
        try {
          const details = typeof error.details === 'string' ? JSON.parse(error.details) : error.details;
          if (typeof details?.conversation_id === 'string' && ids.includes(details.conversation_id)) conflictingId = details.conversation_id;
        } catch (_) { /* Older servers have no per-record conflict details. */ }
        for (const id of conflictingId ? [conflictingId] : ids) this.block(id);
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
      if (this.state.regenerations[id]?.status === "ready") this.state.regenerations[id].status = "completed";
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
      for (let record of source()) {
        if (this.state.regenerations[String(record.id)]?.status === "ready") record = this.state.regenerations[String(record.id)].result;
        const id = String(record.id);
        if (["pending","unknown"].includes(this.state.regenerations[id]?.status)) continue;
        if (this.state.deleted.includes(id) || equal(this.state.acknowledged[id], view(record))) continue;
        if (this.state.blocked.includes(id)) { conflicted = true; continue; }
        upserts.push({ expected_record: this.state.regenerations[id]?.status === "ready"
          ? this.state.regenerations[id].expected : (this.state.bases[id] || null), record: copy(record),
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
