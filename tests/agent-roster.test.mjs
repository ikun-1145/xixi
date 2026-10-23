import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('A Team roster rejects inactive dispatch, damaged state and implicit replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'sunland-roster-'));
  try {
    for (const path of ['.agent-sync', '.codex/agents', '.agents/skills']) {
      cpSync(new URL(`../${path}`, import.meta.url), join(root, path), { recursive: true });
    }
    const run = (...args) => spawnSync('python3', ['scripts/roster.py', '--root', root, ...args], { encoding: 'utf8' });
    assert.equal(run('verify').status, 0);
    assert.equal(run('check', 'Agent', 'architect').status, 0);
    assert.equal(run('check', 'Agent', 'a-team:unlisted').status, 2);
    assert.equal(run('init', '--agents', 'orchestrator', '--skills', 'using-a-team,verification-before-completion').status, 2);
    const path = join(root, '.agent-sync/TEAM.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('Roster-ID:', 'Broken-ID:'));
    assert.equal(run('verify').status, 2);
    assert.equal(run('check', 'Agent', 'architect').status, 2);
    rmSync(join(root, '.agent-sync/TEAM.md'));
    rmSync(join(root, '.agent-sync/ROUTING.md'));
    const race = spawnSync('python3', ['-B', '-c', `
import sys
from pathlib import Path
sys.path.insert(0, 'scripts')
import roster
root = Path(sys.argv[1])
original = Path.open
def concurrent_open(path, mode='r', *args, **kwargs):
    if path.name == 'TEAM.md' and mode == 'x':
        with original(path, 'w') as handle: handle.write('concurrent owner')
    return original(path, mode, *args, **kwargs)
Path.open = concurrent_open
try:
    roster.create(root, {'orchestrator'}, {'using-a-team', 'verification-before-completion'})
    raise AssertionError('must reject concurrent creation')
except FileExistsError: pass
assert (root / '.agent-sync/TEAM.md').read_text() == 'concurrent owner'
`, root], { encoding: 'utf8' });
    assert.equal(race.status, 0, race.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
