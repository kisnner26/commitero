// Seguridad: archivos y lineas que no deben commitearse sin que lo decidas conscientemente.
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|mobileprovision)$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|\/)\.ssh\//i,
];
const SECRET_LINE = [
  [/AKIA[0-9A-Z]{16}/, 'clave de acceso de AWS'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'token de GitHub'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'clave de API (sk-)'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'token de Slack'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'llave privada'],
  [/(api[_-]?key|private[_-]?key|access[_-]?key|secret|token|passwd|password|\bkey)\s*[:=]\s*['"][^'"\s]{12,}['"]/i, 'valor sensible asignado'],
];
export const BIG_FILE_BYTES = 5 * 1024 * 1024;

/** Nombre del patron si la ruta es sensible, o null. */
export function sensitivePath(path) {
  return SENSITIVE_PATH.some((re) => re.test(path)) ? 'archivo sensible' : null;
}

/** Busca secretos en las lineas anadidas de un diff. Devuelve [{ path, label, prefix }]; nunca el valor completo. */
export function scanDiff(diffText) {
  const found = [];
  let current = '';
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) { current = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const [re, label] of SECRET_LINE) {
      const m = re.exec(line);
      if (m && !found.some((x) => x.path === current && x.label === label)) found.push({ path: current, label, prefix: m[0].slice(0, 4) + '…' });
    }
  }
  return found;
}

/** Avisos por grupo: { fileWarnings: { path: [textos] }, excluded: [paths] } con lo que se desmarca por defecto. */
export function assess(files, diffText) {
  const fileWarnings = {}, excluded = new Set();
  const warn = (p, t) => { (fileWarnings[p] ||= []).push(t); };
  for (const f of files) {
    if (sensitivePath(f.path)) { warn(f.path, 'archivo sensible (credenciales o llaves): no se commitea por defecto'); excluded.add(f.path); }
    if (f.binary && f.added === 0 && f.deleted === 0 && f.size > BIG_FILE_BYTES) warn(f.path, 'archivo binario grande');
  }
  for (const s of scanDiff(diffText)) {
    const path = files.find((f) => f.path === s.path)?.path ?? s.path;
    warn(path, `posible secreto: ${s.label} (${s.prefix})`);
    excluded.add(path);
  }
  return { fileWarnings, excluded: [...excluded] };
}
