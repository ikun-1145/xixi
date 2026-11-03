import fs from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSingleModuleBundle,
  readLivePaymentBaseline,
  comparePaymentBaseline,
} from "./payment-release-preflight.mjs";

const accountId = "a".repeat(32);
const token = "test-read-token-dont-print";
const protectedValue = "SENSITIVE_SHOULD_NEVER_BE_PRINTED";
const baseline = JSON.parse(fs.readFileSync(
  new URL("../../docs/reliability/payment-worker-production-baseline-2026-11-03.json", import.meta.url),
  "utf8",
));

function multipart(source) {
  const marker = "--cloudflare-test-boundary-123456";
  return marker + '\r\nContent-Disposition: form-data; name="worker.js"\r\n\r\n' +
    source + "\r\n" + marker + "--\r\n";
}

function fixtureWorker(spec, overrides = {}) {
  const settings = {
    compatibility_date: spec.compatibility_date,
    observability: { logs: { enabled: true } },
    bindings: Object.entries(spec.bindings).map(([name, type]) => {
      const entry = { name, type };
      if (type === "secret_text") entry.text = protectedValue;
      if (type === "plain_text") {
        entry.text = Object.hasOwn(spec.public_flags, name)
          ? spec.public_flags[name] : protectedValue;
      }
      if (type === "service") Object.assign(entry, spec.service_bindings[name]);
      if (type === "kv_namespace") entry.namespace_id = spec.resources[name].id;
      if (type === "d1") entry.id = spec.resources[name].id;
      return entry;
    }),
    ...overrides.settings,
  };
  return {
    settings,
    schedules: overrides.schedules || spec.cron.map(cron => ({ cron })),
    deployments: overrides.deployments || {
      deployments: [{
        versions: [{version_id: spec.version_id, percentage: 100}],
      }],
    },
    source: overrides.source || "export default { fetch() { return new Response('ok'); } };",
  };
}

function testServer(fixtures = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method, "GET", "the preflight must never make write requests");
    assert.equal(init.headers.authorization, "Bearer " + token);
    const marker = "/workers/scripts/";
    assert.ok(url.startsWith("https://api.cloudflare.com/client/v4/accounts/" + accountId + marker));
    const path = url.split(marker)[1];
    const name = path.split("/")[0];
    const spec = baseline.workers.find(w => w.name === name);
    assert.ok(spec, "only preapproved Workers are fetched");
    const fixture = fixtureWorker(spec, fixtures[name]);
    let result;
    if (path.endsWith("/settings")) result = fixture.settings;
    else if (path.endsWith("/schedules")) result = fixture.schedules;
    else if (path.includes("/deployments")) result = fixture.deployments;
    else if (path === name) return new Response(multipart(fixture.source));
    else assert.fail("Unexpected endpoint " + path);
    return Response.json({ success: true, result });
  };
  return { calls, fetchImpl };
}

test("extracts only one explicit worker.js multipart payload", () => {
  const source = "export default { fetch(){ return new Response('ok'); } };\n";
  assert.equal(extractSingleModuleBundle(multipart(source)), source);
  assert.throws(() => extractSingleModuleBundle("plain source"), /format/);
  assert.throws(() => extractSingleModuleBundle(multipart(source).replace("worker.js", "other.js")), /entrypoint/);
  assert.throws(() => extractSingleModuleBundle(multipart(source) + "garbage"), /multipart/);
  assert.throws(() => extractSingleModuleBundle(
    multipart(source).replace("export default", "--cloudflare-test-boundary-123456\r\nexport default")
  ), /Ambiguous/);
});

