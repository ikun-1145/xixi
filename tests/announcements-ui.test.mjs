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
  assert.match(source, /\.eq\("id", "global"\)/u);
  assert.match(source, /maintenance_enabled,maintenance_title,maintenance_message,maintenance_estimated_end/u);
  assert.match(source, /\[\["设置", "ai_settings\.html"\], \["公告", "announcements\.html"\]\]/u);
  assert.ok(source.indexOf("await holdForMaintenanceIfEnabled()") < source.lastIndexOf("window.__SUNLAND_AI_REVEAL__"));
});
