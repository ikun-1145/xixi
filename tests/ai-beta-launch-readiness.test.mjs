import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const aiHtml = fs.readFileSync(
  new URL("../ai.html", import.meta.url),
  "utf8",
);
const loginHtml = fs.readFileSync(
  new URL("../login.html", import.meta.url),
  "utf8",
);
const settingsHtml = fs.readFileSync(
  new URL("../ai_settings.html", import.meta.url),
  "utf8",
);
const appSource = fs.readFileSync(
  new URL("../ai/app.js", import.meta.url),
  "utf8",
);
const identitySource = fs.readFileSync(
  new URL("../ai/user-identity.js", import.meta.url),
  "utf8",
);
const projectRequire = createRequire(new URL("../package.json", import.meta.url));
const { JSDOM } = projectRequire("jsdom");

test("first launch provides a usable login path and creates an empty chat", () => {
  assert.match(loginHtml, /登录 Sunland AI · Beta/u);
  assert.match(loginHtml, /输入邮箱获取验证码，无需注册/u);
  assert.match(loginHtml, /for="emailInput">邮箱/u);
  assert.match(loginHtml, /for="codeInput">验证码/u);
  assert.match(loginHtml, /《用户协议》/u);
  assert.match(loginHtml, /《隐私政策》/u);
  assert.match(loginHtml, /loginBtn\.disabled = true/u);
  assert.match(
    appSource,
    /await checkLogin\(\);[\s\S]*if \(getCurrentVerifiedIdentity\(\) && !conversations\.length\) \{\s*createNewChat\(\);/u,
  );
  assert.match(aiHtml, /id="welcome"[^>]*>想聊点什么？</u);
  assert.match(aiHtml, /placeholder="有问题，尽管问"/u);
});

test("Sunland is discoverable before a conversation starts and its limits are explicit", () => {
  assert.match(aiHtml, /data-model="sunland"/u);
  assert.match(aiHtml, /aria-label="Sunland AI · Beta"/u);
  assert.match(appSource, /Sunland AI · Beta 暂不支持深度思考/u);
  assert.match(appSource, /Sunland AI · Beta 暂不支持文件上传/u);
  assert.match(
    appSource,
    /当前对话已绑定 Sunland AI。请新建对话以切换模型。/u,
  );
});

test("login, identity and request failures give a recoverable next action", () => {
  assert.match(loginHtml, /请输入邮箱/u);
  assert.match(loginHtml, /邮箱格式错误/u);
  assert.match(loginHtml, /网络连接失败（API不可达）/u);
  assert.match(loginHtml, /请求超时，请重试/u);
  assert.match(identitySource, /请重新登录后再试一下/u);
  assert.match(
    appSource,
    /Sunland AI · Beta 暂时出了点问题，请稍后重试/u,
  );
  assert.match(appSource, /请求失败（\$\{res\.status\}），请稍后重试/u);
  assert.match(appSource, /消息处理失败，请稍后重试/u);
});

test("remote AI contract and settings distinguish Knowledge from name Memory", () => {
  const providerSource = fs.readFileSync(
    new URL("../ai/providers/SunlandProvider.js", import.meta.url),
    "utf8",
  );
  const controlsSource = fs.readFileSync(
    new URL("../ai/sunland-data-controls.js", import.meta.url),
    "utf8",
  );
  const supabaseClientSource = fs.readFileSync(
    new URL("../p/js/supabaseClient.js", import.meta.url),
    "utf8",
  );
  const copilotSource = fs.readFileSync(
    new URL("../copilot.html", import.meta.url),
    "utf8",
  );

  assert.match(providerSource, /\/v1\/turns/u);
  assert.match(controlsSource, /\/v1\/knowledge/u);
  assert.match(controlsSource, /\/v1\/memory\/name/u);
  assert.doesNotMatch(providerSource, /createSunlandEngine|sunland-core\.js/u);
  for (const clientSource of [supabaseClientSource, copilotSource, settingsHtml]) {
    assert.match(clientSource, /sb_publishable_/u);
    assert.doesNotMatch(clientSource, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/u);
  }
  assert.match(settingsHtml, /姓名记忆/u);
  assert.match(settingsHtml, /只让 Sunland AI 忘记你的名字/u);
  assert.match(settingsHtml, /用户教学知识/u);
  assert.match(settingsHtml, /清除你主动教给 Sunland AI 的知识/u);
  assert.match(settingsHtml, /暂无用户教学知识|正在读取教学知识/u);
});

test("Beta Diagnostics consent and empty state remain understandable before details", () => {
  const dom = new JSDOM(settingsHtml);
  const { document } = dom.window;
  const section = document.getElementById("betaDiagnosticsSection");
  const summary = document.getElementById("betaDiagnosticsSummary");
  const body = document.getElementById("betaDiagnosticsBody");

  assert.equal(section.open, false);
  assert.match(summary.textContent, /仅本地/u);
  assert.match(summary.textContent, /默认关闭/u);
  assert.match(body.textContent, /不会自动上传/u);
  assert.match(body.textContent, /不包含对话内容、姓名、教学知识或账号标识/u);
  assert.match(body.textContent, /可以随时关闭/u);
  assert.match(body.textContent, /暂无本地诊断数据/u);
  assert.ok(
    [...body.querySelectorAll("button")].some(
      button => /导出匿名 JSON/u.test(button.textContent),
    ),
  );
  assert.ok(
    [...body.querySelectorAll("button")].some(
      button => /清除本地诊断数据/u.test(button.textContent),
    ),
  );
});
