import test from 'node:test';
import assert from 'node:assert/strict';

import { clearSupabaseAuthStorage, shouldClearAuthKey } from '../p/js/authState.js';

class MockStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key) {
    this.map.delete(key);
  }

  getItem(key) {
    return this.map.get(key) ?? null;
  }
}

test('shouldClearAuthKey matches supabase auth storage keys', () => {
  assert.equal(shouldClearAuthKey('supabase.auth.token'), true);
  assert.equal(shouldClearAuthKey('sb-klyrasrqgxijwrxuoevj-auth-token'), true);
  assert.equal(shouldClearAuthKey('justLoggedIn'), false);
});

test('clearSupabaseAuthStorage removes only auth keys', () => {
  const storage = new MockStorage({
    'supabase.auth.token': 'legacy',
    'sb-klyrasrqgxijwrxuoevj-auth-token': 'current',
    justLoggedIn: '1',
    theme: 'dark'
  });

  clearSupabaseAuthStorage(storage);

  assert.equal(storage.getItem('supabase.auth.token'), null);
  assert.equal(storage.getItem('sb-klyrasrqgxijwrxuoevj-auth-token'), null);
  assert.equal(storage.getItem('justLoggedIn'), '1');
  assert.equal(storage.getItem('theme'), 'dark');
});
