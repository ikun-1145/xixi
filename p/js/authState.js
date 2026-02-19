// authState.js

const SUPABASE_STORAGE_PATTERNS = [/^supabase\.auth\./, /^sb-.*-auth-token$/];

export function shouldClearAuthKey(key) {
  return SUPABASE_STORAGE_PATTERNS.some((pattern) => pattern.test(key));
}

export function clearSupabaseAuthStorage(storage) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return;
  }

  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && shouldClearAuthKey(key)) {
      keys.push(key);
    }
  }

  for (const key of keys) {
    storage.removeItem(key);
  }
}
