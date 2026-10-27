// Ejecucion: crea los commits grupo por grupo con comprobaciones, y permite deshacerlos sin perder trabajo.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, normalize } from 'node:path';
import { git, changes, operationInProgress } from './git.js';
import { validateMessage } from './message.js';

async function recordPath(repo) {
  const dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).out.trim();
  return join(dir, 'commitero', 'last.json');
}

async function saveRecord(repo, record) {
  const p = await recordPath(repo);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2));
}

export async function loadRecord(repo) {
  const p = await recordPath(repo);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function unsafePath(p) {
  return typeof p !== 'string' || !p || isAbsolute(p) || normalize(p).startsWith('..') || p.includes('\0') || p.startsWith('-');
}

/**
 * Valida el plan completo ANTES de tocar nada: mensajes, archivos y estado del repositorio.
 * Devuelve { ok, errors: [] }.
 */
export async function validatePlan(repo, plan) {
  const errors = [];
  if (!Array.isArray(plan) || plan.length === 0) return { ok: false, errors: ['no hay grupos que commitear'] };
  const op = await operationInProgress(repo);
  if (op) errors.push(`hay una operacion de git en curso (${op}); terminala antes`);
  const { files, staged } = await changes(repo);
  if (staged.length) errors.push(`ya hay cambios en el indice (${staged.slice(0, 3).join(', ')}${staged.length > 3 ? '…' : ''}); commitealos o sacalos del indice primero`);
  const known = new Set(files.map((f) => f.path));
  const used = new Set();
  plan.forEach((g, i) => {
    const label = `grupo ${i + 1}`;
    const v = validateMessage(g.message);
    v.errors.forEach((e) => errors.push(`${label}: ${e}`));
    if (!Array.isArray(g.files) || g.files.length === 0) errors.push(`${label}: no tiene archivos`);
    for (const p of g.files ?? []) {
      if (unsafePath(p)) errors.push(`${label}: ruta no valida (${String(p).slice(0, 40)})`);
      else if (!known.has(p)) errors.push(`${label}: "${p}" no tiene cambios`);
      else if (used.has(p)) errors.push(`${label}: "${p}" ya esta en otro grupo`);
      used.add(p);
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Crea los commits en orden. Si uno falla se detiene: los anteriores quedan hechos y el indice queda limpio.
 * Devuelve { ok, commits: [{ sha, message, files }], error? }.
 */
export async function applyPlan(repo, plan) {
  const check = await validatePlan(repo, plan);
  if (!check.ok) return { ok: false, commits: [], error: check.errors.join('\n') };
  const base = (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'])).out.trim() || null;
  const commits = [];
  for (const [i, g] of plan.entries()) {
    const add = await git(repo, ['add', '-A', '--', ...g.files]);
    if (add.code !== 0) return fail(repo, g.files, commits, base, `grupo ${i + 1}: no se pudo preparar (${add.err.trim().split('\n')[0]})`);
    // comprobacion: el indice debe contener exactamente los archivos del grupo
    const cached = (await git(repo, ['diff', '--cached', '--name-only', '-z'])).out.split('\0').filter(Boolean);
    const expected = new Set(g.files);
    const extra = cached.filter((p) => !expected.has(p));
    if (extra.length || cached.length === 0) return fail(repo, g.files, commits, base, `grupo ${i + 1}: el indice no coincide con el grupo (${extra[0] ?? 'vacio'})`);
    const c = await git(repo, ['commit', '-m', g.message.trim()], { timeout: 60000 });
    if (c.code !== 0) return fail(repo, g.files, commits, base, `grupo ${i + 1}: git commit fallo: ${(c.err || c.out).trim().split('\n').slice(0, 3).join(' ')}`);
    const sha = (await git(repo, ['rev-parse', 'HEAD'])).out.trim();
    commits.push({ sha, message: g.message.trim().split('\n')[0], files: g.files });
  }
  await saveRecord(repo, { base, commits, at: new Date().toISOString() });
  return { ok: true, commits };
}

async function fail(repo, files, commits, base, error) {
  await git(repo, ['reset', '-q', '--', ...files]);
  if (commits.length) await saveRecord(repo, { base, commits, at: new Date().toISOString() });
  return { ok: false, commits, error };
}

/** Los commits del ultimo lote que se pueden deshacer: HEAD debe ser el ultimo y no estar subido. */
export async function undoStatus(repo) {
  const rec = await loadRecord(repo);
  if (!rec || !rec.commits?.length) return { canUndo: false, reason: 'no hay un lote reciente' };
  const head = (await git(repo, ['rev-parse', 'HEAD'])).out.trim();
  const last = rec.commits[rec.commits.length - 1];
  if (head !== last.sha) return { canUndo: false, reason: 'HEAD ya no es el ultimo commit del lote' };
  const remote = await git(repo, ['branch', '-r', '--contains', head]);
  if (remote.out.trim()) return { canUndo: false, reason: 'el lote ya esta en el remoto' };
  return { canUndo: true, commits: rec.commits };
}

/**
 * Deshace el lote entero con `reset --mixed`: los archivos quedan como estaban, sin commitear. No toca el contenido.
 */
export async function undoBatch(repo) {
  const st = await undoStatus(repo);
  if (!st.canUndo) return { ok: false, error: st.reason };
  const rec = await loadRecord(repo);
  const target = rec.base ?? null;
  const r = target ? await git(repo, ['reset', '--mixed', '-q', target]) : await git(repo, ['update-ref', '-d', 'HEAD']);
  if (r.code !== 0) return { ok: false, error: r.err.trim() || 'no se pudo deshacer' };
  await saveRecord(repo, { base: null, commits: [], at: new Date().toISOString() });
  return { ok: true, undone: st.commits.length };
}

/** Sube la rama actual. Nunca fuerza. Solo se llama tras una confirmacion explicita. */
export async function push(repo) {
  const r = await git(repo, ['push'], { timeout: 120000 });
  return { ok: r.code === 0, output: (r.out + r.err).trim().slice(0, 4000) };
}
