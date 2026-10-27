// Mensajes de commit: sugerencia, validacion y la regla de no atribuir autoria a una IA.
import { stemOf, humanize } from './classify.js';

const PREFIXES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'chore', 'style', 'build', 'ci'];
export const SUBJECT_LIMIT = 72;

// Estas atribuciones nunca van en un commit: el autor es la persona.
const FORBIDDEN = [
  /co-authored-by/i,
  /noreply@anthropic\.com/i,
  /generated (with|by)/i,
  /generado (con|por)/i,
  /\u{1F916}/u,
];

/** Sugerencia de mensaje para un grupo. Siempre editable en la interfaz. */
export function suggestMessage(group, files) {
  const changed = files.reduce((n, f) => n + (f.added || 0) + (f.deleted || 0), 0);
  const allNew = files.every((f) => f.status === 'A' || f.status === '?');
  const names = [...new Set(files.map((f) => stemOf(f.path)))].map(humanize);
  const short = (list, max = 2) => list.length <= max ? list.join(' y ') : `${list.slice(0, max).join(', ')} y ${list.length - max} mas`;
  let prefix, text;
  switch (group.kind) {
    case 'code':
      prefix = allNew ? 'feat' : changed <= 12 ? 'fix' : 'feat';
      text = allNew ? `añade ${group.label}` : `actualiza ${group.label}`;
      break;
    case 'test': prefix = 'test'; text = `añade pruebas de ${short(names)}`; break;
    case 'config': prefix = 'chore'; text = `actualiza ${short(files.map((f) => f.path.split('/').pop()))}`; break;
    case 'asset': prefix = 'docs'; text = 'añade capturas y recursos'; break;
    case 'doc': prefix = 'docs'; text = allNew ? `añade ${short(files.map((f) => f.path.split('/').pop()))}` : `actualiza ${short(files.map((f) => f.path.split('/').pop()))}`; break;
    default: prefix = 'chore'; text = 'actualiza archivos';
  }
  const subject = `${prefix}: ${text}`;
  return subject.length > SUBJECT_LIMIT ? subject.slice(0, SUBJECT_LIMIT - 1).trimEnd() + '…' : subject;
}

/** { ok, errors: [], warnings: [] }. Los errores bloquean el commit; los avisos no. */
export function validateMessage(message) {
  const errors = [], warnings = [];
  const text = String(message ?? '');
  const subject = text.split('\n')[0].trim();
  if (!subject) errors.push('el mensaje esta vacio');
  if (text.includes('\0')) errors.push('el mensaje contiene caracteres no validos');
  for (const re of FORBIDDEN) if (re.test(text)) errors.push('el mensaje atribuye autoria a una IA o a una herramienta; el autor eres tu');
  if (subject.length > 100) errors.push('la primera linea pasa de 100 caracteres');
  else if (subject.length > SUBJECT_LIMIT) warnings.push(`la primera linea pasa de ${SUBJECT_LIMIT} caracteres`);
  if (subject && !new RegExp(`^(${PREFIXES.join('|')})(\\([^)]+\\))?!?: \\S`).test(subject)) warnings.push(`conviene empezar con un prefijo: ${PREFIXES.slice(0, 6).join(', ')}…`);
  if (/\b(claude|anthropic|chatgpt|openai|copilot)\b(?!-)/i.test(text)) warnings.push('el mensaje menciona una IA; revisa que no sea una atribucion');
  if (/^[A-Z]/.test(subject.replace(/^[a-z]+(\([^)]+\))?: /, ''))) warnings.push('tus mensajes van en minusculas');
  return { ok: errors.length === 0, errors, warnings };
}
