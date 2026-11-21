import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (!['public', 'private-worker'].includes(mode)) throw Error('Expected public or private-worker');

const privateFiles = new Set([
  'phone-controlled-release.test.mjs',
  'phone-standalone.test.mjs',
  'phone-worker-build.test.mjs',
  'phone-worker-integration.test.mjs',
]);
const files = readdirSync(new URL('../tests/', import.meta.url)).filter(name => name.endsWith('.test.mjs'));
for (const name of privateFiles) {
  if (!files.includes(name)) throw Error(`Missing private Worker test file: ${name}`);
}
const selected = files.filter(name => privateFiles.has(name) === (mode === 'private-worker'));
if (!selected.length) throw Error(`No ${mode} test files selected`);
console.log(`Running ${selected.length} ${mode} test files; the two suites together cover npm test.`);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...selected.map(name => `tests/${name}`)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
