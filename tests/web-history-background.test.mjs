import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { HistorySync, HistoryConflict } from '../ai/history-sync.js';
import { HistoryVault, vaultPrefix } from '../ai/history-vault.js';
import { filterConversationsForUser } from '../ai/conversation-recovery.js';
import { conversationIdKey } from '../ai/providers/conversation.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const app = read('ai/app.js');
const syncSource = app.slice(app.indexOf('let syncTimer = null;'), app.indexOf('function belongsToCurrentConversationNamespace'));

function storage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    get length() { return items.size; }, key: index => [...items.keys()][index],
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
  };
}

const conversation = (...contents) => ({
  id: 'stable-chat', userId: 'user', model: 'deepseek-v4-flash', provider: 'deepseek',
  title: '聊天', createdAt: 1, updatedAt: 1,
  history: contents.map(content => ({ role: 'user', content })),
});

function server() {
  return {
    rows: [], operations: [], errors: [], receipts: new Set(), databaseTokens: [],
    createClient(accessToken) {
      const transport = this;
      const query = (type, params) => ({
        select() { return this; },
        eq(column, value) { assert.equal(column, 'user_id'); assert.equal(value, 'user'); return this; },
        maybeSingle() { return this; },
        async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal, 'all history endpoints must have a deadline');
          const token = accessToken();
          transport.databaseTokens.push(token);
          if (type === 'conversations') return { data: { data: structuredClone(transport.rows) } };
          if (type === 'deleted_conversations') return { data: [] };
          transport.operations.push(structuredClone(params));
          if (transport.errors.length) {
            const planned = transport.errors.shift();
            if (planned instanceof Error) throw planned;
            return planned;
          }
          if (!transport.receipts.has(params.p_operation_id)) {
            for (const { record, expected_record } of params.p_upserts) {
              const current = transport.rows.find(row => row.id === record.id) || null;
              assert.deepEqual(structuredClone(expected_record), current);
              transport.rows = [...transport.rows.filter(row => row.id !== record.id), structuredClone(record)];
            }
            transport.receipts.add(params.p_operation_id);
          }
          return { data: structuredClone(transport.rows) };
        },
      });
      return {
        from: table => query(table),
        rpc: (name, params) => {
          assert.equal(name, 'sunland_apply_conversation_patch');
          return query('rpc', params);
        },
      };
    },
  };
}

function runtime(remote, local = storage({ token: 'app-user' }), tab = storage()) {
  const listeners = new Map(), timers = new Map(), logs = [], toasts = [];
  let now = 0, timerId = 0, databaseToken = 'db-user-1';
  const context = vm.createContext({
    localStorage: local, sessionStorage: tab, navigator: { onLine: true },
    historySessionGeneration: 1, conversations: [], currentId: null,
    AbortSignal, HistorySync, HistoryVault, HistoryConflict, PROFILE_META_ID: '__xixi_user_profile__',
    Date: { now: () => now }, Math: { min: Math.min, random: () => 0, round: Math.round },
    setTimeout: (callback, wait) => { timers.set(++timerId, { callback, wait }); return timerId; },
    clearTimeout: timer => timers.delete(timer),
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      SunlandDatabaseToken: {
        get: async owner => { assert.equal(owner, 'user'); return databaseToken; },
        clear: () => { databaseToken = 'db-user-2'; },
      },
    },
    getCurrentUserId: () => 'user',
    console: { warn: (...args) => logs.push(args) },
    createHistoryClient: accessToken => remote.createClient(accessToken),
    normalizeCloudData: rows => rows,
    filterConversationsForUser, conversationIdKey,
    persistCurrentConversationId: () => true, isConversationDeleted: () => false,
    requestCoordinator: { activeForConversation: () => false },
    chatInner: { hasChildNodes: () => false, replaceChildren: () => {} },
    renderChatList: () => {}, loadChat: () => {},
    showToast: value => toasts.push(value), alert: value => toasts.push(value),
  });
  vm.runInContext(syncSource, context);
  context.conversations = context.getHistoryVault('user').snapshot.records;
  return {
    context, local, tab, listeners, timers, logs, toasts,
    async advance(wait) {
      now += wait;
      const next = [...timers].find(([, timer]) => timer.wait === wait);
      assert.ok(next, 'the scheduled delay should match backoff');
      timers.delete(next[0]);
      next[1].callback();
      await context.syncFromCloud();
    },
  };
}

test('reload during the write debounce uploads a local chat without another edit', async () => {
  const remote = server(), first = runtime(remote);
  first.context.conversations = [conversation('persisted before debounce')];
  first.context.saveConversations();
  assert.deepEqual(remote.rows, []);
  const fresh = runtime(remote, first.local, first.tab);
  assert.deepEqual(fresh.context.conversations, [conversation('persisted before debounce')]);
  await fresh.context.syncFromCloud();
  await fresh.context.syncFromCloud();
  assert.deepEqual(remote.rows, [conversation('persisted before debounce')]);
  assert.equal(remote.operations.length, 1);
});

