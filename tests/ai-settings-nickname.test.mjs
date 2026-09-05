import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const settingsHtml = fs.readFileSync(
  new URL("../ai_settings.html", import.meta.url),
  "utf8",
);

const validatorSource = settingsHtml.match(
  /function isValidNickname\(name\) \{[\s\S]*?\n    \}/u,
)?.[0];
assert.ok(validatorSource, "ai_settings.html must define isValidNickname");
const isValidNickname = vm.runInNewContext(`(${validatorSource})`);

test("nickname accepts printable ASCII and Chinese characters up to 8 characters", () => {
  assert.equal(isValidNickname("Sunland1"), true);
  assert.equal(isValidNickname("霜蓝AI"), true);
  assert.equal(isValidNickname("霜蓝霜蓝霜蓝霜蓝"), true);
  assert.equal(isValidNickname("123456789"), false);
  assert.equal(isValidNickname("霜蓝霜蓝霜蓝霜蓝霜"), false);
  assert.equal(isValidNickname("Sun land"), false);
  assert.equal(isValidNickname("霜蓝\tAI"), false);
  assert.equal(isValidNickname("é"), false);
});

test("nickname save path validates before writing the original value", () => {
  const editNicknameBody = settingsHtml.match(
    /async function editNickname\(\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(editNicknameBody);
  assert.match(editNicknameBody, /if \(!isValidNickname\(name\)\)/u);
  assert.match(editNicknameBody, /name,\s*\n\s*updated_at:/u);
  assert.doesNotMatch(editNicknameBody, /name\.trim\(\)/u);
});
