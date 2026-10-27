import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'commitero-'));
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'tester');
  run('config', 'user.email', 'tester@example.com');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write('README.md', '# base\n');
  run('add', '.'); run('commit', '-q', '-m', 'chore: base');
  return { dir, run, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
