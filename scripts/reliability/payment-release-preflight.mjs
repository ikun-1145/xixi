/**
 * Cloudflare payment Workers release preflight, READ ONLY.
 * Compares current deployed scripts, binding NAMES/TYPES and schedules against
 * a reviewed historical baseline. It is NOT a deploy/rebuild operation.
 *
 * Requires explicit read-only Cloudflare token in environment variables.
 * No raw source, secret values or API responses are persisted or printed.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const BASELINE_FILE = new URL(
  "../../docs/reliability/payment-worker-production-baseline-2026-11-03.json",
  import.meta.url,
);
const WORKER_NAMES = Object.freeze(["afdianpay", "waffopay"]);
const API_ROOT = "https://api.cloudflare.com/client/v4/accounts/";

function validateAccountId(accountId) {
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");
  }
  return accountId;
}

export function extractSingleModuleBundle(payload) {
  if (typeof payload !== "string" || !payload.startsWith("--")) {
    throw new Error("Unexpected Cloudflare Worker bundle format");
  }
  const firstEnd = payload.indexOf("\r\n");
  const headerEnd = payload.indexOf("\r\n\r\n");
  if (firstEnd < 3 || firstEnd > 160 || headerEnd < firstEnd) {
    throw new Error("Invalid Worker multipart headers");
  }
  const boundary = payload.slice(0, firstEnd);
  if (!/^--[a-zA-Z0-9_-]{12,155}$/.test(boundary)) {
    throw new Error("Invalid Worker multipart boundary");
  }
  const bodyStart = headerEnd + 4;
  const ending = "\r\n" + boundary + "--";
  const endAt = payload.lastIndexOf(ending);
  if (endAt <= bodyStart ||
      payload.indexOf("\r\n" + boundary + "\r\n", bodyStart) !== -1 ||
      payload.slice(endAt + ending.length).trim() !== "") {
    throw new Error("Ambiguous Worker multipart bundle");
  }
  const headerText = payload.slice(firstEnd + 2, headerEnd);
  if (!/Content-Disposition:\s*form-data;\s*name="worker\.js"/i.test(headerText)) {
    throw new Error("Unexpected Worker script entrypoint");
  }
  return payload.slice(bodyStart, endAt);
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function equality(a, b) {
  return JSON.stringify(sortedObject(a)) === JSON.stringify(sortedObject(b));
}

function sanitizeSettings(settings, allowlistedFlagNames) {
  if (!settings || !Array.isArray(settings.bindings)) {
    throw new Error("Invalid Worker settings response");
  }
  const bindings = {};
  const publicFlags = {};
  const services = {};
  const resources = {};
  for (const binding of settings.bindings) {
    if (typeof binding?.name !== "string" || typeof binding?.type !== "string") {
      throw new Error("Malformed Worker binding");
    }
    if (Object.hasOwn(bindings, binding.name)) throw new Error("Duplicate Worker binding");
    bindings[binding.name] = binding.type;
    // Never extract or display secret_text values, or ordinary plain_text values.
    if (allowlistedFlagNames.includes(binding.name) && binding.type === "plain_text") {
      publicFlags[binding.name] = binding.text;
    }
    if (binding.type === "service") {
      services[binding.name] = {
        service: binding.service,
        environment: binding.environment,
      };
    }
    if (binding.type === "kv_namespace" || binding.type === "d1") {
      resources[binding.name] = {
        type: binding.type,
        id: binding.type === "kv_namespace" ? binding.namespace_id : binding.id,
      };
    }
  }
  return {
    compatibility_date: settings.compatibility_date,
    observability: { logs_enabled: settings.observability?.logs?.enabled === true },
    bindings,
    public_flags: publicFlags,
    service_bindings: services,
    resources,
  };
}

async function readSafeResponse(fetchImpl, token, accountId, endpoint, outputType) {
  const path = API_ROOT + accountId + "/workers/scripts/" + endpoint;
  let response;
  try {
    response = await fetchImpl(path, {
      method: "GET",
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Cloudflare read-only check failed");
  }
  if (!response || !response.ok) {
    throw new Error("Cloudflare read-only check returned HTTP " + (response?.status ?? "unknown"));
  }
  try {
    if (outputType === "script") return await response.text();
    const json = await response.json();
    if (json?.success !== true || json.result === undefined) {
      throw new Error("Invalid Cloudflare response");
    }
    return json.result;
  } catch {
    throw new Error("Could not parse Cloudflare read-only check");
  }
}

export async function readLivePaymentBaseline({
  accountId,
  apiToken,
  fetchImpl = globalThis.fetch,
  workerSpecs = null,
}) {
  validateAccountId(accountId);
  if (typeof apiToken !== "string" || apiToken.trim().length === 0) {
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  }
  if (typeof fetchImpl !== "function") throw new Error("Fetch unavailable");
  const specs = workerSpecs || JSON.parse(readFileSync(BASELINE_FILE, "utf8")).workers;
  const workers = [];
  for (const spec of specs) {
    if (!WORKER_NAMES.includes(spec.name)) throw new Error("Unexpected Worker name");
    const name = spec.name;
    const [settings, schedules, deployments, raw] = await Promise.all([
      readSafeResponse(fetchImpl, apiToken, accountId, name + "/settings", "json"),
      readSafeResponse(fetchImpl, apiToken, accountId, name + "/schedules", "json"),
      readSafeResponse(fetchImpl, apiToken, accountId, name + "/deployments?page=1&per_page=1", "json"),
      readSafeResponse(fetchImpl, apiToken, accountId, name, "script"),
    ]);
    const active = deployments?.deployments?.[0];
    const versions = active?.versions;
    if (!Array.isArray(versions) || versions.length !== 1 ||
        versions[0].percentage !== 100) {
      throw new Error("Unsupported split or missing Worker deployment: " + name);
    }
    const rawSchedules = Array.isArray(schedules) ? schedules : schedules?.schedules;
    if (!Array.isArray(rawSchedules)) throw new Error("Invalid Worker schedules: " + name);
    const sanitized = sanitizeSettings(settings, Object.keys(spec.public_flags || {}));
    workers.push({
      name,
      version_id: versions[0].version_id,
      bundle_sha256: createHash("sha256")
        .update(extractSingleModuleBundle(raw), "utf8").digest("hex"),
      compatibility_date: sanitized.compatibility_date,
      cron: rawSchedules.map(item => typeof item === "string" ? item : item?.cron).sort(),
      observability: sanitized.observability,
      bindings: sanitized.bindings,
      public_flags: sanitized.public_flags,
      service_bindings: sanitized.service_bindings,
      resources: sanitized.resources,
    });
  }
  return { workers };
}

export function comparePaymentBaseline(expected, actual) {
  const failures = [];
  if (!expected || !Array.isArray(expected.workers) ||
      !actual || !Array.isArray(actual.workers)) {
    return ["Invalid baseline report"];
  }
  const fields = [
    "version_id", "bundle_sha256", "compatibility_date", "cron",
    "observability", "bindings", "public_flags", "service_bindings", "resources",
  ];
  for (const name of WORKER_NAMES) {
    const a = expected.workers.find(w => w.name === name);
    const b = actual.workers.find(w => w.name === name);
    if (!a || !b) {
      failures.push(name + ": missing Worker baseline");
      continue;
    }
    for (const key of fields) {
      const equal = Array.isArray(a[key])
        ? JSON.stringify([...a[key]].sort()) === JSON.stringify([...(b[key] || [])].sort())
        : typeof a[key] === "object" && a[key] !== null
          ? equality(a[key], b[key])
          : a[key] === b[key];
      if (!equal) failures.push(name + ": " + key + " differs from reviewed production");
    }
  }
  if (actual.workers.length !== WORKER_NAMES.length) failures.push("Unexpected Worker in report");
  return failures;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length) throw new Error("Usage: node scripts/reliability/payment-release-preflight.mjs");
  const expected = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const actual = await readLivePaymentBaseline({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    workerSpecs: expected.workers,
  });
  const failures = comparePaymentBaseline(expected, actual);
  for (const worker of actual.workers) {
    process.stdout.write(worker.name + ": verified deployed fingerprint prefix " +
      worker.bundle_sha256.slice(0, 16) + "\n");
  }
  if (failures.length) {
    for (const failure of failures) process.stderr.write("[BLOCKED] " + failure + "\n");
    process.exitCode = 2;
    return;
  }
  process.stdout.write("PASS: deployed production payment Workers match the reviewed baseline.\n");
  process.stdout.write("This does NOT validate new candidate builds or authorize deployment.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write("[BLOCKED] Payment read-only preflight: " + error.message + "\n");
    process.exitCode = 2;
  });
}
