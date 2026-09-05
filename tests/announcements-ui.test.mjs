import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../announcements.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../ai/announcements.js", import.meta.url), "utf8");

test("announcements page uses the public API and renders service text as textContent", () => {
  assert.match(html, /type="module" src="ai\/announcements\.js"/u);
  assert.match(source, /https:\/\/api\.sunland\.dev\/v1\/announcements/u);
  assert.match(source, /title\.textContent = item\.title/u);
  assert.match(source, /content\.textContent = item\.content/u);
  assert.doesNotMatch(source, /innerHTML/u);
  assert.doesNotMatch(source, /authorization|SunlandDatabaseToken/u);
});

test("AI maintenance gate reads only existing global config and keeps settings plus announcements reachable", () => {
  const source = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  assert.match(source, /publicSupabase\s*\.from\("app_config"\)/u);
  assert.match(source, /\.eq\("config_key", "global"\)/u);
  assert.match(source, /maintenance_enabled,maintenance_title,maintenance_message,maintenance_estimated_end/u);
  assert.match(source, /\[\["设置", "ai_settings\.html"\], \["公告", "announcements\.html"\]\]/u);
  assert.ok(source.indexOf("await holdForMaintenanceIfEnabled()") < source.lastIndexOf("window.__SUNLAND_AI_REVEAL__"));
});

test("all AI entry pages load the shared Supabase maintenance gate", () => {
  const pages = [
    "login.html",
    "ai_settings.html",
    "copilot.html",
    "download.html",
    "announcements.html",
    "pro_activation_support.html",
    "verify.html",
  ];
  for (const page of pages) {
    const html = fs.readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.match(html, /p\/vendor\/supabase-2\.110\.7\.js/u, `${page} must load Supabase`);
    assert.match(html, /ai\/maintenance\.js\?v=[^"]+/u, `${page} must load maintenance gate`);
  }
  const source = fs.readFileSync(new URL("../ai/maintenance.js", import.meta.url), "utf8");
  assert.match(source, /from\("app_config"\)/u);
  assert.match(source, /\.eq\("config_key", "global"\)/u);
  assert.match(source, /maintenance_enabled,maintenance_title,maintenance_message,maintenance_estimated_end/u);
  assert.match(source, /maintenance_enabled === true/u);
  assert.doesNotMatch(source, /innerHTML/u);
});
