// Agrupa los cambios de un repositorio en commits atomicos propuestos. Pura: no toca git ni el disco.
import { kindOf, stemOf, humanize } from './classify.js';
import { suggestMessage } from './message.js';

const ORDER = { code: 0, test: 1, config: 2, asset: 3, doc: 4 };

/** Une dos stems cuando uno es prefijo del otro en una frontera de mayuscula (IslandCompact + IslandCompactMode). */
function related(a, b) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 5 || short === long) return false;
  return long.toLowerCase().startsWith(short.toLowerCase()) && /[A-Z0-9_-]/.test(long[short.length] ?? '');
}

/**
 * @param files [{ path, status, added, deleted, binary }]
 * @returns { groups: [{ id, kind, label, files: [path], reason }], ignorable: [path] }
 */
export function groupChanges(files) {
  const ignorable = [], pool = [];
  for (const f of files) {
    const kind = kindOf(f.path);
    if (kind === 'ignorable') ignorable.push(f.path); else pool.push({ ...f, kind });
  }

  // 1. funciones: codigo y pruebas que comparten nombre base viajan juntos
  const features = new Map();      // stem -> { stem, files }
  const rest = { test: [], config: [], asset: [], doc: [] };
  const stems = [...new Set(pool.filter((f) => f.kind === 'code').map((f) => stemOf(f.path)))];
  const canonical = new Map();
  for (const s of stems) {
    const match = [...canonical.keys()].find((c) => related(c, s));
    if (match) canonical.set(s, canonical.get(match)); else canonical.set(s, s);
  }
  for (const f of pool) {
    if (f.kind === 'code') {
      const key = canonical.get(stemOf(f.path));
      if (!features.has(key)) features.set(key, { stem: key, files: [] });
      features.get(key).files.push(f);
    } else if (f.kind === 'test') {
      const stem = stemOf(f.path);
      const key = [...features.keys()].find((k) => k.toLowerCase() === stem.toLowerCase() || related(k, stem));
      if (key) features.get(key).files.push(f); else rest.test.push(f);
    } else rest[f.kind].push(f);
  }

  const groups = [];
  const add = (kind, label, fs, reason) => {
    const sorted = [...fs].sort((a, b) => a.path.localeCompare(b.path));
    groups.push({ kind, label, files: sorted.map((f) => f.path), reason, _files: sorted });
  };

  for (const { stem, files: fs } of [...features.values()]) {
    const nuevos = fs.filter((f) => f.status === 'A' || f.status === '?').length;
    add('code', humanize(stem), fs, nuevos === fs.length ? 'archivos nuevos de una misma funcion' : `archivos con el nombre base "${stem}"`);
  }
  // 2. lo que no cuadra con ninguna funcion
  if (rest.test.length) add('test', 'pruebas', rest.test, 'pruebas sin una funcion nueva asociada');
  if (rest.config.length) add('config', 'configuracion', rest.config, 'archivos de configuracion y empaquetado');
  if (rest.asset.length) add('asset', 'capturas y recursos', rest.asset, 'imagenes, sonidos y otros recursos');
  if (rest.doc.length) add('doc', 'documentacion', rest.doc, 'documentos');

  groups.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b._files.length - a._files.length || a.label.localeCompare(b.label));
  groups.forEach((g, i) => { g.id = `g${i + 1}`; g.message = suggestMessage(g, g._files); delete g._files; });
  return { groups, ignorable };
}
