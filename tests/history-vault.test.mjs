import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryVault, vaultPrefix, storedHistoryAttachments } from '../ai/history-vault.js';
import { buildVisionMessages } from '../ai/multimodal.js';

const record = text => ({ id: 'same', userId: 'a', provider: 'deepseek', title: '原始', history: [
  { id: 'm1', role: 'user', content: ' M1 🧊 ', unknown: { x: 1 } },
  { id: 'm2', role: 'assistant', content: text },
], unknown: 42 });

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('duplicated tabs keep independent writers and reloading a tab retains its pending records', () => {
  const shared = storage({ conversations_a: JSON.stringify([record('original')]) });
  const tabA = storage();
  const a = new HistoryVault({ owner: 'a', storage: shared, tabStorage: tabA, uuid: () => 'A' });
  a.update({ records: [record('A1')] });
  const tabB = storage({ [a.pointer]: shared.getItem(a.latest) });
  const b = new HistoryVault({ owner: 'a', storage: shared, tabStorage: tabB, uuid: () => 'B' });
  b.update({ records: [record('B1')] });
  assert.equal(JSON.parse(shared.getItem(a.key)).records[0].history[1].content, 'A1');
  assert.equal(JSON.parse(shared.getItem(b.key)).records[0].history[1].content, 'B1');
  const reload = new HistoryVault({ owner: 'a', storage: shared, tabStorage: tabA, uuid: () => 'C' });
  assert.deepEqual(reload.snapshot.records, [record('A1')]);
  assert.equal(shared.getItem(reload.key), null, 'reload alone must not duplicate a full durable snapshot');
  assert.deepEqual(reload.legacyBranches().map(branch => branch.records[0]), [record('B1')]);
});

test('a fresh tab recovers the latest account snapshot and durable operation without another edit', () => {
  const shared = storage();
  const old = new HistoryVault({ owner: 'a', storage: shared, tabStorage: storage(), uuid: () => 'A' });
  const sync = { pending: { id: 'fixed-operation-id' } };
  old.update({ records: [record('offline')], sync });
  const reopened = new HistoryVault({ owner: 'a', storage: shared, tabStorage: storage(), uuid: () => 'B' });
  assert.deepEqual(reopened.snapshot.records, [record('offline')]);
  assert.deepEqual(reopened.snapshot.sync, sync);
  const other = new HistoryVault({ owner: 'a_secondary', storage: shared, tabStorage: storage(), uuid: () => 'C' });
  assert.deepEqual(other.snapshot.records, []);
  assert.deepEqual(other.legacyBranches(), []);
});

test('previously imported chats and attachment payloads remain readable without duplicating or changing the archive', () => {
  const key = vaultPrefix('a') + 'import-previous';
  const attachment = { ownerId: 'a', client_message_id: 'stored', text: 'image', imageBytesBase64: ['AQID'] };
  const imported = record('existing');
  imported.history[0].recoveryOutbox = attachment;
  const original = JSON.stringify({ owner: 'a', revision: 1, branchId: 'import-previous', records: [imported],
    sourceArchive: 'original bytes', chatOutbox: [attachment] });
  const shared = storage({ [key]: original });
  const tab = storage({ [vaultPrefix('a') + 'tab']: key });
  const vault = new HistoryVault({ owner: 'a', storage: shared, tabStorage: tab, uuid: () => 'new' });
  assert.deepEqual(vault.snapshot.records, [imported]);
  assert.equal(vault.snapshot.sourceArchive, undefined);
  assert.deepEqual([...storedHistoryAttachments(attachment, 'a')[0].bytes()], [1, 2, 3]);
  assert.throws(() => storedHistoryAttachments(attachment, 'b'), /归属/);
  assert.deepEqual(buildVisionMessages([{ role: 'user', content: 'image', recoveryOutbox: attachment }]),
    [{ role: 'user', content: 'image' }]);
  vault.update({ currentId: imported.id });
  assert.equal(shared.getItem(key), original);
});

test('quota failure preserves the last durable record and lets the caller detect the failure', () => {
  const shared = storage();
  const vault = new HistoryVault({ owner: 'a', storage: shared, tabStorage: storage(), uuid: () => 'A' });
  vault.update({ records: [record('old')] });
  const old = shared.getItem(vault.key);
  shared.setItem = () => { throw new Error('full'); };
  assert.throws(() => vault.update({ records: [record('new')] }), /full/);
  assert.equal(shared.getItem(vault.key), old);
  assert.deepEqual(vault.snapshot.records, [record('old')]);
});

test('malformed or foreign legacy data does not block an account or alter existing bytes', () => {
  const key = vaultPrefix('a') + 'foreign';
  const foreign = JSON.stringify({ owner: 'b', revision: 0, branchId: 'foreign', records: [] });
  const shared = storage({ conversations_a: '{damaged', [key]: foreign });
  const vault = new HistoryVault({ owner: 'a', storage: shared, tabStorage: storage(), uuid: () => 'A' });
  assert.deepEqual(vault.legacyBranches(), []);
  vault.update({ records: [record('new')] });
  assert.equal(shared.getItem('conversations_a'), '{damaged');
  assert.equal(shared.getItem(key), foreign);
});
