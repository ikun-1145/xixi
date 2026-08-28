import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloadHtml = fs.readFileSync(path.join(projectRoot, 'download.html'), 'utf8');

test('download page exposes version-locked Android and iOS release assets', () => {
  assert.match(
    downloadHtml,
    /href="https:\/\/api\.sunland\.dev\/v1\/download\/apk\?v=1\.4\.2%2B31"/u,
  );
  assert.match(
    downloadHtml,
    /href="https:\/\/api\.sunland\.dev\/v1\/download\/ipa\?v=1\.4\.2%2B31"/u,
  );
  assert.equal((downloadHtml.match(/<a[^>]+data-download-button/g) || []).length, 2);
});

test('platform download buttons use the supplied local transparent artwork', () => {
  for (const asset of ['p/logo-android-new.png', 'p/apple-11.png']) {
    assert.match(downloadHtml, new RegExp(`src="${asset.replace('/', '\\/')}"`, 'u'));
    assert.ok(fs.statSync(path.join(projectRoot, asset)).size > 0, `${asset} must exist`);
  }
});

test('platform download buttons expose a visible action, release detail, and download cue', () => {
  assert.equal((downloadHtml.match(/class="download-label" data-i18n="dl(?:Android|Ios)Btn"/gu) || []).length, 2);
  assert.equal((downloadHtml.match(/class="download-detail">(?:APK|IPA) · v1\.4\.2\+31</gu) || []).length, 2);
  assert.equal((downloadHtml.match(/class="download-arrow" aria-hidden="true"/gu) || []).length, 2);
  assert.doesNotMatch(downloadHtml, /class="sr-only" data-i18n="dl(?:Android|Ios)Btn"/u);
});

test('dark mode keeps black platform artwork on a light high-contrast surface', () => {
  assert.match(downloadHtml, /\.btn-dl\s*\{[^}]*background:\s*#f7fbff;/su);
  assert.match(downloadHtml, /\.btn-dl\s*\{[^}]*color:\s*#0b1220;/su);
  assert.match(downloadHtml, /\.btn-dl:focus-visible\s*\{/u);
});
