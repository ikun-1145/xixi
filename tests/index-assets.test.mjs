import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const getAssetPaths = () => {
  const matches = [...indexHtml.matchAll(/(?:href|url\()=['\"]?(p\/[\w.-]+\.(?:png|jpe?g|webp))/g)];
  return matches.map((m) => m[1]);
};

test('index page background and preload assets should exist', () => {
  // 视觉重构（2026-07）：首页移除 bj.png 背景插画，仅保留头像资源
  const requiredAssets = ['p/tx.jpeg'];
  const usedAssets = getAssetPaths();

  for (const asset of requiredAssets) {
    assert.ok(usedAssets.includes(asset), `index.html should reference ${asset}`);
    assert.ok(fs.existsSync(new URL(`../${asset}`, import.meta.url)), `${asset} should exist`);
  }
});
