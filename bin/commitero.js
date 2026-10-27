#!/usr/bin/env node
// commitero [carpeta] [--port 4747] [--no-open]
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { startServer } from '../src/server.js';
import { repoRoot } from '../src/git.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
if (flag('--help') || flag('-h')) {
  console.log('uso: commitero [carpeta] [--port 4747] [--no-open]\n\nabre una interfaz local que agrupa los cambios del repositorio en commits atomicos.');
  process.exit(0);
}
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const dir = resolve(positional[0] ?? process.cwd());
const root = await repoRoot(dir);
if (!root) { console.error(`commitero: ${dir} no es un repositorio de git`); process.exit(1); }

let app;
try { app = await startServer({ repos: [root], port: Number(value('--port', 4747)) }); }
catch (e) {
  if (e.code === 'EADDRINUSE') app = await startServer({ repos: [root], port: 0 });
  else { console.error(`commitero: ${e.message}`); process.exit(1); }
}
// la URL lleva el repo; el token viaja dentro de la pagina, no en la URL
const url = `${app.url}/?repo=${encodeURIComponent(root)}`;
console.log(`commitero listo en ${url}\n(solo escucha en 127.0.0.1; ctrl+c para salir)`);
if (!flag('--no-open')) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const openerArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, openerArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
process.on('SIGINT', () => { app.close().then(() => process.exit(0)); });
