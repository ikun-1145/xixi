import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
export const BASELINE = 'bc5489b';
export const BASELINE_NORMALIZED_SHA = '73217b53fa4f0424ee31634000ebbc74e046cb41408290fa8ce7897ab592d645';
const helpers = ['getUserFromRequest', 'getUserStatus', 'accountStatusRejection', 'applicationSigningSecret', 'signJWT', 'callIdentityRpc', 'readJsonBodyWithLimit', 'json', 'createEmailOtp'];
function once(text, marker) {
  if (text.split(marker).length !== 2) throw Error('Baseline patch anchor changed');
  return text.indexOf(marker);
}
function between(text, start, end) { return text.slice(once(text, start), once(text, end)); }
export function patchOtp(baseline, latest) {
  // Exact frozen sources plus four bounded edits; no whole-fetch replacement.
  let code = baseline;
  for (const [start, end] of [
    ['    const body = parsedBody.value;', '    if (url.pathname === "/v1/account/identity")'],
    ['    async function verifyGeeTest(token)', '    if (url.pathname === "/send-code")'],
    ['    if (url.pathname === "/send-code")', '    } else if (url.pathname === "/refresh")'],
  ]) code = code.replace(between(code, start, end), between(latest, start, end));
  const marker = '        await runChatMaintenance({'; once(code, marker);
  code = code.replace(marker, "        const otpCleanup = await callIdentityRpc(env, 'sunland_otp_cleanup', {});\n        if (!otpCleanup.ok) console.error('[OTP_CLEANUP_UNAVAILABLE]');\n" + marker);
  return code;
}
export async function buildControlledRelease({ workerRoot = process.env.SUNLAND_AUTH_WORKER_ROOT || resolve(project, '../../sunland_ai_app/worker') } = {}) {
  workerRoot = resolve(workerRoot);
  const esbuild = createRequire(resolve(workerRoot, 'package.json'))('esbuild');
  const git = path => execFileSync('git', ['-C', workerRoot, 'show', `${BASELINE}:worker/${path}`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const pin = JSON.parse(await readFile(resolve(project, 'workers/phone-auth/source-provenance.json'), 'utf8'));
  const latest = await readFile(resolve(workerRoot, 'src/index.js'), 'utf8');
  const email = await readFile(resolve(workerRoot, 'src/email-otp.js'), 'utf8');
  for (const [name, source] of [['src/index.js', latest], ['src/email-otp.js', email]]) {
    if (sha(source) !== pin.files[name]) throw Error('Reviewed OTP source changed');
  }
  const inputs = {};
  const baselinePlugin = patched => ({ name: 'frozen-production-baseline', setup(build) {
    build.onResolve({ filter: /^sunland-controlled-baseline$/ }, () => ({ path: resolve(workerRoot, 'src/index.js') }));
    build.onResolve({ filter: /^sunland-controlled-email$/ }, () => ({ path: 'email', namespace: 'controlled' }));
    build.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: email, loader: 'js' }));
    build.onLoad({ filter: /\.js$/ }, args => {
      const name = relative(workerRoot, args.path);
      if (!name.startsWith('src/')) return;
      let contents = git(name); inputs[name] = sha(contents);
      if (patched !== null && name === 'src/index.js') {
        if (patched) contents = patchOtp(contents, latest);
        contents = "import { createEmailOtp } from 'sunland-controlled-email';\n" + contents + `\nexport { ${helpers.join(', ')} };\n`;
      }
      return { contents, loader: 'js', resolveDir: dirname(args.path) };
    });
  } });
  const options = { absWorkingDir: workerRoot, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', keepNames: true, logLevel: 'silent' };
  const rebuilt = await esbuild.build({ ...options, entryPoints: ['src/index.js'], plugins: [baselinePlugin(null)] });
  const normalized = (await esbuild.transform(rebuilt.outputFiles[0].text, { loader: 'js', format: 'esm', minifyWhitespace: true, legalComments: 'none', target: 'es2022' })).code;
  if (sha(normalized) !== BASELINE_NORMALIZED_SHA) throw Error('Rebuilt baseline no longer matches audited production');
  const bundles = {};
  for (const profile of ['main', 'rollback', 'legacy-bridge']) {
    const entry = `import { controlledWorker } from ${JSON.stringify(resolve(project, 'workers/phone-auth/controlled-entry.js'))};\nexport {PhoneAuthCoordinator} from ${JSON.stringify(resolve(project, 'workers/phone-auth/coordinator.js'))};\nexport default controlledWorker({fallback:${profile !== 'main'},legacy:${profile === 'legacy-bridge'}});`;
    const result = await esbuild.build({ ...options, stdin: { contents: entry, resolveDir: project, sourcefile: profile + '.js' }, plugins: [baselinePlugin(profile !== 'legacy-bridge')] });
    bundles[profile] = result.outputFiles[0].text;
  }
  bundles.gateway = (await esbuild.build({ ...options, entryPoints: [resolve(project, 'workers/phone-auth/otp-gateway.js')] })).outputFiles[0].text;
  const config = JSON.parse(git('wrangler.jsonc').replace(/^\s*\/\/[^\n]*$/gm, ''));
  delete config.env;
  config.no_bundle = true;
  config.preview_urls = false; config.vars = { ...config.vars, PHONE_IDENTITY_ENABLED: 'false', PHONE_SMS_ENABLED: 'false', PHONE_NEW_REGISTRATION_ENABLED: 'false' };
  config.durable_objects = { bindings: [{ name: 'PHONE_AUTH_COORDINATOR', class_name: 'PhoneAuthCoordinator' },
    { name: 'OTP_MAINTENANCE', class_name: 'OtpMaintenanceGate', script_name: 'sunland-otp-entry' }] };
  config.migrations = [{ tag: 'phone-auth-v1', new_sqlite_classes: ['PhoneAuthCoordinator'] }];
  const configs = {};
  for (const profile of ['main', 'rollback', 'legacy-bridge']) {
    configs[profile] = structuredClone(config); configs[profile].main = profile + '.mjs';
    configs[profile].secrets.required.push('OTP_GATEWAY_AUTH_KEY');
  }
  configs.gateway = { name: 'sunland-otp-entry', main: 'gateway.mjs', no_bundle: true, compatibility_date: '2026-03-21', workers_dev: false, preview_urls: false,
    routes: [], triggers: { crons: [] }, observability: { enabled: false },
    vars: { OTP_TEST_EMAIL: '', OTP_TEST_IPS: '' }, secrets: { required: ['OTP_GATEWAY_ADMIN_TOKEN', 'OTP_GATEWAY_AUTH_KEY'] },
    services: [{ binding: 'ORIGIN', service: 'ai' }], durable_objects: { bindings: [
      { name: 'OTP_MAINTENANCE', class_name: 'OtpMaintenanceGate' },
      { name: 'PHONE_AUTH_COORDINATOR', class_name: 'PhoneAuthCoordinator', script_name: 'ai' }] },
    migrations: [{ tag: 'otp-gate-v1', new_sqlite_classes: ['OtpMaintenanceGate'] }] };
  configs['gateway-stage'] = structuredClone(configs.gateway);
  configs['gateway-stage'].durable_objects.bindings = configs['gateway-stage'].durable_objects.bindings.filter(b => b.name !== 'PHONE_AUTH_COORDINATOR');
  const baselineCommit = execFileSync('git', ['-C', workerRoot, 'rev-parse', BASELINE], { encoding: 'utf8' }).trim();
  return { bundles, configs, manifest: { baselineCommit, baselineNormalizedSha256: sha(normalized), esbuildVersion: esbuild.version,
    baselineFiles: inputs, otpSourceFiles: { 'src/index.js': sha(latest), 'src/email-otp.js': sha(email) },
    excluded: ['web-search import/module and all five integration hunks', 'standalone staging/old OTP maintenance modules'],
    configurationSha256: Object.fromEntries(Object.entries(configs).map(([name, value]) => [name, sha(JSON.stringify(value, null, 2) + '\n')])),
    sha256: Object.fromEntries(Object.entries(bundles).map(([name, code]) => [name, sha(code)])) } };
}
export async function prepareControlledRelease(output) {
  if (!output?.startsWith('/')) throw Error('An absolute new output directory is required');
  const result = await buildControlledRelease();
  await mkdir(output, { mode: 0o700 });
  const files = { 'manifest.json': JSON.stringify(result.manifest, null, 2) + '\n' };
  for (const [name, code] of Object.entries(result.bundles)) files[name + '.mjs'] = code;
  for (const [name, config] of Object.entries(result.configs)) files[name + '.json'] = JSON.stringify(config, null, 2) + '\n';
  files.SHA256SUMS = Object.entries(files).map(([name, text]) => sha(text) + '  ' + name).join('\n') + '\n';
  for (const [name, code] of Object.entries(files)) await writeFile(resolve(output, name), code, { flag: 'wx', mode: 0o600 });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await prepareControlledRelease(process.argv[2]);
  console.log(JSON.stringify({ prepared: true, deployed: false, ...result.manifest }));
}
