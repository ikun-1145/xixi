import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloadHtml = fs.readFileSync(path.join(projectRoot, 'download.html'), 'utf8');

test('download page exposes version-locked Android and iOS release assets', () => {
  assert.match(downloadHtml, /href="\/apk\?v=1\.4\.2%2B31&cache=3"/u);
  assert.match(
    downloadHtml,
    /releases\/download\/v1\.4\.2%2B31\/sunland-ai-1\.4\.2%2B31\.ipa/u,
  );
  assert.equal((downloadHtml.match(/<a[^>]+data-download-button/g) || []).length, 2);
});

test('platform download buttons use the supplied local transparent artwork', () => {
  for (const asset of ['p/logo-android-new.png', 'p/apple-11.png']) {
    assert.match(downloadHtml, new RegExp(`src="${asset.replace('/', '\\/')}"`, 'u'));
    assert.ok(fs.statSync(path.join(projectRoot, asset)).size > 0, `${asset} must exist`);
  }
});

test('dark mode keeps black platform artwork on a light high-contrast surface', () => {
  assert.match(downloadHtml, /\.btn-dl\s*\{[^}]*background:\s*#f7fbff;/su);
  assert.match(downloadHtml, /\.btn-dl\s*\{[^}]*color:\s*#0b1220;/su);
  assert.match(downloadHtml, /\.btn-dl:focus-visible\s*\{/u);
});
