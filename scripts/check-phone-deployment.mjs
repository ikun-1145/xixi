import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export const PHONE_SECRET_NAMES = ['PHONE_ALIYUN_ACCESS_KEY_ID', 'PHONE_ALIYUN_ACCESS_KEY_SECRET',
  'PHONE_AUTH_HMAC_KEY', 'PHONE_AUTH_ADMIN_TOKEN', 'PHONE_IDENTITY_LOOKUP_KEY', 'PHONE_IDENTITY_ENCRYPTION_KEYS'];
export const PHONE_VARIABLE_NAMES = ['PHONE_AUTH_HMAC_KEY_ID', 'PHONE_IDENTITY_LOOKUP_KEY_ID', 'PHONE_IDENTITY_ENCRYPTION_KEY_ID',
  'PHONE_RELEASE_MODE', 'PHONE_SMS_CANARY_PHONE_HASHES', 'PHONE_AUTH_POLICY', 'PHONE_SMS_SIGN_NAME', 'PHONE_SMS_TEMPLATE_CODE', 'PHONE_TURNSTILE_HOSTNAME'];
// Sanitized inventory only: binding names/types and explicit non-secret flags.
// This never fetches credentials and never claims that presence proves validity.
export function deploymentPreflight(configs, inventory, phoneCanary = false) {
  const errors = [];
  if (inventory.versions?.length !== 1 || inventory.versions[0].version_id !== 'f405a850-780d-483f-8942-83e1798711fe' || inventory.versions[0].percentage !== 100) errors.push('initial production version drift; stop and review');
  if (inventory.bindings?.some(b => b.name.startsWith('PHONE_') && b.enabled === true)) errors.push('production phone feature already enabled; review rollback safety');
  for (const profile of ['main', 'rollback', 'legacy-bridge']) {
    const config = configs[profile];
    if (config?.name !== 'ai' || !config.keep_vars || !config.no_bundle || config.workers_dev !== false || config.preview_urls !== false) errors.push(profile + ': origin preservation/preview contract');
    for (const flag of ['PHONE_IDENTITY_ENABLED', 'PHONE_SMS_ENABLED', 'PHONE_NEW_REGISTRATION_ENABLED']) {
      if (config?.vars?.[flag] !== 'false') errors.push(profile + ': phone must initially be closed');
    }
    if (JSON.stringify(config?.durable_objects) !== JSON.stringify(configs.main.durable_objects) ||
        JSON.stringify(config?.migrations) !== JSON.stringify(configs.main.migrations) ||
        config?.durable_objects?.bindings?.[0]?.class_name !== 'PhoneAuthCoordinator') errors.push(profile + ': DO rollback contract');
    for (const name of ['CODE_STORE', 'USAGE_KV']) {
      const expected = inventory.bindings?.find(b => b.name === name);
      const local = config?.kv_namespaces?.find(b => b.binding === name);
      if (!expected || !local || expected.namespace_id !== local.id) errors.push(profile + ': existing KV binding mismatch: ' + name);
    }
    if (!config?.triggers?.crons?.includes('*/5 * * * *')) errors.push(profile + ': existing cron missing');
  }
  if (configs.gateway?.routes?.length || configs.gateway?.workers_dev !== false || configs.gateway?.preview_urls !== false) errors.push('gateway must be staged without routes');
  const present = new Set(inventory.bindings?.map(b => b.name));
  const required = phoneCanary ? [...PHONE_SECRET_NAMES, ...PHONE_VARIABLE_NAMES, 'TURNSTILE_SECRET'] : [];
  const missingPhoneConfiguration = required.filter(name => !present.has(name));
  const origin = ['OTP_GATEWAY_AUTH_KEY'].filter(name => !present.has(name));
  const gateway = ['OTP_GATEWAY_ADMIN_TOKEN', 'OTP_GATEWAY_AUTH_KEY'];
  return { local_configuration_valid: errors.length === 0, errors,
    production_provisioning_required: { origin, gateway, phone_canary: missingPhoneConfiguration },
    manual_execution_gates: ['fresh live version/config inventory before deployment', 'independent high-entropy gateway keys, securely provisioned and paired',
      'legacy termination evidence referenced by approved operator; never fabricate UNKNOWN=0',
      ...(phoneCanary ? ['database lookup canary matches key IDs', 'authenticated fresh-ledger initialization; no reset of existing state',
        'real unit cost/budgets and canary hashes verified; new registration remains off'] : [])],
    scope: 'names/configuration only; does not verify secret values, live SMS or production initialization' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, inventoryFile] = process.argv.slice(2);
  if (!directory || !inventoryFile) throw Error('Usage: check-phone-deployment.mjs release-directory sanitized-inventory.json [--phone-canary]');
  const configs = {};
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    if (createHash('sha256').update(await readFile(resolve(directory, name + '.mjs'))).digest('hex') !== expected) throw Error('Release bundle digest mismatch');
  }
  for (const name of ['main', 'rollback', 'legacy-bridge', 'gateway']) configs[name] = JSON.parse(await readFile(resolve(directory, name + '.json'), 'utf8'));
  for (const [name, expected] of Object.entries(manifest.configurationSha256)) {
    if (createHash('sha256').update(await readFile(resolve(directory, name + '.json'))).digest('hex') !== expected) throw Error('Release configuration digest mismatch');
  }
  const result = deploymentPreflight(configs, JSON.parse(await readFile(inventoryFile, 'utf8')), process.argv.includes('--phone-canary'));
  console.log(JSON.stringify(result, null, 2));
  if (!result.local_configuration_valid) process.exitCode = 1;
}