test('offline local edits flush on online, then latest edits follow the same failed receipt with backoff', async () => {
  const remote = server(), browser = runtime(remote);
  browser.context.navigator.onLine = false;
  browser.context.conversations = [conversation('offline')];
  browser.context.saveConversations();
  await browser.context.syncFromCloud();
  assert.equal(remote.operations.length, 0);
  remote.errors.push({ status: 503, error: { code: '503' } }, new DOMException('timeout', 'TimeoutError'));
  browser.context.navigator.onLine = true;
  browser.listeners.get('online')();
  await browser.context.syncFromCloud();
  assert.equal(remote.operations.length, 1);
  await browser.context.syncFromCloud();
  assert.equal(remote.operations.length, 1, 'focus and new sends must respect the active backoff');

  browser.context.conversations = [conversation('offline', 'second turn', 'third turn')];
  browser.context.saveConversations();
  await browser.advance(750);
  assert.equal(remote.operations.length, 2);
  await browser.advance(1500);
  assert.equal(remote.operations.length, 4);
  assert.equal(remote.operations[1].p_operation_id, remote.operations[0].p_operation_id);
  assert.equal(remote.operations[2].p_operation_id, remote.operations[0].p_operation_id);
  assert.notEqual(remote.operations[3].p_operation_id, remote.operations[0].p_operation_id);
  assert.deepEqual(remote.rows, [conversation('offline', 'second turn', 'third turn')]);
  assert.deepEqual(browser.toasts, []);
  assert.ok(browser.logs.some(entry => entry[2] === '503'));
});

test('a rejected database JWT is renewed and the upload retries the same operation ID', async () => {
  const remote = server(), browser = runtime(remote);
  browser.context.conversations = [conversation('authenticated')];
  remote.errors.push({ status: 401, error: { code: 'PGRST301' } });
  await browser.context.syncFromCloud();
  assert.deepEqual(remote.rows, [conversation('authenticated')]);
  assert.equal(remote.operations.length, 2);
  assert.deepEqual(remote.operations[0], remote.operations[1]);
  assert.deepEqual(remote.databaseTokens.slice(-2), ['db-user-1', 'db-user-2']);
  assert.deepEqual(browser.toasts, []);
});

test('an older vault without a browser-session pointer remains account scoped and syncs its unsent history', async () => {
  const abandonedKey = vaultPrefix('user') + 'abandoned';
  const abandoned = JSON.stringify({ owner: 'user', branchId: 'abandoned', revision: 1, records: [conversation('legacy')] });
  const local = storage({
    token: 'app-user',
    [abandonedKey]: abandoned,
    [vaultPrefix('other') + 'abandoned']: JSON.stringify({ owner: 'other', branchId: 'abandoned', revision: 1,
      records: [{ ...conversation('other private'), userId: 'other' }] }),
  });
  const remote = server(), browser = runtime(remote, local);
  await browser.context.syncFromCloud();
  assert.deepEqual(remote.rows, [conversation('legacy')]);
  assert.equal(local.getItem(abandonedKey), abandoned);
});

test('chat and settings preserve Frosted themes with no history backup entry across supported locales', () => {
  const settings = read('ai_settings.html'), chat = read('ai.html');
  const bundle = [settings, chat, app, read('p/js/site-i18n.js'), read('p/js/site-i18n-extra.js')].join('\n');
  assert.doesNotMatch(bundle, /history-controls\.js|historyExportBtn|historyRecoverBtn|historyImportFile|历史备份与恢复|云端同步暂时失败|History backup and recovery|Cloud sync failed temporarily|履歴のバックアップと復元|同期が一時的に失敗/);
  for (const [source, theme] of [[settings, 'frost-settings.css'], [chat, 'frost-chat.css']]) {
    const dom = new JSDOM(source);
    try {
      assert.ok([...dom.window.document.styleSheets].length || dom.window.document.querySelector('style'));
      assert.ok(dom.window.document.querySelector(`link[href*="${theme}"]`));
      assert.equal(dom.window.document.querySelector('#historyImportFile'), null);
    } finally { dom.window.close(); }
  }
});

test('a user switch during token exchange cannot send the old history payload to either account', async () => {
  const remote = server(), browser = runtime(remote);
  browser.context.conversations = [conversation('private A')];
  let owner = 'user';
  let release;
  browser.context.getCurrentUserId = () => owner;
  browser.context.window.SunlandDatabaseToken.get = () => new Promise(resolve => { release = resolve; });
  const sync = browser.context.getHistorySync(owner);
  const active = sync.save(() => browser.context.conversations);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  owner = 'new-user';
  browser.context.historySessionGeneration++;
  release('expired-owner-token');
  await assert.rejects(active, /history-session-changed/);
  assert.equal(remote.operations.length, 0);
  assert.equal(browser.context.getHistoryVault('user').snapshot.sync.pending.upserts[0].record.history[0].content, 'private A');
  assert.deepEqual(browser.toasts, []);
});
