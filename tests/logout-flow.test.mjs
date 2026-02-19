import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const donateHtml = fs.readFileSync(new URL('../donate.html', import.meta.url), 'utf8');

test('logout flow awaits local signOut and subscribes to auth state changes', () => {
  assert.match(donateHtml, /await\s+supabase\.auth\.signOut\(\{\s*scope:\s*'local'\s*\}\)/);
  assert.match(donateHtml, /supabase\.auth\.onAuthStateChange\(/);
  assert.match(donateHtml, /clearSupabaseAuthStorage\(localStorage\)/);
});
