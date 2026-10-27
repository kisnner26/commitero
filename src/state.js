// Estado completo de un repositorio para la interfaz: grupos propuestos, avisos, ramas y deshacer.
import { repoRoot, changes, branchInfo, diffFor, git } from './git.js';
import { groupChanges } from './group.js';
import { assess } from './safety.js';
import { undoStatus } from './commit.js';

export async function buildState(dir) {
  const repo = await repoRoot(dir);
  if (!repo) return { ok: false, error: 'esa carpeta no es un repositorio de git' };
  const { files, staged } = await changes(repo);
  const info = await branchInfo(repo);
  const { groups, ignorable } = groupChanges(files);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const reviewable = files.filter((f) => !ignorable.includes(f.path));
  const assessment = assess(reviewable, await diffFor(repo, reviewable));
  const excluded = new Set(assessment.excluded);
  const log = (await git(repo, ['log', '-8', '--pretty=format:%h%x09%s'])).out.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
  return {
    ok: true,
    repo,
    name: repo.split('/').pop(),
    ...info,
    staged,
    clean: files.length === 0,
    totals: { files: reviewable.length, added: reviewable.reduce((n, f) => n + f.added, 0), deleted: reviewable.reduce((n, f) => n + f.deleted, 0) },
    groups: groups.map((g) => ({
      id: g.id, kind: g.kind, label: g.label, reason: g.reason, message: g.message,
      files: g.files.map((p) => ({ ...byPath.get(p), warnings: assessment.fileWarnings[p] ?? [], included: !excluded.has(p) })),
    })),
    ignorable: ignorable.map((p) => byPath.get(p)),
    undo: await undoStatus(repo),
    log,
  };
}
