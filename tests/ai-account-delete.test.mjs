import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAccountLocalStorage,
  collectAccountLocalStorageKeys,
} from "../ai/account-delete.js";

class MockStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.map.get(key) ?? null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

test("collectAccountLocalStorageKeys contains account keys and no device-global keys", () => {
  const keys = collectAccountLocalStorageKeys("user-a");

  assert.ok(keys.includes("token"));
  assert.ok(keys.includes("user"));
  assert.ok(keys.includes("conversations_user-a"));
  assert.ok(keys.includes("current_conversation_user-a"));
  assert.ok(keys.includes("xixi_profile_user-a"));
  assert.ok(keys.includes("sunland_knowledge_user-a"));
  assert.ok(keys.includes("sunland:pro-payment-pending:user-a"));
  assert.ok(!keys.includes("lang"));
  assert.ok(!keys.includes("theme"));
});

test("clearAccountLocalStorage removes account keys and preserves device settings", async () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = new MockStorage({
    token: "app-token",
    user: '{"id":"user-a"}',
    "conversations_user-a": "[]",
    "current_conversation_user-a": "1",
    "xixi_profile_user-a": "{}",
    lang: "zh",
    theme: "dark",
  });

  try {
    await clearAccountLocalStorage("user-a");
    assert.equal(globalThis.localStorage.getItem("token"), null);
    assert.equal(globalThis.localStorage.getItem("user"), null);
    assert.equal(globalThis.localStorage.getItem("conversations_user-a"), null);
    assert.equal(globalThis.localStorage.getItem("current_conversation_user-a"), null);
    assert.equal(globalThis.localStorage.getItem("xixi_profile_user-a"), null);
    assert.equal(globalThis.localStorage.getItem("lang"), "zh");
    assert.equal(globalThis.localStorage.getItem("theme"), "dark");
  } finally {
    if (original === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = original;
    }
  }
});
