// Interfaz de commitero. Sin dependencias; todo el DOM se construye con textContent (nada de innerHTML).
const token = document.querySelector('meta[name=commitero-token]').content;
let repoPath = new URLSearchParams(location.search).get('repo');
let state = null;          // estado del servidor
let draft = [];            // grupos editables: { id, kind, label, message, on, files: [{...file, on}] }
let validation = {};       // id de grupo -> { ok, errors, warnings }
let openDiffs = new Set();
const diffCache = new Map();
let busy = false, dirty = false, validateTimer = null, nextId = 1000, signature = '';
// huella de lo que el servidor reporta: si no cambia, no se rehace el borrador ni se cierran los diffs abiertos
const sign = (st) => JSON.stringify([st.branch, st.ahead, st.staged, (st.groups ?? []).map((g) => g.files.map((f) => [f.path, f.status, f.added, f.deleted]))]);

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'x-commitero-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

function toast(text, ms = 4200) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function adopt(newState) {
  state = newState; signature = sign(newState);
  draft = (state.groups ?? []).map((g) => ({ id: g.id, kind: g.kind, label: g.label, message: g.message, on: g.files.some((f) => f.included), files: g.files.map((f) => ({ ...f, on: f.included })) }));
  openDiffs = new Set(); dirty = false; validation = {};
  scheduleValidation();
}

async function load() {
  if (!repoPath) { state = { ok: false, error: 'no hay un repositorio abierto' }; return render(); }
  const r = await api(`/api/state?repo=${encodeURIComponent(repoPath)}`);
  if (r.status === 403) { state = { ok: false, error: 'la pagina perdio su permiso (el servidor se reinicio). recarga la pestaña.' }; return render(); }
  adopt(r.json.ok === false ? r.json : r.json);
  render();
}

function scheduleValidation() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(async () => {
    const active = draft.filter((g) => g.on);
    if (!active.length) { validation = {}; return render(); }
    const r = await api('/api/validate', { method: 'POST', body: { messages: active.map((g) => g.message) } });
    validation = {}; active.forEach((g, i) => { validation[g.id] = r.json.results?.[i]; });
    render();
  }, 250);
}

const selected = (g) => g.files.filter((f) => f.on);
const activeGroups = () => draft.filter((g) => g.on && selected(g).length);
function canCommit() {
  if (busy || !state?.ok || state.staged?.length) return false;
  const groups = activeGroups();
  return groups.length > 0 && groups.every((g) => validation[g.id]?.ok !== false && g.message.trim());
}

function statusChip(f) {
  const map = { A: ['nuevo', 'new'], '?': ['nuevo', 'new'], M: ['modificado', ''], D: ['borrado', 'del'], R: ['renombrado', ''] };
  const [text, cls] = map[f.status] ?? ['cambio', ''];
  return h('span', { class: `status ${cls}` }, text);
}

function fileRow(g, f) {
  const key = `${g.id}:${f.path}`;
  const others = draft.filter((x) => x !== g);
  const move = h('select', { class: 'move', 'aria-label': `mover ${f.path} a otro grupo`, onchange: (e) => {
    const value = e.target.value; if (!value) return;
    const idx = g.files.indexOf(f); g.files.splice(idx, 1);
    let target = draft.find((x) => x.id === value);
    if (value === '__new') { target = { id: `n${nextId++}`, kind: g.kind, label: 'grupo nuevo', message: 'feat: ', on: true, files: [] }; draft.push(target); }
    target.files.push(f);
    if (!g.files.length) draft.splice(draft.indexOf(g), 1);
    dirty = true; scheduleValidation(); render();
  } }, h('option', { value: '' }, 'mover a…'), others.map((x) => h('option', { value: x.id }, x.label)), h('option', { value: '__new' }, 'grupo nuevo'));
  return h('li', { class: 'file' },
    h('div', { class: 'f-row' },
      h('input', { type: 'checkbox', checked: f.on, 'aria-label': `incluir ${f.path}`, onchange: (e) => { f.on = e.target.checked; dirty = true; scheduleValidation(); render(); } }),
      h('button', { class: 'f-path', title: 'ver el diff', onclick: () => toggleDiff(g, f) }, f.path),
      statusChip(f),
      f.binary ? h('span', { class: 'delta' }, 'binario') : h('span', { class: 'delta' }, h('span', { class: 'add' }, `+${f.added}`), ' ', h('span', { class: 'del' }, `−${f.deleted}`)),
      others.length || true ? move : null),
    f.warnings?.length ? h('div', { class: 'warn', role: 'alert' }, f.warnings.join(' · ')) : null,
    openDiffs.has(key) ? diffView(key) : null);
}

function diffView(key) {
  const text = diffCache.get(key);
  const box = h('div', { class: 'diff', tabindex: '0', 'aria-label': 'diff' });
  if (text == null) { box.append(h('div', { class: 'meta' }, 'cargando…')); return box; }
  for (const line of text.split('\n')) {
    const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('+') ? 'p' : line.startsWith('-') ? 'm' : line.startsWith('@@') ? 'h' : '';
    box.append(h('div', { class: cls }, line || ' '));
  }
  return box;
}

