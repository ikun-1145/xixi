import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const extra=readFileSync(new URL('../p/js/site-i18n-extra.js',import.meta.url),'utf8');
const runtime=readFileSync(new URL('../p/js/site-i18n.js',import.meta.url),'utf8');
const client=readFileSync(new URL('../p/js/phone-auth.js',import.meta.url),'utf8');
const catalog=JSON.parse(extra.match(/const phoneAuthCatalog = ([\s\S]*?);\n  global\.SiteI18nAdditionalCatalog/)[1]);
for(const lang of ['zh-Hant','en','ja','ko','es'])test(`new phone UI and safe errors translated through shared runtime: ${lang}`,t=>{
 const dom=new JSDOM('',{url:'https://sunland.dev',runScripts:'outside-only'});t.after(()=>dom.window.close());
 dom.window.eval(extra);dom.window.eval(runtime);dom.window.eval(client);dom.window.SiteI18n.setLanguage(lang);
 for(const [source,translations]of Object.entries(catalog)){assert.equal(typeof translations[lang],'string',source);assert.ok(translations[lang].length>0);assert.equal(dom.window.SunlandPhoneAuth.text(source),translations[lang],source);}
 assert.ok(!dom.window.SunlandPhoneAuth.errorText({code:'CODE_INVALID'}).includes('SECRET'));
 if(lang==='en')assert.match(dom.window.SunlandPhoneAuth.errorText({code:'CODE_INVALID'}),/incorrect or expired/);
 if(lang==='ja')assert.match(dom.window.SunlandPhoneAuth.errorText({code:'REAUTH_INVALID'}),/再認証/);
});
test('language switches preserve the existing preference key and phone input values',t=>{
 const dom=new JSDOM('<section data-site-i18n-ignore><input value="13800000000"></section>',{url:'https://sunland.dev',runScripts:'outside-only'});t.after(()=>dom.window.close());
 dom.window.eval(extra);dom.window.eval(runtime);dom.window.eval(client);
 for(const lang of ['zh','en','ja']){dom.window.SiteI18n.setLanguage(lang);assert.equal(dom.window.localStorage.getItem('lang'),lang);assert.equal(dom.window.document.querySelector('input').value,'13800000000');}
 assert.equal(dom.window.localStorage.length,1);
});
