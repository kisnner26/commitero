import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestMessage, validateMessage } from '../src/message.js';

const f = (path, status = 'M', added = 5, deleted = 0) => ({ path, status, added, deleted });

test('archivos nuevos sugieren feat: añade', () => {
  assert.equal(suggestMessage({ kind: 'code', label: 'wardrobe' }, [f('a/Wardrobe.swift', '?')]), 'feat: añade wardrobe');
});
test('un cambio pequeno sugiere fix y uno grande feat', () => {
  assert.equal(suggestMessage({ kind: 'code', label: 'sound bank' }, [f('a/SoundBank.swift', 'M', 6, 2)]), 'fix: actualiza sound bank');
  assert.equal(suggestMessage({ kind: 'code', label: 'sound bank' }, [f('a/SoundBank.swift', 'M', 80, 10)]), 'feat: actualiza sound bank');
});
test('docs, pruebas y configuracion usan su prefijo', () => {
  assert.match(suggestMessage({ kind: 'doc' }, [f('docs/ISLAND.md')]), /^docs: actualiza ISLAND\.md$/);
  assert.match(suggestMessage({ kind: 'asset' }, [f('docs/img/a.png', '?')]), /^docs: añade capturas/);
  assert.match(suggestMessage({ kind: 'test' }, [f('tests/cpu.sh', '?')]), /^test: añade pruebas de cpu/);
  assert.match(suggestMessage({ kind: 'config' }, [f('package.json')]), /^chore: actualiza package\.json$/);
});
test('el asunto sugerido no pasa de 72 caracteres', () => {
  const files = Array.from({ length: 12 }, (_, i) => f(`docs/un-documento-con-nombre-muy-largo-${i}.md`));
  assert.ok(suggestMessage({ kind: 'doc' }, files).length <= 72);
});

test('un mensaje normal es valido', () => {
  const v = validateMessage('feat: añade guardarropa con seis atuendos');
  assert.equal(v.ok, true); assert.deepEqual(v.errors, []);
});
test('un mensaje vacio no es valido', () => {
  assert.equal(validateMessage('   ').ok, false);
  assert.equal(validateMessage(undefined).ok, false);
});
for (const bad of ['feat: x\n\nCo-authored-by: Claude <noreply@anthropic.com>', 'fix: algo\n\nGenerated with Claude Code', 'feat: hecho \u{1F916}', 'docs: Generado con IA', 'feat: x\n\nco-authored-by: alguien']) {
  test(`bloquea la atribucion: ${JSON.stringify(bad).slice(0, 40)}`, () => assert.equal(validateMessage(bad).ok, false));
}
test('el nombre del proyecto claude-pet no se bloquea', () => {
  const v = validateMessage('feat: añade refs/claude-pet para los puntos de restauracion');
  assert.equal(v.ok, true); assert.equal(v.warnings.some((w) => /IA/.test(w)), false);
});
test('mencionar claude suelto es un aviso, no un error', () => {
  const v = validateMessage('feat: ajusta el hook de Claude');
  assert.equal(v.ok, true); assert.ok(v.warnings.some((w) => /IA/.test(w)));
});
test('sin prefijo o con mayuscula avisa', () => {
  assert.ok(validateMessage('arregla cosas').warnings.some((w) => /prefijo/.test(w)));
  assert.ok(validateMessage('feat: Añade algo').warnings.some((w) => /minusculas/.test(w)));
});
test('una primera linea de mas de 100 caracteres es un error', () => {
  assert.equal(validateMessage('feat: ' + 'x'.repeat(100)).ok, false);
  assert.equal(validateMessage('feat: ' + 'x'.repeat(70)).ok, true);
});