async function toggleDiff(g, f) {
  const key = `${g.id}:${f.path}`;
  if (openDiffs.has(key)) { openDiffs.delete(key); return render(); }
  openDiffs.add(key); render();
  if (!diffCache.has(key)) {
    const r = await api(`/api/diff?repo=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(f.path)}`);
    diffCache.set(key, r.ok ? r.json.diff : `no se pudo cargar el diff: ${r.json.error ?? r.status}`);
    render();
  }
}

function groupCard(g) {
  const v = validation[g.id];
  const files = selected(g);
  const added = files.reduce((n, f) => n + (f.added || 0), 0), deleted = files.reduce((n, f) => n + (f.deleted || 0), 0);
  return h('section', { class: `group glass ${g.on ? '' : 'off'}`, 'aria-label': `grupo ${g.label}` },
    h('div', { class: 'g-head' },
      h('input', { type: 'checkbox', checked: g.on, 'aria-label': `incluir el grupo ${g.label}`, onchange: (e) => { g.on = e.target.checked; dirty = true; scheduleValidation(); render(); } }),
      h('input', { class: `msg ${v && v.ok === false ? 'bad' : ''}`, value: g.message, 'aria-label': `mensaje del commit de ${g.label}`, spellcheck: 'false',
        oninput: (e) => { g.message = e.target.value; dirty = true; scheduleValidation(); updateDock(); },
        onchange: (e) => { g.message = e.target.value; dirty = true; scheduleValidation(); updateDock(); } }),
      h('span', { class: 'chip kind' }, g.kind === 'code' ? 'funcion' : g.kind === 'asset' ? 'recursos' : g.kind === 'doc' ? 'docs' : g.kind === 'test' ? 'pruebas' : 'config'),
      h('span', { class: 'chip' }, `${files.length}/${g.files.length} · `, h('span', { class: 'add' }, `+${added}`), ' ', h('span', { class: 'del' }, `−${deleted}`))),
    v && (v.errors.length || v.warnings.length) ? h('div', { class: 'hints' }, v.errors.map((e) => h('div', { class: 'err' }, e)), v.warnings.map((w) => h('div', {}, w))) : null,
    h('ul', { class: 'files' }, g.files.map((f) => fileRow(g, f))));
}

function hero() {
  const t = state.totals;
  if (state.clean) return h('section', { class: 'hero' }, h('h1', {}, 'Todo está commiteado.'), h('p', {}, 'No hay cambios pendientes en este repositorio.'));
  return h('section', { class: 'hero' },
    h('h1', {}, 'Tus cambios, ', h('span', {}, 'en commits limpios.')),
    h('p', {}, 'Revisa cada grupo, ajusta el mensaje y commitea. Nada se sube ni se commitea sin que lo pidas.'),
    h('div', { class: 'stats' },
      h('span', { class: 'chip' }, h('b', {}, t.files), ' archivos'),
      h('span', { class: 'chip' }, h('b', { class: 'add' }, `+${t.added}`), ' ', h('b', { class: 'del' }, `−${t.deleted}`)),
      h('span', { class: 'chip' }, h('b', {}, draft.length), ' grupos propuestos')));
}

function render() {
  const repo = $('#repo'); repo.replaceChildren();
  const main = $('#main'); main.replaceChildren();
  if (!state) { main.append(h('p', { class: 'loading' }, 'cargando…')); return updateDock(); }
  if (state.ok === false) {
    main.append(h('section', { class: 'card glass', role: 'alert' }, h('h2', {}, 'No se pudo abrir el repositorio.'), h('p', {}, state.error), h('ul', {}, h('li', {}, 'comprueba que la carpeta sea un repositorio de git'), h('li', {}, 'abre otra carpeta con "abrir repo"')), h('div', { class: 'row', style: 'margin-top:14px;display:flex;gap:10px' }, h('button', { class: 'capsule primary', onclick: () => openDialog() }, 'abrir repo'), h('button', { class: 'capsule', onclick: () => load() }, 'reintentar'))));
    return updateDock();
  }
  repo.append(h('span', { class: 'name' }, state.name), h('span', { class: 'chip live' }, state.branch || 'sin rama'),
    state.upstream ? h('span', { class: 'chip' }, `↑${state.ahead} ↓${state.behind}`) : h('span', { class: 'chip' }, 'sin remoto'));
  main.append(hero());
  if (state.staged?.length) main.append(h('section', { class: 'card glass', role: 'alert' }, h('h2', {}, 'Ya hay cambios en el índice.'), h('p', {}, 'Para no mezclar lo que ya preparaste con los grupos, commitero no actúa hasta que lo resuelvas: commitéalos o sácalos del índice.'), h('ul', {}, state.staged.slice(0, 6).map((p) => h('li', {}, p)))));
  draft.forEach((g) => main.append(groupCard(g)));
  if (state.ignorable?.length) main.append(h('details', { class: 'card glass' }, h('summary', {}, `Ignorados sugeridos (${state.ignorable.length})`), h('p', {}, 'Parecen artefactos de compilación o archivos del sistema. No se agrupan; conviene añadirlos al .gitignore.'), h('ul', {}, state.ignorable.slice(0, 12).map((f) => h('li', {}, f.path)))));
  if (state.log?.length) main.append(h('section', { class: 'card glass' }, h('h2', {}, 'Últimos commits'), h('ul', { class: 'log' }, state.log.map((c) => h('li', {}, h('b', {}, c.sha), c.subject)))));
  updateDock();
}

