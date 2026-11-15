/**
 * No-network smoke execution against Wrangler --dry-run candidate bundles.
 *
 * This is Node 22 / bundled-module smoke, NOT a workerd integration test.
 * Requests target missing routes only. No real payment/API/database bindings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

export async function smokeBundledPaymentHandlers(root) {
  if (typeof root !== "string" || root.length === 0) throw new Error("Bundle directory required");
  const sandbox = mkdtempSync(resolve(tmpdir(), "payment-smoke-"));
  const originalFetch = globalThis.fetch;
  const log = console.log;
  const error = console.error;
  const detected = [];
  try {
    // Any unexpected outbound request fails immediately. No production API
    // addresses, credentials or database bindings are injected.
    globalThis.fetch = async () => { throw new Error("OUTBOUND_NETWORK_FORBIDDEN"); };
    writeFileSync(resolve(sandbox, "package.json"), '{"type":"module"}\n');
    for (const name of ["afdianpay", "waffopay"]) {
      const source = resolve(root, name, "candidate", "worker.js");
      const dest = resolve(sandbox, name + ".mjs");
      copyFileSync(source, dest);
      const workerModule = await import(pathToFileURL(dest).href);
      assert.equal(typeof workerModule.default?.fetch, "function");
      const result = await workerModule.default.fetch(
        new Request("https://example.invalid/__ci_missing_route__", {method:"GET"}), {},
      );
      assert.ok(result instanceof Response);
      assert.equal(result.status, 404, name + " unknown route must stay 404");
      detected.push({name, unknownRouteStatus:result.status});
      if (name === "waffopay") {
        const messages = [];
        const promises = [];
        console.log = line => messages.push(String(line));
        console.error = () => { throw new Error("UNEXPECTED_WAFFO_ERROR_LOG"); };
        try {
          await workerModule.default.scheduled(
            {cron:"*/5 * * * *",scheduledTime:0}, {},
            {waitUntil(p) {promises.push(p);}},
          );
          assert.equal(promises.length,1);
          await Promise.all(promises);
        } finally {
          console.log = log;
          console.error = error;
        }
        assert.equal(messages.length,1);
        assert.deepEqual(JSON.parse(messages[0]), {
          event:"waffo_production_outbox_cycle",
          status:"disabled", due:0, processed:0, failed:0, unbound:0,
        });
        detected[detected.length - 1].unconfiguredCron = "disabled";
      }
    }
    return detected;
  } finally {
    globalThis.fetch = originalFetch;
    console.log = log;
    console.error = error;
    rmSync(sandbox,{recursive:true,force:true});
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error("Expected the Wrangler output root");
  const results = await smokeBundledPaymentHandlers(argv[0]);
  for (const item of results) {
    process.stdout.write("PASS " + item.name + " compiled module missing-route HTTP " +
      item.unknownRouteStatus +
      (item.unconfiguredCron ? ", unconfigured Cron=" + item.unconfiguredCron : "") + "\n");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    // Bounded diagnostics without leaking full stack traces, URLs or sources.
    const message = error?.code === "ERR_MODULE_NOT_FOUND" ? "bundled module import missing" :
      error?.message === "OUTBOUND_NETWORK_FORBIDDEN" ? "unexpected outbound request" :
      "offline bundled smoke test failed";
    process.stderr.write("BLOCKED: " + message + "\n");
    process.exitCode = 2;
  });
}
