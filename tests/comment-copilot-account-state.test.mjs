import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("real copilot handler rejects account states before service-role client, quota or AI", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sunland-copilot-account-state-"));
  const original = { Deno: globalThis.Deno, fetch: globalThis.fetch, calls: globalThis.__copilotIdentityClientCalls };
  try {
    const source = (await readFile(new URL("../supabase/functions/comment-copilot/index.ts", import.meta.url), "utf8"))
      .replace('from "https://esm.sh/@supabase/supabase-js@2"', 'from "./supabase-client.mjs"');
    await writeFile(path.join(temp, "index.ts"), source);
    await writeFile(path.join(temp, "package.json"), '{"type":"module"}');
    await writeFile(path.join(temp, "supabase-client.mjs"),
      'export function createClient() { globalThis.__copilotIdentityClientCalls++; throw Error("must not construct service client"); }');
    await writeFile(path.join(temp, "internet_context.ts"), 'export const buildContextBlock = () => "";');
    for (const name of ["trace.js", "verified-identity.js"]) {
      await cp(new URL(`../supabase/functions/comment-copilot/${name}`, import.meta.url), path.join(temp, name));
    }
    let handler;
    globalThis.Deno = { env: { get: () => null }, serve: callback => { handler = callback; } };
    await import(pathToFileURL(path.join(temp, "index.ts")).href);

    for (const action of ["generate", "status", "clear"]) {
      for (const [status, payload, expected] of [
        [403, { error: "ACCOUNT_BANNED" }, 403],
        [403, { error: "ACCOUNT_NOT_ACTIVE" }, 403],
        [503, { error: "User status unavailable" }, 503],
        [401, { error: "Unauthorized" }, 401],
        [200, { user_id: "fixture-user", identity_status: "active", is_banned: true }, 403],
        [200, { user_id: "fixture-user", identity_status: "active" }, 503],
        [200, { user_id: "fixture-user", identity_status: "deleting", is_banned: false }, 503],
      ]) {
        let identityCalls = 0;
        let externalCalls = 0;
        globalThis.__copilotIdentityClientCalls = 0;
        globalThis.fetch = async (url, init) => {
          if (url !== "https://api.sunland.dev/v1/account/identity") {
            externalCalls++;
            throw Error("must not call AI or quota service");
          }
          identityCalls++;
          assert.equal(init.headers.Authorization, "Bearer fixture-token");
          assert.equal(init.body, "{}");
          return Response.json(payload, { status });
        };
        const response = await handler(new Request("https://example.test/functions/v1/comment-copilot", {
          method: "POST", headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({ action, comment: "fixture", user_id: "victim", pro: true, operation: "account_delete", allowBanned: true }),
        }));
        assert.equal(response.status, expected, `${action}: ${JSON.stringify(payload)}`);
        assert.equal(identityCalls, 1);
        assert.equal(globalThis.__copilotIdentityClientCalls, 0);
        assert.equal(externalCalls, 0);
      }
    }
  } finally {
    globalThis.Deno = original.Deno;
    globalThis.fetch = original.fetch;
    globalThis.__copilotIdentityClientCalls = original.calls;
    await rm(temp, { recursive: true, force: true });
  }
});
