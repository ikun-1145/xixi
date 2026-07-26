import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { restoreLocalConversationState } from '../ai/conversation-recovery.js';
import { SunlandProvider } from '../ai/providers/SunlandProvider.js';
import {
  getVerifiedUserId,
  IdentityAuthority,
  isVerifiedIdentity,
} from '../ai/verified-identity.js';

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');

function tokenFor(userId, exp = Math.floor(Date.now() / 1000) + 3600) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'test' })}.${encode({ sub: userId, exp })}.signature`;
}

function responseFor(userId, { token = tokenFor(userId), responseUserId = userId } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ token, user: { id: responseUserId, email: `${responseUserId}@example.com` } }),
  };
}

function trackedStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [];
  const writes = [];
  return {
    reads,
    writes,
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push(key); values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function conversation(userId, id = 1) {
  return {
    id,
    provider: 'sunland',
    model: 'frost',
    userId,
    title: 'private',
    history: [{ role: 'system', content: 'system' }],
    updatedAt: id,
  };
}

test('Token A is authoritative when localStorage user cache says B', async () => {
  const token = tokenFor('user-a');
  const authority = new IdentityAuthority({ fetchImpl: async () => responseFor('user-a', { token }) });
  const result = await authority.resolve({
    token,
    cachedUser: { id: 'user-b', email: 'private-b@example.com', avatar_url: 'b.png' },
  });

  assert.equal(result.ok, true);
  assert.equal(getVerifiedUserId(result.identity), 'user-a');
  assert.equal(result.identity.user.email, 'user-a@example.com');
  assert.notEqual(result.identity.user.avatar_url, 'b.png');
});

test('residual or manually modified local user data never changes an in-memory verified identity', async () => {
  const token = tokenFor('user-a');
  let calls = 0;
  const authority = new IdentityAuthority({
    fetchImpl: async () => { calls += 1; return responseFor('user-a', { token }); },
  });
  const first = await authority.resolve({ token, cachedUser: { id: 'user-a' } });
  const second = await authority.resolve({ token, cachedUser: { id: 'user-b' } });

  assert.equal(first.identity, second.identity);
  assert.equal(getVerifiedUserId(second.identity), 'user-a');
  assert.equal(calls, 1);
});

test('unverifiable, malformed, mismatched, and expired verified tokens produce no identity', async () => {
  const denied = new IdentityAuthority({
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  assert.equal((await denied.resolve({ token: tokenFor('user-a') })).ok, false);
  assert.equal(denied.current(), null);

  const malformed = new IdentityAuthority({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ token: 'bad.jwt.token' }) }),
  });
  assert.equal((await malformed.resolve({ token: 'opaque-old-token' })).ok, false);

  const mismatchToken = tokenFor('user-a');
  const mismatch = new IdentityAuthority({
    fetchImpl: async () => responseFor('user-a', { token: mismatchToken, responseUserId: 'user-b' }),
  });
  assert.equal((await mismatch.resolve({ token: mismatchToken })).reason, 'identity-mismatch');

  const expiredToken = tokenFor('user-a', Math.floor(Date.now() / 1000) - 60);
  const expired = new IdentityAuthority({
    fetchImpl: async () => responseFor('user-a', { token: expiredToken }),
  });
  assert.equal((await expired.resolve({ token: expiredToken })).reason, 'expired-verified-token');
});

test('an expired input token is accepted only when the server returns a fresh verified token', async () => {
  const expired = tokenFor('user-a', Math.floor(Date.now() / 1000) - 60);
  const fresh = tokenFor('user-a');
  const authority = new IdentityAuthority({
    fetchImpl: async () => responseFor('user-a', { token: fresh }),
  });
  const result = await authority.resolve({ token: expired });

  assert.equal(result.ok, true);
  assert.equal(result.identity.token, fresh);
  assert.equal(getVerifiedUserId(result.identity), 'user-a');
});

test('switching verified users revokes the previous identity and blocks its Sunland engine access', async () => {
  const tokenA = tokenFor('user-a');
  const tokenB = tokenFor('user-b');
  const authority = new IdentityAuthority({
    fetchImpl: async (_url, options) => (
      options.headers.Authorization.endsWith(tokenA)
        ? responseFor('user-a', { token: tokenA })
        : responseFor('user-b', { token: tokenB })
    ),
  });
  const identityA = (await authority.resolve({ token: tokenA })).identity;
  const identityB = (await authority.resolve({ token: tokenB })).identity;
  const storage = trackedStorage();
  globalThis.window = { localStorage: storage };
  const provider = new SunlandProvider();
  const blocked = await provider.send({
    conversation: conversation('user-a'),
    identity: identityA,
    messages: [{ role: 'user', content: '我叫什么' }],
  });

  assert.equal(isVerifiedIdentity(identityA), false);
  assert.equal(isVerifiedIdentity(identityB), true);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(storage.reads, []);
  assert.deepEqual(storage.writes, []);
});

test('out-of-order identity verification cannot restore an older user', async () => {
  const tokenA = tokenFor('user-a');
  const tokenB = tokenFor('user-b');
  const pending = new Map();
  const authority = new IdentityAuthority({
    fetchImpl: async (_url, options) => new Promise(resolve => {
      pending.set(options.headers.Authorization.slice('Bearer '.length), resolve);
    }),
  });

  const resolvingA = authority.resolve({ token: tokenA });
  const resolvingB = authority.resolve({ token: tokenB });
  pending.get(tokenB)(responseFor('user-b', { token: tokenB }));
  const resultB = await resolvingB;
  pending.get(tokenA)(responseFor('user-a', { token: tokenA }));
  const resultA = await resolvingA;

  assert.equal(resultB.ok, true);
  assert.equal(resultA.reason, 'stale-resolution');
  assert.equal(authority.current().userId, 'user-b');
});

test('verified user A restores only A conversations even when B cache and data remain on device', async () => {
  const storage = trackedStorage({
    user: JSON.stringify({ id: 'user-b' }),
    'conversations_user-a': JSON.stringify([conversation('user-a', 1), conversation('user-b', 2)]),
    'conversations_user-b': JSON.stringify([conversation('user-b', 3)]),
  });
  const result = restoreLocalConversationState({ storage, userId: 'user-a' });

  assert.deepEqual(result.conversations.map(item => item.id), [1]);
  assert.deepEqual(storage.reads, ['conversations_user-a', 'current_conversation_user-a']);
  assert.equal(storage.reads.includes('user'), false);
  assert.equal(storage.reads.includes('conversations_user-b'), false);
});

test('cloud and realtime paths capture the verified user and reject stale-user callbacks', () => {
  assert.match(aiApp, /async function syncFromCloud\(\) \{\s*const userId = getCurrentUserId\(\)/);
  assert.match(aiApp, /if \(getCurrentUserId\(\) !== userId\) return;/);
  assert.match(aiApp, /filter: `user_id=eq\.\$\{userId\}`/);
  assert.match(aiApp, /payload\.new\?\.user_id != null && payload\.new\.user_id !== userId/);
  assert.doesNotMatch(aiApp, /session\.user\.id|normalizeStoredUser|getIdentityFromJwtPayload/);
});
