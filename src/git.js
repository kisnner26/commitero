// Utilidades de git. Todo se ejecuta sin shell (argumentos como lista) y con un plazo maximo.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Ejecuta git en `repo`. Devuelve { code, out, err }. Nunca lanza por un codigo distinto de cero. */
export function git(repo, args, { timeout = 20000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['--no-optional-locks', '-c', 'core.quotepath=off', '-C', repo, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = Buffer.alloc(0), err = Buffer.alloc(0), done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out: out.toString('utf8'), err: err.toString('utf8') }); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(124); }, timeout);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err = Buffer.concat([err, d]); });
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(code ?? 1));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/** Raiz del repositorio que contiene `dir`, o null. */
export async function repoRoot(dir) {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.out.trim() : null;
}

/** Hay un merge, rebase, cherry-pick o revert en curso. */
export async function operationInProgress(repo) {
  const gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).out.trim();
  for (const f of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (existsSync(join(gitDir, f))) return f;
  }
  return null;
}

/** Rama actual y adelanto/retraso respecto de su upstream. */
export async function branchInfo(repo) {
  const r = await git(repo, ['status', '-b', '--porcelain=v2']);
  const info = { branch: '', upstream: null, ahead: 0, behind: 0, head: null };
  for (const line of r.out.split('\n')) {
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.oid ')) info.head = line.slice(13).trim() === '(initial)' ? null : line.slice(13).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { info.ahead = Number(m[1]); info.behind = Number(m[2]); }
    }
  }
  return info;
}

/**
 * Cambios del arbol de trabajo respecto de HEAD, con lineas anadidas y quitadas.
 * Devuelve { files: [{path, status, added, deleted, binary, oldPath?}], staged: [paths] }.
 * status: A (nuevo), M (modificado), D (borrado), R (renombrado), ? (sin seguimiento).
 */
export async function changes(repo) {
  const r = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = r.out.split('\0').filter((s) => s.length);
  const files = [], staged = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const x = entry[0], y = entry[1];
    let path = entry.slice(3), oldPath;
    if (x === 'R' || x === 'C') { oldPath = parts[++i]; }
    if (x !== ' ' && x !== '?') staged.push(path);
    let status = 'M';
    if (x === '?' && y === '?') status = '?';
    else if (x === 'A' || y === 'A') status = 'A';
    else if (x === 'D' || y === 'D') status = 'D';
    else if (x === 'R') status = 'R';
    files.push({ path, status, added: 0, deleted: 0, binary: false, ...(oldPath ? { oldPath } : {}) });
  }
  // numstat contra HEAD (si no hay HEAD, contra el arbol vacio)
  const hasHead = (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  const base = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const ns = await git(repo, ['diff', base, '--numstat', '-z', '--no-ext-diff', '--no-textconv']);
  const nsParts = ns.out.split('\0').filter((s) => s.length);
  for (let i = 0; i < nsParts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nsParts[i]);
    if (!m) continue;
    let p = m[3];
    if (p === '') { i += 2; p = nsParts[i]; }      // renombrado: "add\tdel\t" y luego dos rutas
    const f = files.find((x) => x.path === p);
    if (!f) continue;
    if (m[1] === '-') f.binary = true; else { f.added = Number(m[1]); f.deleted = Number(m[2]); }
  }
  // los archivos nuevos sin seguimiento cuentan sus lineas a mano
  for (const f of files.filter((x) => x.status === '?')) {
    const c = await git(repo, ['diff', '--no-index', '--numstat', '--no-ext-diff', '/dev/null', f.path]);
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(c.out);
    if (m) { if (m[1] === '-') f.binary = true; else f.added = Number(m[1]); }
  }
  return { files, staged };
}

/** Diff de un conjunto de archivos para revisarlo (recortado). Los nuevos sin seguimiento se muestran completos. */
export async function diffFor(repo, files, limit = 200_000) {
  const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
  const untracked = files.filter((f) => f.status === '?').map((f) => f.path);
  let text = '';
  if (tracked.length) {
    const hasHead = (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    text += (await git(repo, ['diff', hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '--no-ext-diff', '--no-textconv', '--', ...tracked])).out;
  }
  for (const p of untracked) text += (await git(repo, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '/dev/null', p])).out;
  return text.length > limit ? text.slice(0, limit) + '\n… recortado …\n' : text;
}
