import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const settingsHtml = fs.readFileSync(
  new URL("../ai_settings.html", import.meta.url),
  "utf8",
);

test("settings dark theme covers the document beyond the first viewport", () => {
  assert.match(
    settingsHtml,
    /html\.dark,\s*body\.dark\s*\{[^}]*background:\s*var\(--bg-dark\);/su,
  );
  assert.match(
    settingsHtml,
    /document\.documentElement\.classList\.toggle\("dark",\s*isDark\);/u,
  );
  assert.match(
    settingsHtml,
    /document\.body\?\.classList\.toggle\("dark",\s*isDark\);/u,
  );
});

test("settings applies its theme before painting the page content", () => {
  assert.match(settingsHtml, /<head>[\s\S]*?\n\s+applySettingsTheme\(\);\s*<\/script>[\s\S]*?<\/head>/u);
  assert.match(settingsHtml, /<body class="frost-settings">\s*<script>applySettingsTheme\(\);<\/script>/u);
});
