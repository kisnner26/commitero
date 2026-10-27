// Servidor local: solo escucha en 127.0.0.1, exige un token por proceso y valida Host y Origin.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildState } from './state.js';
import { repoRoot, changes, diffFor } from './git.js';
import { applyPlan, undoBatch, push } from './commit.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const MAX_BODY = 1024 * 1024;

export async function startServer({ repos = [], port = 4747 } = {}) {
  const token = randomBytes(24).toString('hex');
  const allowed = new Set();
  for (const r of repos) { const root = await repoRoot(r); if (root) allowed.add(root); }

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const json = (res, code, body) => send(res, code, body);

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('cuerpo demasiado grande'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('json no valido'), { code: 400 })); } });
    req.on('error', reject);
  });

  const hostOk = (req, p) => [`127.0.0.1:${p}`, `localhost:${p}`].includes(String(req.headers.host ?? '').toLowerCase());
  const tokenOk = (req) => {
    const got = Buffer.from(String(req.headers['x-commitero-token'] ?? ''));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const server = createServer(async (req, res) => {
    const actualPort = server.address().port;
    try {
      if (!hostOk(req, actualPort)) return json(res, 403, { error: 'host no permitido' });
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        let body = readFileSync(join(PUBLIC, file), 'utf8');
        if (file === 'index.html') body = body.replace('__TOKEN__', token);
        return send(res, 200, body, type);
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no existe' });

      // la API exige el token; las escrituras ademas exigen Origin propio y JSON
      if (!tokenOk(req)) return json(res, 403, { error: 'token no valido' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${actualPort}` && origin !== `http://localhost:${actualPort}`) return json(res, 403, { error: 'origen no permitido' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'se esperaba json' });
      }

      const repoParam = async (value) => {
        const root = await repoRoot(String(value ?? ''));
        if (!root || !allowed.has(root)) throw Object.assign(new Error('repositorio no abierto'), { code: 400 });
        return root;
      };

      if (req.method === 'GET' && url.pathname === '/api/repos') return json(res, 200, { repos: [...allowed].map((p) => ({ path: p, name: p.split('/').pop() })) });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await buildState(await repoParam(url.searchParams.get('repo'))));
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        const repo = await repoParam(url.searchParams.get('repo'));
        const path = url.searchParams.get('path') ?? '';
        const file = (await changes(repo)).files.find((f) => f.path === path);
        if (!file) return json(res, 404, { error: 'ese archivo no tiene cambios' });
        return json(res, 200, { path, diff: await diffFor(repo, [file]) });
      }
      if (req.method === 'POST' && url.pathname === '/api/open') {
        const body = await readBody(req);
        const root = await repoRoot(String(body.path ?? ''));
        if (!root) return json(res, 400, { error: 'esa carpeta no es un repositorio de git' });
        allowed.add(root);
        return json(res, 200, await buildState(root));
      }
      if (req.method === 'POST' && url.pathname === '/api/commit') {
        const body = await readBody(req);
        const repo = await repoParam(body.repo);
        const groups = (Array.isArray(body.groups) ? body.groups : []).map((g) => ({ message: String(g.message ?? ''), files: Array.isArray(g.files) ? g.files.map(String) : [] }));
        const result = await applyPlan(repo, groups);
        return json(res, result.ok ? 200 : 422, { ...result, state: await buildState(repo) });
      }
      if (req.method === 'POST' && url.pathname === '/api/undo') {
        const repo = await repoParam((await readBody(req)).repo);
        const result = await undoBatch(repo);
        return json(res, result.ok ? 200 : 409, { ...result, state: await buildState(repo) });
      }
      if (req.method === 'POST' && url.pathname === '/api/push') {
        const body = await readBody(req);
        const repo = await repoParam(body.repo);
        if (body.confirm !== true) return json(res, 400, { error: 'subir exige confirmacion explicita' });
        const result = await push(repo);
        return json(res, result.ok ? 200 : 502, { ...result, state: await buildState(repo) });
      }
      return json(res, 404, { error: 'no existe' });
    } catch (e) {
      return json(res, e.code === 400 || e.code === 413 ? e.code : 500, { error: e.message ?? 'error' });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  return { server, token, port: actual, url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(r)), allow: (p) => allowed.add(p) };
}
