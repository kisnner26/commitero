import test from 'node:test';
import assert from 'node:assert/strict';
import { sensitivePath, scanDiff, assess } from '../src/safety.js';

test('detecta archivos sensibles por ruta', () => {
  for (const p of ['.env', 'app/.env.local', 'id_rsa', 'keys/server.pem', 'cert.p12', 'credentials.json', '.ssh/config', '.npmrc']) assert.ok(sensitivePath(p), p);
  for (const p of ['src/environment.js', 'README.md', 'docs/keys.md', 'src/secret_santa.js']) assert.equal(sensitivePath(p), null, p);
});

test('detecta secretos en lineas anadidas y nunca guarda el valor completo', () => {
  const diff = ['+++ b/config.js', '+const k = "AKIAABCDEFGHIJKLMNOP";', '+const t = "ghp_' + 'a'.repeat(36) + '";', ' contexto'].join('\n');
  const found = scanDiff(diff);
  assert.equal(found.length, 2);
  assert.ok(found.every((x) => x.path === 'config.js' && x.prefix.length <= 5 && x.prefix.endsWith('…')));
  assert.equal(JSON.stringify(found).includes('ABCDEFGHIJKLMNOP'), false);
});

test('las lineas quitadas o de contexto no cuentan', () => {
  const diff = ['+++ b/x.js', '-const k = "AKIAABCDEFGHIJKLMNOP";', ' const j = "AKIAABCDEFGHIJKLMNOP";'].join('\n');
  assert.equal(scanDiff(diff).length, 0);
});

test('detecta llaves privadas y valores asignados', () => {
  const diff = ['+++ b/k.txt', '+-----BEGIN RSA PRIVATE KEY-----', '+++ b/c.js', '+password = "supersecreto1234"'].join('\n');
  assert.equal(scanDiff(diff).length, 2);
});

test('texto normal no dispara avisos', () => {
  const diff = ['+++ b/a.js', '+const total = items.length;', '+// el token se pide al servidor'].join('\n');
  assert.equal(scanDiff(diff).length, 0);
});

test('assess marca como excluidos los archivos sensibles y con secretos', () => {
  const files = [{ path: '.env', binary: false, added: 1, deleted: 0 }, { path: 'a.js', binary: false, added: 1, deleted: 0 }, { path: 'b.js', binary: false, added: 1, deleted: 0 }];
  const diff = ['+++ b/b.js', '+key = "' + 'x'.repeat(20) + '"'].join('\n');
  const r = assess(files, diff);
  assert.deepEqual(r.excluded.sort(), ['.env', 'b.js']);
  assert.ok(r.fileWarnings['.env'][0].includes('sensible'));
  assert.ok(r.fileWarnings['b.js'][0].includes('posible secreto'));
  assert.equal(r.fileWarnings['a.js'], undefined);
});
