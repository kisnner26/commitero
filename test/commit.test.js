import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo } from './helpers.js';
import { applyPlan, validatePlan, undoBatch, undoStatus } from '../src/commit.js';
import { changes } from '../src/git.js';
import { buildState } from '../src/state.js';

const lines = (run, ...a) => run(...a).trim().split('\n').filter(Boolean);

test('crea un commit por grupo con exactamente sus archivos', async () => {
  const r = makeRepo();
  try {
    r.write('Sources/Wardrobe.swift', 'a\n'); r.write('Sources/WardrobeSelfTest.swift', 'b\n'); r.write('docs/NOTAS.md', 'c\n');
    const res = await applyPlan(r.dir, [
      { message: 'feat: añade wardrobe', files: ['Sources/Wardrobe.swift', 'Sources/WardrobeSelfTest.swift'] },
      { message: 'docs: añade notas', files: ['docs/NOTAS.md'] },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.commits.length, 2);
    assert.deepEqual(lines(r.run, 'log', '--pretty=%s', '-3'), ['docs: añade notas', 'feat: añade wardrobe', 'chore: base']);
    assert.deepEqual(lines(r.run, 'show', '--name-only', '--pretty=', 'HEAD~1').sort(), ['Sources/Wardrobe.swift', 'Sources/WardrobeSelfTest.swift']);
    assert.deepEqual(lines(r.run, 'show', '--name-only', '--pretty=', 'HEAD'), ['docs/NOTAS.md']);
    assert.equal(r.run('status', '--porcelain').trim(), '');
  } finally { r.cleanup(); }
});

test('los commits usan el autor configurado y nunca llevan atribucion', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n');
    await applyPlan(r.dir, [{ message: 'feat: añade a', files: ['a.txt'] }]);
    assert.equal(r.run('log', '-1', '--pretty=%an <%ae>').trim(), 'tester <tester@example.com>');
    assert.equal(/co-authored|anthropic|claude/i.test(r.run('log', '-1', '--pretty=%B')), false);
  } finally { r.cleanup(); }
});

test('un mensaje con atribucion bloquea todo el plan antes de tocar nada', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n'); r.write('b.txt', '2\n');
    const before = r.run('rev-parse', 'HEAD');
    const res = await applyPlan(r.dir, [
      { message: 'feat: añade a', files: ['a.txt'] },
      { message: 'feat: añade b\n\nCo-authored-by: Claude <noreply@anthropic.com>', files: ['b.txt'] },
    ]);
    assert.equal(res.ok, false);
    assert.match(res.error, /grupo 2/);
    assert.equal(r.run('rev-parse', 'HEAD'), before);
    assert.equal(r.run('diff', '--cached', '--name-only').trim(), '');
  } finally { r.cleanup(); }
});

test('rechaza rutas peligrosas, archivos sin cambios y archivos repetidos', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n');
    for (const files of [['../fuera.txt'], ['/etc/passwd'], ['--all'], ['no-existe.txt']]) {
      const v = await validatePlan(r.dir, [{ message: 'feat: x', files }]);
      assert.equal(v.ok, false, files[0]);
    }
    const dup = await validatePlan(r.dir, [{ message: 'feat: x', files: ['a.txt'] }, { message: 'feat: y', files: ['a.txt'] }]);
    assert.equal(dup.ok, false);
    assert.match(dup.errors.join(' '), /otro grupo/);
  } finally { r.cleanup(); }
});

test('no actua si ya hay cambios en el indice', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n'); r.write('b.txt', '2\n');
    r.run('add', 'a.txt');
    const res = await applyPlan(r.dir, [{ message: 'feat: añade b', files: ['b.txt'] }]);
    assert.equal(res.ok, false);
    assert.match(res.error, /indice/);
    assert.equal(r.run('diff', '--cached', '--name-only').trim(), 'a.txt');
  } finally { r.cleanup(); }
});

test('no actua durante un merge o rebase', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n');
    execFileSync('touch', [join(r.dir, '.git', 'MERGE_HEAD')]);
    const v = await validatePlan(r.dir, [{ message: 'feat: x', files: ['a.txt'] }]);
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /operacion de git en curso/);
  } finally { r.cleanup(); }
});

test('maneja borrados y renombrados', async () => {
  const r = makeRepo();
  try {
    r.write('viejo.txt', 'x\n'); r.run('add', '.'); r.run('commit', '-q', '-m', 'chore: viejo');
    r.run('rm', '-q', '--cached', 'viejo.txt'); execFileSync('rm', [join(r.dir, 'viejo.txt')]); r.run('reset', '-q');
    const { files } = await changes(r.dir);
    assert.equal(files.find((f) => f.path === 'viejo.txt').status, 'D');
    const res = await applyPlan(r.dir, [{ message: 'chore: quita viejo', files: ['viejo.txt'] }]);
    assert.equal(res.ok, true);
    assert.equal(existsSync(join(r.dir, 'viejo.txt')), false);
    assert.equal(r.run('ls-files', 'viejo.txt').trim(), '');
  } finally { r.cleanup(); }
});

