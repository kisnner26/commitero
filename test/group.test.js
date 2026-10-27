import test from 'node:test';
import assert from 'node:assert/strict';
import { groupChanges } from '../src/group.js';
import { kindOf, stemOf, humanize } from '../src/classify.js';

const f = (path, status = 'M', added = 5, deleted = 0) => ({ path, status, added, deleted, binary: false });

test('clasifica por ruta', () => {
  assert.equal(kindOf('Sources/App/Foo.swift'), 'code');
  assert.equal(kindOf('Sources/App/FooSelfTest.swift'), 'test');
  assert.equal(kindOf('test/foo.test.js'), 'test');
  assert.equal(kindOf('docs/ISLAND.md'), 'doc');
  assert.equal(kindOf('docs/img/hero.png'), 'asset');
  assert.equal(kindOf('package.json'), 'config');
  assert.equal(kindOf('node_modules/x/index.js'), 'ignorable');
  assert.equal(kindOf('.build/debug/App'), 'ignorable');
  assert.equal(kindOf('.DS_Store'), 'ignorable');
});

test('el nombre base quita los sufijos de prueba', () => {
  assert.equal(stemOf('Sources/FooSelfTest.swift'), 'Foo');
  assert.equal(stemOf('test/foo.test.js'), 'foo');
  assert.equal(stemOf('src/foo_test.go'), 'foo');
  assert.equal(stemOf('Sources/Foo.swift'), 'Foo');
  assert.equal(humanize('SessionJournal'), 'session journal');
  assert.equal(humanize('cpu-script'), 'cpu script');
});

test('codigo y prueba con el mismo nombre viajan en el mismo grupo', () => {
  const { groups } = groupChanges([f('Sources/Wardrobe.swift', '?'), f('Sources/WardrobeSelfTest.swift', '?'), f('Sources/Sound.swift', '?')]);
  const wardrobe = groups.find((g) => g.label === 'wardrobe');
  assert.deepEqual(wardrobe.files, ['Sources/Wardrobe.swift', 'Sources/WardrobeSelfTest.swift']);
  assert.equal(groups.length, 2);
});

test('nombres relacionados por prefijo se unen', () => {
  const { groups } = groupChanges([f('A/IslandCompact.swift', '?'), f('A/IslandCompactMode.swift', '?')]);
  assert.equal(groups.length, 1);
});

test('nombres parecidos pero no relacionados no se unen', () => {
  const { groups } = groupChanges([f('A/Sound.swift', '?'), f('A/Soundtrack.swift', '?')]);
  assert.equal(groups.length, 2);
});

test('docs, capturas, configuracion y pruebas sueltas van aparte y en orden', () => {
  const { groups } = groupChanges([
    f('docs/ISLAND.md'), f('docs/img/a.png', '?'), f('package.json'), f('tests/cpu.sh', '?'), f('src/Nuevo.swift', '?'),
  ]);
  assert.deepEqual(groups.map((g) => g.kind), ['code', 'test', 'config', 'asset', 'doc']);
  assert.deepEqual(groups.map((g) => g.id), ['g1', 'g2', 'g3', 'g4', 'g5']);
});

test('una prueba sin funcion asociada queda en el grupo de pruebas', () => {
  const { groups } = groupChanges([f('test/otra.test.js', '?')]);
  assert.equal(groups[0].kind, 'test');
});

test('lo ignorable no entra en ningun grupo', () => {
  const r = groupChanges([f('node_modules/a/b.js', '?'), f('.DS_Store', '?'), f('src/x.js', '?')]);
  assert.deepEqual(r.ignorable.sort(), ['.DS_Store', 'node_modules/a/b.js']);
  assert.equal(r.groups.flatMap((g) => g.files).length, 1);
});

test('cada archivo aparece en exactamente un grupo', () => {
  const files = ['a/Foo.swift', 'a/FooSelfTest.swift', 'a/Bar.swift', 'docs/x.md', 'docs/i/y.png', 'Package.swift', 'tests/t.sh'].map((p) => f(p, '?'));
  const { groups } = groupChanges(files);
  const all = groups.flatMap((g) => g.files).sort();
  assert.deepEqual(all, files.map((x) => x.path).sort());
  assert.equal(new Set(all).size, all.length);
});

test('sin cambios no hay grupos', () => {
  assert.deepEqual(groupChanges([]), { groups: [], ignorable: [] });
});