test("obtains only sanitized read-only metadata, no secret or ordinary plain-text values", async () => {
  const server = testServer();
  const actual = await readLivePaymentBaseline({
    accountId, apiToken: token, fetchImpl: server.fetchImpl, workerSpecs: baseline.workers,
  });
  assert.equal(server.calls.length, 8);
  assert.equal(actual.workers.length, 2);
  for (const item of actual.workers) {
    assert.equal(item.version_id, baseline.workers.find(w => w.name === item.name).version_id);
    assert.match(item.bundle_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(item.public_flags, baseline.workers.find(w => w.name === item.name).public_flags);
    assert.equal(Object.keys(item.bindings).length, Object.keys(baseline.workers.find(w => w.name === item.name).bindings).length);
  }
  assert.doesNotMatch(JSON.stringify(actual), /SENSITIVE_SHOULD_NEVER_BE_PRINTED|test-read-token/);
  assert.ok(server.calls.every(x => x.init.method === "GET"));
});

test("only exact reviewed version, bundle, binding metadata, schedule and flags pass", async () => {
  const server = testServer();
  const live = await readLivePaymentBaseline({
    accountId, apiToken: token, fetchImpl: server.fetchImpl, workerSpecs: baseline.workers,
  });
  const expected = structuredClone(baseline);
  for (const w of expected.workers) {
    const source = fixtureWorker(w).source;
    w.bundle_sha256 = createHash("sha256").update(source).digest("hex");
  }
  assert.deepEqual(comparePaymentBaseline(expected, live), []);
  const alterations = [
    ["bundle_sha256", "f".repeat(64)],
    ["version_id", "different-version"],
    ["compatibility_date", "2020-01-01"],
    ["cron", ["* * * * *"]],
    ["observability", { logs_enabled: false }],
    ["bindings", {ADMIN_TOKEN: "plain_text"}],
    ["public_flags", {WAFFO_PRODUCTION_ENABLED: "false"}],
    ["service_bindings", {}],
    ["resources", {}],
  ];
  for (const [field, value] of alterations) {
    const changed = structuredClone(expected);
    changed.workers[0][field] = value;
    assert.ok(comparePaymentBaseline(changed, live).some(s => s.includes(field)), "must block on " + field);
  }
});

test("refuses missing tokens, malformed accounts and non-GET URL failures without leaking response", async () => {
  await assert.rejects(readLivePaymentBaseline({accountId, apiToken:""}), /API_TOKEN/);
  await assert.rejects(readLivePaymentBaseline({accountId:"invalid", apiToken:token}), /ACCOUNT_ID/);
  await assert.rejects(readLivePaymentBaseline({
    accountId, apiToken:token, workerSpecs:baseline.workers,
    fetchImpl: async (_url, init) => {
      assert.equal(init.method, "GET");
      return new Response("SECRET: " + protectedValue, {status:403});
    },
  }), error => /HTTP 403/.test(error.message) && !error.message.includes(protectedValue));
});

test("preflight refuses split traffic, missing bindings and unexpected resource values", async () => {
  const broken = {
    afdianpay: { deployments: {deployments:[{
      versions:[
        {version_id:baseline.workers[0].version_id, percentage:75},
        {version_id:"other", percentage:25},
      ],
    }]} },
  };
  const server = testServer(broken);
  await assert.rejects(readLivePaymentBaseline({
    accountId, apiToken:token, fetchImpl:server.fetchImpl, workerSpecs:baseline.workers,
  }), /split or missing/);
  assert.deepEqual(comparePaymentBaseline(
    baseline, {workers:[]}
  ).sort(), ["afdianpay: missing Worker baseline", "waffopay: missing Worker baseline", "Unexpected Worker in report"].sort());
});

test("stored baseline contains only fixed non-secret identifiers and safe flags", () => {
  assert.deepEqual(baseline.workers.map(x => x.name), ["afdianpay","waffopay"]);
  assert.equal(baseline.workers[0].public_flags.AFDIAN_ROLLOUT_DIAGNOSTICS_ONLY, "false");
  assert.equal(baseline.workers[1].public_flags.WAFFO_ENVIRONMENT, "test");
  assert.equal(baseline.workers[1].public_flags.WAFFO_PRODUCTION_ENABLED, "true");
  assert.equal(baseline.workers[1].public_flags.WAFFO_PRODUCTION_ENTITLEMENT_ENABLED, "true");
  assert.deepEqual(baseline.workers[0].cron, ["*/2 * * * *"]);
  assert.deepEqual(baseline.workers[1].cron, ["*/5 * * * *"]);
  for (const w of baseline.workers) {
    assert.match(w.bundle_sha256, /^[a-f0-9]{64}$/);
    assert.equal(w.compatibility_date, "2026-09-05");
  }
  assert.doesNotMatch(JSON.stringify(baseline), /BEGIN PRIVATE KEY|supabase_role_key_value|api_token_value/i);
});