function updateDock() {
  const dock = $('#dock');
  if (!state?.ok) { dock.hidden = true; return; }
  dock.hidden = false; dock.replaceChildren();
  const groups = activeGroups(), nFiles = groups.reduce((n, g) => n + selected(g).length, 0);
  dock.append(h('div', { class: 'sum' }, state.clean ? 'sin cambios pendientes' : [h('b', {}, groups.length), ` grupos · `, h('b', {}, nFiles), ' archivos seleccionados']));
  if (state.undo?.canUndo) dock.append(h('button', { class: 'capsule', onclick: undo }, `deshacer el lote (${state.undo.commits.length})`));
  if (state.upstream && state.ahead > 0) dock.append(h('button', { class: 'capsule', onclick: pushDialog }, `subir ↑${state.ahead}`));
  if (!state.clean) dock.append(h('button', { class: 'capsule primary', disabled: !canCommit(), onclick: commit, title: state.staged?.length ? 'resuelve el índice primero' : '' }, busy ? 'commiteando…' : `commitear ${groups.length} ${groups.length === 1 ? 'grupo' : 'grupos'}`));
}

async function commit() {
  busy = true; updateDock();
  const body = { repo: repoPath, groups: activeGroups().map((g) => ({ message: g.message.trim(), files: selected(g).map((f) => f.path) })) };
  const r = await api('/api/commit', { method: 'POST', body });
  busy = false;
  if (r.ok) { adopt(r.json.state); toast(`${r.json.commits.length} ${r.json.commits.length === 1 ? 'commit creado' : 'commits creados'}. Puedes deshacerlos desde la barra de abajo.`); }
  else { if (r.json.state) adopt(r.json.state); toast(r.json.error ?? 'no se pudo commitear', 9000); }
  render();
}

async function undo() {
  busy = true; updateDock();
  const r = await api('/api/undo', { method: 'POST', body: { repo: repoPath } });
  busy = false;
  if (r.json.state) adopt(r.json.state);
  toast(r.ok ? `Lote deshecho: ${r.json.undone} commits. Tus archivos siguen intactos.` : (r.json.error ?? 'no se pudo deshacer'), 7000);
  render();
}

function dialog(build) {
  const d = $('#dialog'); d.replaceChildren(...build(d)); if (!d.open) d.showModal(); return d;
}
function pushDialog() {
  dialog((d) => [h('h2', {}, 'Subir al remoto.'), h('p', {}, `Se subirán ${state.ahead} ${state.ahead === 1 ? 'commit' : 'commits'} de ${state.branch} a ${state.upstream}. No se fuerza nada.`),
    h('div', { class: 'row' }, h('button', { class: 'capsule', onclick: () => d.close() }, 'cancelar'), h('button', { class: 'capsule primary', onclick: async () => {
      d.close(); busy = true; updateDock();
      const r = await api('/api/push', { method: 'POST', body: { repo: repoPath, confirm: true } });
      busy = false; if (r.json.state) adopt(r.json.state); toast(r.ok ? 'Subido.' : `No se pudo subir: ${r.json.output ?? r.json.error}`, 9000); render();
    } }, 'subir'))]);
}
function openDialog() {
  dialog((d) => {
    const input = h('input', { placeholder: '/ruta/al/repositorio', 'aria-label': 'ruta del repositorio', value: repoPath ?? '' });
    const go = async () => {
      const r = await api('/api/open', { method: 'POST', body: { path: input.value.trim() } });
      if (!r.ok) return toast(r.json.error ?? 'no se pudo abrir', 6000);
      d.close(); repoPath = r.json.repo; history.replaceState(null, '', `/?repo=${encodeURIComponent(repoPath)}`); adopt(r.json); render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return [h('h2', {}, 'Abrir un repositorio.'), h('p', {}, 'Escribe la ruta de una carpeta con git.'), input, h('div', { class: 'row' }, h('button', { class: 'capsule', onclick: () => d.close() }, 'cancelar'), h('button', { class: 'capsule primary', onclick: go }, 'abrir'))];
  });
}

document.body.classList.add('intro');
setTimeout(() => document.body.classList.remove('intro'), 900);
$('#refresh').addEventListener('click', () => load());
$('#open').addEventListener('click', openDialog);
window.addEventListener('focus', async () => {
  if (busy || !state?.ok || !repoPath) return;
  const r = await api(`/api/state?repo=${encodeURIComponent(repoPath)}`);
  if (r.ok && r.json.ok !== false && sign(r.json) !== signature && !dirty) { adopt(r.json); render(); }
  else if (r.ok && r.json.ok !== false && sign(r.json) !== signature) { toast('El repositorio cambió. Pulsa actualizar para recargar los grupos (perderás tus ajustes).', 6000); }
});
load();
