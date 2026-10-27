import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeRepo } from './helpers.js';
import { startServer } from '../src/server.js';

function request(app, { method = 'GET', path = '/', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path, headers: { host: host ?? `127.0.0.1:${app.port}`, ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const auth = (app) => ({ 'x-commitero-token': app.token });

test('sirve la pagina con el token dentro y cabeceras de seguridad', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    const res = await request(app, { path: '/' });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(app.token));
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  } finally { await app.close(); r.cleanup(); }
});

test('la API rechaza peticiones sin token o con token equivocado', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    assert.equal((await request(app, { path: '/api/repos' })).status, 403);
    assert.equal((await request(app, { path: '/api/repos', headers: { 'x-commitero-token': 'x'.repeat(48) } })).status, 403);
    assert.equal((await request(app, { path: '/api/repos', headers: auth(app) })).status, 200);
  } finally { await app.close(); r.cleanup(); }
});

test('rechaza un Host que no sea el local (proteccion contra DNS rebinding)', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    for (const host of ['evil.example.com', `evil.example.com:${app.port}`, '127.0.0.1:1']) {
      assert.equal((await request(app, { path: '/', host })).status, 403, host);
    }
    assert.equal((await request(app, { path: '/', host: `localhost:${app.port}` })).status, 200);
  } finally { await app.close(); r.cleanup(); }
});

test('las escrituras rechazan un Origin ajeno y un tipo que no es json', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    r.write('a.txt', '1\n');
    const body = { repo: r.dir, groups: [{ message: 'feat: a', files: ['a.txt'] }] };
    assert.equal((await request(app, { method: 'POST', path: '/api/commit', headers: { ...auth(app), origin: 'https://evil.example.com' }, body })).status, 403);
    assert.equal((await request(app, { method: 'POST', path: '/api/commit', headers: { ...auth(app), 'content-type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal(r.run('log', '--oneline').trim().split('\n').length, 1);
  } finally { await app.close(); r.cleanup(); }
});

test('solo opera sobre repositorios abiertos', async () => {
  const r = makeRepo(); const other = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    const res = await request(app, { path: `/api/state?repo=${encodeURIComponent(other.dir)}`, headers: auth(app) });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /no abierto/);
    assert.equal((await request(app, { path: `/api/state?repo=${encodeURIComponent('/etc')}`, headers: auth(app) })).status, 400);
  } finally { await app.close(); r.cleanup(); other.cleanup(); }
});

test('flujo completo: estado, diff, commit y deshacer por la API', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    r.write('Sources/Foo.swift', 'func foo() {}\n'); r.write('Sources/FooSelfTest.swift', 'test\n'); r.write('docs/x.md', 'x\n');
    const st = await request(app, { path: `/api/state?repo=${encodeURIComponent(r.dir)}`, headers: auth(app) });
    assert.equal(st.status, 200);
    assert.equal(st.json.groups.length, 2);
    const d = await request(app, { path: `/api/diff?repo=${encodeURIComponent(r.dir)}&path=${encodeURIComponent('Sources/Foo.swift')}`, headers: auth(app) });
    assert.match(d.json.diff, /\+func foo/);
    const groups = st.json.groups.map((g) => ({ message: g.message, files: g.files.map((f) => f.path) }));
    const c = await request(app, { method: 'POST', path: '/api/commit', headers: auth(app), body: { repo: r.dir, groups } });
    assert.equal(c.status, 200);
    assert.equal(c.json.commits.length, 2);
    assert.equal(c.json.state.clean, true);
    assert.equal(c.json.state.undo.canUndo, true);
    const u = await request(app, { method: 'POST', path: '/api/undo', headers: auth(app), body: { repo: r.dir } });
    assert.equal(u.status, 200);
    assert.equal(u.json.state.clean, false);
  } finally { await app.close(); r.cleanup(); }
});

test('un plan invalido responde 422 y no commitea', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    r.write('a.txt', '1\n');
    const c = await request(app, { method: 'POST', path: '/api/commit', headers: auth(app), body: { repo: r.dir, groups: [{ message: 'feat: x\n\nCo-authored-by: Claude <noreply@anthropic.com>', files: ['a.txt'] }] } });
    assert.equal(c.status, 422);
    assert.equal(c.json.ok, false);
    assert.equal(r.run('log', '--oneline').trim().split('\n').length, 1);
  } finally { await app.close(); r.cleanup(); }
});

test('subir exige confirmacion explicita', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    const res = await request(app, { method: 'POST', path: '/api/push', headers: auth(app), body: { repo: r.dir } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /confirmacion/);
  } finally { await app.close(); r.cleanup(); }
});

test('rechaza un cuerpo enorme', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    const res = await request(app, { method: 'POST', path: '/api/open', headers: auth(app), body: JSON.stringify({ path: 'x'.repeat(2 * 1024 * 1024) }) }).catch((e) => ({ status: 'cerrado', e }));
    assert.ok(res.status === 413 || res.status === 'cerrado');
  } finally { await app.close(); r.cleanup(); }
});

test('valida mensajes con las mismas reglas que el commit', async () => {
  const r = makeRepo(); const app = await startServer({ repos: [r.dir], port: 0 });
  try {
    const res = await request(app, { method: 'POST', path: '/api/validate', headers: auth(app), body: { messages: ['feat: añade a', '', 'fix: x\n\nCo-authored-by: alguien', 'sin prefijo'] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.results.map((x) => x.ok), [true, false, false, true]);
    assert.ok(res.json.results[3].warnings.some((w) => /prefijo/.test(w)));
  } finally { await app.close(); r.cleanup(); }
});
