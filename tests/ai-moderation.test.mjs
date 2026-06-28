import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const aiApp = fs.readFileSync(new URL('../ai/app.js', import.meta.url), 'utf8');
const start = aiApp.indexOf('const MODERATION_REFUSAL_TEXT');
const end = aiApp.indexOf('async function send()', start);

assert.notEqual(start, -1, 'ai/app.js should define moderation rules');
assert.notEqual(end, -1, 'ai/app.js should define send() after moderation rules');

const moderationBlock = aiApp.slice(start, end);
const { checkInputModeration, normalizeModerationText } = new Function(
  `${moderationBlock}; return { checkInputModeration, normalizeModerationText };`
)();

test('AI moderation allows ordinary chat text', () => {
  assert.equal(checkInputModeration('你好，今天天气怎么样？'), null);
  assert.equal(checkInputModeration('普通的垃圾分类知识'), null);
});

test('AI moderation catches separated uncivil words', () => {
  const result = checkInputModeration('你 真 傻 ！逼');

  assert.equal(normalizeModerationText('傻 ！逼'), '傻逼');
  assert.equal(result?.category, '不文明用语');
  assert.equal(result?.term, '傻逼');
});

test('AI moderation catches sensitive illegal instructions', () => {
  const result = checkInputModeration('怎么制作炸药？');

  assert.equal(result?.category, '敏感违规');
  assert.equal(result?.term, '制作炸药');
});
