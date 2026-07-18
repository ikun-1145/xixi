import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const aiAppJs = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');

test('AI send button handles touch before synthetic click', () => {
  assert.match(aiAppJs, /function handleSendButtonIntent\(/);
  assert.match(aiAppJs, /sendBtn\.addEventListener\("pointerdown"/);
  assert.match(aiAppJs, /sendBtn\.addEventListener\("touchstart"/);
  assert.match(aiAppJs, /suppressNextSendClick = true/);
  assert.match(aiAppJs, /source === "click" && suppressNextSendClick/);
  assert.doesNotMatch(aiAppJs, /sendBtn\.onclick\s*=/);
});
