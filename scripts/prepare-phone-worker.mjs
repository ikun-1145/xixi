import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPhoneAuthWorker } from './build-phone-auth-worker.mjs';

// Preparation only: no credentials, remote bindings, deployment or overwrite.
export async function preparePhoneWorker(output) {
  if (!output || !output.startsWith('/')) throw Error('An absolute new output directory is required');
  const build = await buildPhoneAuthWorker();
  await mkdir(output, { mode: 0o700 });
  const config = {
    name: 'sunland-phone-auth-local', main: 'worker.mjs',
    compatibility_date: '2026-03-21', workers_dev: false, preview_urls: false,
    routes: [], triggers: { crons: [] }, observability: { enabled: false },
    vars: { PHONE_IDENTITY_ENABLED: 'false', PHONE_SMS_ENABLED: 'false',
      PHONE_NEW_REGISTRATION_ENABLED: 'false', ALLOWED_ORIGIN: 'https://sunland.dev' },
    durable_objects: { bindings: [{ name: 'PHONE_AUTH_COORDINATOR', class_name: 'PhoneAuthCoordinator' }] },
    migrations: [{ tag: 'phone-auth-v1', new_sqlite_classes: ['PhoneAuthCoordinator'] }],
  };
  const manifest = { scope: 'local-only; not a production deployment configuration',
    bundle_sha256: createHash('sha256').update(build.code).digest('hex'),
    provenance: build.provenance };
  for (const [name, text] of Object.entries({ 'worker.mjs': build.code,
    'wrangler.json': JSON.stringify(config, null, 2) + '\n',
    'manifest.json': JSON.stringify(manifest, null, 2) + '\n' })) {
    await writeFile(resolve(output, name), text, { flag: 'wx', mode: 0o600 });
  }
  return { config, manifest, code: build.code };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await preparePhoneWorker(process.argv[2]);
  console.log(JSON.stringify({ prepared: true, scope: 'local-only', bundle_sha256: result.manifest.bundle_sha256 }));
}