test('si un commit falla, los anteriores quedan y el indice queda limpio', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n'); r.write('b.txt', '2\n');
    // un hook que rechaza el segundo commit
    const hook = join(r.dir, '.git', 'hooks', 'commit-msg');
    execFileSync('sh', ['-c', `printf '#!/bin/sh\\ngrep -q "segundo" "$1" && exit 1\\nexit 0\\n' > "${hook}" && chmod +x "${hook}"`]);
    const res = await applyPlan(r.dir, [{ message: 'feat: primero', files: ['a.txt'] }, { message: 'feat: segundo', files: ['b.txt'] }]);
    assert.equal(res.ok, false);
    assert.equal(res.commits.length, 1);
    assert.match(res.error, /grupo 2/);
    assert.equal(r.run('log', '-1', '--pretty=%s').trim(), 'feat: primero');
    assert.equal(r.run('diff', '--cached', '--name-only').trim(), '');
    assert.equal(readFileSync(join(r.dir, 'b.txt'), 'utf8'), '2\n');
  } finally { r.cleanup(); }
});

test('deshacer el lote devuelve los archivos sin commitear y sin perder contenido', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', 'uno\n'); r.write('b.txt', 'dos\n');
    const base = r.run('rev-parse', 'HEAD');
    await applyPlan(r.dir, [{ message: 'feat: a', files: ['a.txt'] }, { message: 'feat: b', files: ['b.txt'] }]);
    assert.equal((await undoStatus(r.dir)).canUndo, true);
    const res = await undoBatch(r.dir);
    assert.deepEqual(res, { ok: true, undone: 2 });
    assert.equal(r.run('rev-parse', 'HEAD'), base);
    assert.equal(readFileSync(join(r.dir, 'a.txt'), 'utf8'), 'uno\n');
    assert.equal(readFileSync(join(r.dir, 'b.txt'), 'utf8'), 'dos\n');
    assert.equal(r.run('status', '--porcelain').trim().split('\n').length, 2);
    assert.equal((await undoStatus(r.dir)).canUndo, false);
  } finally { r.cleanup(); }
});

test('no deshace si HEAD cambio despues del lote', async () => {
  const r = makeRepo();
  try {
    r.write('a.txt', '1\n');
    await applyPlan(r.dir, [{ message: 'feat: a', files: ['a.txt'] }]);
    r.write('b.txt', '2\n'); r.run('add', '.'); r.run('commit', '-q', '-m', 'feat: otro commit tuyo');
    const res = await undoBatch(r.dir);
    assert.equal(res.ok, false);
    assert.match(res.error, /HEAD/);
  } finally { r.cleanup(); }
});

test('no deshace un lote que ya esta en el remoto', async () => {
  const r = makeRepo();
  // un remoto real y vacio: un repositorio bare
  const remoteDir = mkdtempSync(join(tmpdir(), 'commitero-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir]);
  try {
    r.run('remote', 'add', 'origin', remoteDir);
    r.run('push', '-q', '-u', 'origin', 'main');
    r.write('a.txt', '1\n');
    await applyPlan(r.dir, [{ message: 'feat: a', files: ['a.txt'] }]);
    assert.equal((await undoStatus(r.dir)).canUndo, true);
    r.run('push', '-q');
    const st = await undoStatus(r.dir);
    assert.equal(st.canUndo, false);
    assert.match(st.reason, /remoto/);
  } finally { r.cleanup(); rmSync(remoteDir, { recursive: true, force: true }); }
});

test('el estado propone grupos, marca secretos y excluye sensibles', async () => {
  const r = makeRepo();
  try {
    r.write('Sources/Sound.swift', 'x\n'); r.write('Sources/SoundSelfTest.swift', 'y\n');
    r.write('.env', 'API_KEY=abc\n'); r.write('cfg.js', 'const k = "AKIAABCDEFGHIJKLMNOP";\n');
    r.write('node_modules/x/i.js', 'z\n');
    const s = await buildState(r.dir);
    assert.equal(s.ok, true);
    assert.equal(s.branch, 'main');
    assert.equal(s.clean, false);
    const sound = s.groups.find((g) => g.label === 'sound');
    assert.equal(sound.files.length, 2);
    const env = s.groups.flatMap((g) => g.files).find((f) => f.path === '.env');
    assert.equal(env.included, false);
    const cfg = s.groups.flatMap((g) => g.files).find((f) => f.path === 'cfg.js');
    assert.equal(cfg.included, false);
    assert.ok(cfg.warnings[0].includes('posible secreto'));
    assert.ok(s.ignorable.some((f) => f.path === 'node_modules/x/i.js'));
    assert.equal(JSON.stringify(s).includes('ABCDEFGHIJKLMNOP'), false);
  } finally { r.cleanup(); }
});

test('una carpeta que no es repositorio devuelve un error claro', async () => {
  const s = await buildState('/tmp');
  assert.equal(s.ok, false);
  assert.match(s.error, /repositorio/);
});
