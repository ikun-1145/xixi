import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloadHtml = fs.readFileSync(path.join(projectRoot, 'download.html'), 'utf8');
const updateManifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'update.json'), 'utf8'),
);
const ipaGuidePath = path.join(projectRoot, 'p/video/ipa-install-guide.mp4');

test('update manifest provides both release download URLs', () => {
  assert.match(updateManifest.version, /^\d+(?:\.\d+)+$/u);
  assert.ok(Number.isInteger(updateManifest.build));
  assert.ok(new URL(updateManifest.url).protocol.startsWith('http'));
  assert.ok(new URL(updateManifest.ipaUrl).protocol.startsWith('http'));
});

test('Android43 forced manifest pins the Worker asset and its signed APK checksum', () => {
  assert.equal(updateManifest.version,'1.5.3');
  assert.equal(updateManifest.build,43);
  assert.equal(updateManifest.android_min_build,43);
  assert.equal(updateManifest.force,true);
  assert.equal(updateManifest.url,'https://api.sunland.dev/v1/download/apk?v=1.5.3%2B43');
  assert.equal(updateManifest.apk_url,updateManifest.url);
  assert.equal(updateManifest.apk_sha256,'b98ced5e9184d5f12047863b53f39b931fd7716ff90559ec5c896237e5e73e78');
  assert.equal(updateManifest.apk_size,188821267);
  assert.equal(updateManifest.ipaUrl,'https://api.sunland.dev/v1/download/ipa?v=1.5.2%2B42');
});

test('download page uses Android43 proxy while preserving the separate iOS42 link and label', async () => {
  const dom=new JSDOM(`<a data-download-button="android" aria-disabled="true"><span data-release-version></span></a>
    <a data-download-button="ios" aria-disabled="true"><span data-release-version></span></a>
    <p data-release-description hidden></p>`,{url:'https://sunland.dev/download.html',runScripts:'outside-only'});
  try {
    dom.window.fetch=async(url,options)=>{
      assert.equal(url,'update.json');assert.equal(options.cache,'no-store');
      return {ok:true,json:async()=>updateManifest};
    };
    const script=downloadHtml.slice(downloadHtml.indexOf('  (async function() {',downloadHtml.indexOf('RELEASE MANIFEST')),
      downloadHtml.indexOf('  /* ═',downloadHtml.indexOf('RELEASE MANIFEST')+30));
    await dom.window.eval(script);
    const android=dom.window.document.querySelector('[data-download-button="android"]');
    const ios=dom.window.document.querySelector('[data-download-button="ios"]');
    assert.equal(android.href,updateManifest.url);
    assert.equal(android.textContent,'APK · v1.5.3+43');
    assert.equal(android.hasAttribute('aria-disabled'),false);
    assert.equal(ios.href,updateManifest.ipaUrl);
    assert.equal(ios.textContent,'IPA · v1.5.2+42');
  } finally {dom.window.close();}
});

test('download page loads release copy, version, and links from the update manifest', () => {
  assert.match(downloadHtml, /fetch\('update\.json', \{ cache: 'no-store' \}\)/u);
  assert.match(downloadHtml, /data-release-description/u);
  assert.equal((downloadHtml.match(/class="download-detail" data-release-version/g) || []).length, 2);
  assert.equal((downloadHtml.match(/data-download-button="(?:android|ios)"/g) || []).length, 2);
  assert.doesNotMatch(downloadHtml, /href="https:\/\/api\.sunland\.dev\/v1\/download\/(?:apk|ipa)/u);
  assert.doesNotMatch(downloadHtml, /APK · v\d+\.\d+\.\d+\+\d+/u);
});

test('platform download buttons use the supplied local transparent artwork', () => {
  for (const asset of ['p/logo-android-new.png', 'p/apple-11.png']) {
    assert.match(downloadHtml, new RegExp(`src="${asset.replace('/', '\\/')}"`, 'u'));
    assert.ok(fs.statSync(path.join(projectRoot, asset)).size > 0, `${asset} must exist`);
  }
});

test('platform download buttons expose a visible action, release detail, and download cue', () => {
  assert.equal((downloadHtml.match(/class="download-label" data-i18n="dl(?:Android|Ios)Btn"/gu) || []).length, 2);
  assert.equal((downloadHtml.match(/class="download-detail" data-release-version>/gu) || []).length, 2);
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
