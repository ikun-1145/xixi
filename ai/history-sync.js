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
const sameMetadata = (a, b) => {
  const left = { ...a }, right = { ...b };
  delete left.history; delete right.history;
  return equal(left, right);
};
const historyPrefix = (a, b) => a.history.length <= b.history.length &&
  a.history.every((message, index) => equal(message, b.history[index]));
const prefix = (a, b) => sameMetadata(a, b) && historyPrefix(a, b);
const containsDeviceOnlyAttachments = record => record.history.some(message => message.recoveryOutbox);
const retainedBranch = async (record, owner) => {
  const comparable = view(record);
  delete comparable.semanticContext;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable([owner, comparable])));
  const id = 'conflict-' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const next = { ...copy(record), id, userId: owner, syncForkOf: String(record.id) };
  delete next.semanticContext;
  return next;
};
export class HistoryConflict extends Error {}

export class HistorySync {
  constructor({ userId, storage, rpc, isCurrent }) {
    this.userId = userId; this.storage = storage; this.rpc = rpc; this.isCurrent = isCurrent;
    this.key = `conversation_sync_${userId}`;
    // The adapter stores each tab's bases with its independent durable branch.
    // A cache with an unknown base produces a conflict instead of an overwrite.
    this.state = { bases: {}, acknowledged: {}, blocked: [], deleted: [], contextDeletes: [],
      pending: null, deleteIntents: {}, ...JSON.parse(storage.getItem(this.key) || 'null') };
    this.queue = Promise.resolve(); this.revision = 0;
    this.replacements = new Set(this.state.replacements || []);
    this.state.regenerations ||= {};
  }
  serializedState() { return { ...this.state, replacements: [...this.replacements] }; }
  persist() { if (this.isCurrent()) this.storage.setItem(this.key, JSON.stringify(this.serializedState())); }
  hasUnresolvedRegeneration(id) { return ["pending","unknown","ready"].includes(this.state.regenerations[String(id)]?.status); }
  beginRegeneration(record) {
    const id = String(record.id);
    if (!this.isCurrent() || this.hasUnresolvedRegeneration(id) || this.state.pending ||
        this.state.blocked.includes(id) || !equal(this.state.acknowledged[id],view(record)) ||
        record.history.at(-1)?.role !== "assistant") throw new HistoryConflict();
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
        const ready = intent.status === "ready";
        result.push(ready && (!record || !historyPrefix(view(intent.result), view(record)))
          ? copy(intent.result) : (record || copy(intent.original)));
        continue;
      }
      const clean = !record || (old && equal(old, view(record)));
      const localView = record && view(record), remoteView = remote && view(remote);
      if (deleted.includes(id)) {
        if (!clean) { this.block(id); result.push(record); }
        else { delete this.state.bases[id]; delete this.state.acknowledged[id]; this.state.blocked = this.state.blocked.filter(key => key !== id); }
      } else if (!remote) {
        if (record) result.push(record);
      } else if (clean || equal(localView, remoteView) ||
          (!old && prefix(localView, remoteView))) {
        this.state.bases[id] = copy(raw); this.state.acknowledged[id] = remoteView;
        this.state.blocked = this.state.blocked.filter(key => key !== id); result.push(remote);
      } else if (historyPrefix(remoteView, localView) &&
          ((!old && remoteView.history.length > 0 && sameMetadata(remoteView, localView)) ||
            (old && historyPrefix(old, remoteView) &&
              (sameMetadata(remoteView, localView) || sameMetadata(old, remoteView))))) {
        this.state.bases[id] = copy(raw); this.state.acknowledged[id] = remoteView;
        this.state.blocked = this.state.blocked.filter(key => key !== id); result.push(record);
      } else { if (!old) this.block(id); result.push(record); }
    }
    ++this.revision; this.persist(); return result;
  }
  block(id) { if (!this.state.blocked.includes(id)) this.state.blocked.push(id); }
  project(record) { return filterConversationsForUser([copy(record)], this.userId)[0]; }
  async deliver() {
    const operation = this.state.pending;
    if (!operation || !this.isCurrent()) return;
    if (operation.upserts.some(item => containsDeviceOnlyAttachments(item.record))) {
      // Legacy pending batches may contain imported device-only bytes. Their
      // local records remain intact and safe records get a fresh operation.
      this.state.pending = null;
      try { this.persist(); }
      catch (error) { this.state.pending = operation; throw error; }
      return;
    }
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
        for (const item of operation.deletes) delete this.state.deleteIntents[String(item.id)];
        this.state.pending = null; this.persist(); throw new HistoryConflict('HISTORY_CONFLICT');
      }
      throw error;
    }
    if (!Array.isArray(data) || data.some(row => !row || row.id == null)) throw new Error('Invalid history acknowledgement');
    for (const item of operation.upserts) {
      const id = String(item.record.id), remote = data.find(row => String(row.id) === id);
      const projected = remote && this.project(remote);
      if (projected && equal(view(projected), view(item.record))) {
        this.state.bases[id] = copy(remote);
        if (this.state.deleteIntents[id]) this.state.deleteIntents[id].expected = copy(remote);
      } else this.block(id); // Receipt replay may return a newer version or deletion.
      this.state.acknowledged[id] = view(item.record);
      this.replacements.delete(id);
      if (this.state.regenerations[id]?.status === "ready") this.state.regenerations[id].status = "completed";
    }
    for (const item of operation.deletes) {
      const id = String(item.id);
      delete this.state.deleteIntents[id];
      delete this.state.bases[id]; delete this.state.acknowledged[id];
      this.state.blocked = this.state.blocked.filter(key => key !== id);
      if (!this.state.deleted.includes(id)) this.state.deleted.push(id);
    }
    if (operation.contextDelete && !this.state.contextDeletes.includes(operation.contextDelete)) this.state.contextDeletes.push(operation.contextDelete);
    this.state.pending = null; ++this.revision;
    try { this.persist(); }
    catch (error) { this.state.pending = operation; throw error; }
  }
  // Never overwrite a diverged cloud chat. Save a stable sibling only after a
  // fresh read proves the divergence, and leave the archived vault bytes alone.
  async retainLocalBranches(local, cloud, deleted, archived, isBusy, canApply = this.isCurrent, commit = () => {}) {
    const cloudById = new Map(cloud.map(row => [String(row.id), row]));
    const deletedIds = new Set([...deleted, ...this.state.deleted]);
    const records = new Map(local.map(row => [String(row.id), row]));
    const resolved = [];
    const stage = async rawRecord => {
      const record = this.project(rawRecord);
      if (!record) return;
      const fork = await retainedBranch(record, this.userId);
      if (deletedIds.has(fork.id) || records.has(fork.id)) return;
      const raw = cloudById.get(fork.id), remote = raw && this.project(raw);
      records.set(fork.id, remote || this.project(fork));
      if (remote) resolved.push({ id: fork.id, raw, remote });
    };
    for (const [id, record] of records) {
      const raw = cloudById.get(id), remote = raw && this.project(raw);
      if (isBusy(id)) continue;
      const intent = this.state.regenerations[id];
      if (intent && ["pending", "unknown"].includes(intent.status)) {
        if (intent.draft?.trim()) {
          await stage({ ...intent.original, history: [...intent.original.history.slice(0, -1),
            { role: 'assistant', content: intent.draft, interrupted: true }] });
        }
        resolved.push({ id, removeRegeneration: true });
      }
      if (!this.state.blocked.includes(id) || (!remote && !deletedIds.has(id))) continue;
      if (!equal(view(record), this.state.acknowledged[id]) && hasConversationStarted(record)) await stage(record);
      if (!canApply()) return null;
      if (remote && !deletedIds.has(id)) {
        records.set(id, remote);
      } else {
        records.delete(id);
      }
      resolved.push({id, raw, remote: deletedIds.has(id) ? null : remote});
    }
    for (const branch of archived) {
      const branchRecords = new Map(branch.records.map(row => [String(row.id), row]));
      for (const item of branch.sync?.pending?.upserts || []) {
        const id = String(item.record.id);
        if (!branchRecords.has(id)) branchRecords.set(id, item.record);
      }
      for (const [id, intent] of Object.entries(branch.sync?.regenerations || {})) {
        if (intent.status === 'ready' && intent.result &&
            (!branchRecords.has(id) || !historyPrefix(view(intent.result), view(branchRecords.get(id))))) {
          branchRecords.set(id, intent.result);
        } else if (['pending', 'unknown'].includes(intent.status) && intent.draft?.trim() && intent.original) {
          await stage({ ...intent.original, history: [...intent.original.history.slice(0, -1),
            { role: 'assistant', content: intent.draft, interrupted: true }] });
          if (!canApply()) return null;
        }
      }
      for (const [id, raw] of branchRecords) {
        const record = this.project(raw), acknowledged = branch.sync?.acknowledged?.[id];
        if (!record || id === '__xixi_user_profile__' || !hasConversationStarted(record) ||
            branch.sync?.deleted?.includes(id) || equal(view(record), acknowledged)) continue;
        const known = records.get(id), remoteRaw = cloudById.get(id);
        const remote = remoteRaw && this.project(remoteRaw);
        if ([known, remote].some(other => other && record.provider === other.provider &&
            historyPrefix(view(record), view(other)))) continue;
        if (!known && !remote && !deletedIds.has(id) && !this.state.blocked.includes(id)) {
          records.set(id, record);
        } else {
          await stage(record);
          if (!canApply()) return null;
        }
      }
    }
    if (!canApply()) return null;
    const snapshot = copy(this.serializedState());
    try {
      for (const {id, raw, remote, removeRegeneration} of resolved) {
        if (!removeRegeneration) {
          if (remote) {
            this.state.bases[id] = copy(raw);
            this.state.acknowledged[id] = view(remote);
          } else {
            delete this.state.bases[id];
            delete this.state.acknowledged[id];
          }
          this.state.blocked = this.state.blocked.filter(blocked => blocked !== id);
        }
        delete this.state.regenerations[id];
        this.replacements.delete(id);
      }
      const next = [...records.values()].filter(Boolean);
      commit(next, this.serializedState());
      return next;
    } catch (error) {
      this.state = snapshot;
      this.replacements = new Set(snapshot.replacements);
      throw error;
    }
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
        // Older imported archives can contain raw device-only attachment bytes.
        if (containsDeviceOnlyAttachments(record)) continue;
        if (!this.state.bases[id] && !hasConversationStarted(record)) continue;
        if (["pending","unknown"].includes(this.state.regenerations[id]?.status)) continue;
        if (this.state.deleted.includes(id) || this.state.deleteIntents[id] || equal(this.state.acknowledged[id], view(record))) continue;
        if (this.state.blocked.includes(id)) { conflicted = true; continue; }
        upserts.push({ expected_record: this.state.regenerations[id]?.status === "ready"
          ? this.state.regenerations[id].expected : (this.state.bases[id] || null), record: copy(record),
          ...(this.replacements.has(id) ? { mode: 'replace' } : {}) });
      }
      if (!upserts.length) { if (conflicted) throw new HistoryConflict('HISTORY_CONFLICT'); return; }
      this.state.pending = { id: newHistoryOperationId(), upserts, deletes: [] };
      try { this.persist(); }
      catch (error) { this.state.pending = null; throw error; }
      await this.deliver();
      if (conflicted) throw new HistoryConflict('HISTORY_CONFLICT');
    });
  }
  delete(id, clearContext = false) {
    id = String(id);
    return this.enqueue(async () => {
      if (this.state.blocked.includes(id)) throw new HistoryConflict('HISTORY_CONFLICT');
      const previous = this.state.deleteIntents[id];
      this.state.deleteIntents[id] = { clearContext, expected: this.state.bases[id] || null };
      try { this.persist(); }
      catch (error) {
        if (previous) this.state.deleteIntents[id] = previous;
        else delete this.state.deleteIntents[id];
        throw error;
      }
      await this.deliverDeletes();
    });
  }
  async deliverDeletes() {
    await this.deliver();
    if (!this.isCurrent()) return;
    for (const [id, intent] of Object.entries(this.state.deleteIntents)) {
      // Every delete uses the version seen by its caller or that caller's own
      // prior write receipt, even across a restart between the operations.
      this.state.pending = { id: newHistoryOperationId(), upserts: [], deletes: [{ id, expected_record: intent.expected || null }],
        ...(intent.clearContext ? { contextDelete: id } : {}) };
      try { this.persist(); }
      catch (error) { this.state.pending = null; throw error; }
      await this.deliver();
      if (!this.isCurrent()) return;
    }
  }
}
