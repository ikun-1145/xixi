import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloadHtml = fs.readFileSync(path.join(projectRoot, 'download.html'), 'utf8');
const updateManifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'update.json'), 'utf8'),
);
const ipaGuidePath = path.join(projectRoot, 'p/video/ipa-install-guide.mp4');

test('update manifest points to the mainland APK proxy for the published release', () => {
  assert.equal(updateManifest.version, '1.4.5');
  assert.equal(updateManifest.build, 34);
  assert.equal(updateManifest.force, true);
  assert.equal(
    updateManifest.url,
    'https://api.sunland.dev/v1/download/apk?v=1.4.5%2B34',
  );
});

test('download page exposes version-locked Android and iOS release assets', () => {
  assert.match(
    downloadHtml,
    /href="https:\/\/api\.sunland\.dev\/v1\/download\/apk\?v=1\.4\.5%2B34"/u,
  );
  assert.match(
    downloadHtml,
    /href="https:\/\/api\.sunland\.dev\/v1\/download\/ipa\?v=1\.4\.5%2B34"/u,
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
  assert.equal((downloadHtml.match(/class="download-detail">(?:APK|IPA) · v1\.4\.5\+34</gu) || []).length, 2);
  assert.equal((downloadHtml.match(/class="download-arrow" aria-hidden="true"/gu) || []).length, 2);
  assert.doesNotMatch(downloadHtml, /class="sr-only" data-i18n="dl(?:Android|Ios)Btn"/u);
});

test('iOS download option links to the browser-playable IPA installation guide', () => {
  assert.match(
    downloadHtml,
    /<a href="p\/video\/ipa-install-guide\.mp4"[\s\S]*?class="install-guide-link"[\s\S]*?target="_blank"[\s\S]*?rel="noopener"/u,
  );
  assert.match(downloadHtml, /data-i18n="dlIosGuide">观看 IPA 安装教程</u);
  assert.ok(fs.statSync(ipaGuidePath).size > 0, 'IPA guide video must exist');
  assert.equal(fs.readFileSync(ipaGuidePath).subarray(4, 8).toString('ascii'), 'ftyp');
});

test('dark mode keeps black platform artwork on a light high-contrast surface', () => {
  assert.match(downloadHtml, /\.btn-dl\s*\{[^}]*background:\s*#f7fbff;/su);
  assert.match(downloadHtml, /\.btn-dl\s*\{[^}]*color:\s*#0b1220;/su);
  assert.match(downloadHtml, /\.btn-dl:focus-visible\s*\{/u);
});
