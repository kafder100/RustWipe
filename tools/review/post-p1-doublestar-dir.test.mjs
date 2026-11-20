/**
 * P1, R-4 (регрессия R1-4 второго круга): цель «X/**» на большой папке
 * отменяла вайп по пределу. Раскрытие уже брало X целиком (один путь), но
 * продолжало листать каждую подпапку X. На 300 подпапках кончался предел
 * в 250 чтений папок, и вайп отменялся: ничего не удалено. На глубоком X
 * (8 уровней) так же срабатывал предел глубины.
 *
 * Правильное поведение (решение координатора): «**» в конце цели значит
 * «сама папка X целиком», как в 1.5.6. X проверяется на ссылку, как точный
 * путь; внутрь X ради ссылок спускаться не нужно: агент удаляет X целиком,
 * а ссылки внутри — как ссылки, не заходя по ним. Исключения внутри X
 * по-прежнему обходит обход исключений.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/post-p1-doublestar-dir.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, test } from './sandbox.mjs';

const DATA = '/oxide/data';
const name = (index) => `Plugin${String(index).padStart(3, '0')}`;

/** /oxide/data с подпапками Plugin000…, в каждой data.json; в Plugin007 ещё keep.json. */
function bigTree(count) {
  const files = {
    '/RustDedicated': 1024,
    '/oxide/plugins/Kits.cs': '// плагин',
    '/server/rust/cfg/server.cfg': 'server.hostname "x"',
  };
  for (let index = 0; index < count; index += 1) files[`${DATA}/${name(index)}/data.json`] = '{}';
  files[`${DATA}/${name(7)}/keep.json`] = '{"keep":true}';
  return { files };
}

async function expand(t, sb, targets, excludes = []) {
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const result = await sb.run(expandTargets(sb.ctx, server, targets, excludes));
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`путей ${result.paths.length} (${result.paths.slice(0, 3).join(', ')}); чтений папок ${result.listCalls}; truncated=${result.truncated}; limitHit=${JSON.stringify(result.limitHit)}`);
  return result;
}

async function wipe(t, sb, targets, excludes = []) {
  const profile = await sb.addProfile({ targets, excludes, options: { warnChat: false } });
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`вайп: ok=${run.ok}; delete к агенту: ${sb.tunnel.paths('delete').slice(0, 5).join(', ') || 'нет'}${sb.tunnel.paths('delete').length > 5 ? ' …' : ''}; удалено записей ${removed.length}`);
  if (!run.ok) t.note(`ошибки: ${run.errors.join(' | ')}`);
  return { run, removed };
}

test('R-4: 300 подпапок, цель «/oxide/data/**» — один путь, без предела, вайп удаляет папку', async (t) => {
  const sb = createSandbox({ tree: bigTree(300) });
  await sb.load();
  const result = await expand(t, sb, [`${DATA}/**`]);
  assert.deepEqual(result.paths, [DATA]);
  assert.deepEqual(result.directories, [DATA]);
  assert.equal(result.truncated, false, JSON.stringify(result.limitHit));
  assert.equal(result.limitHit, null);
  assert.ok(result.listCalls <= 2, `подпапки листаются зря: ${result.listCalls} чтений папок`);

  const { run } = await wipe(t, sb, [`${DATA}/**`]);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.equal(sb.tree.exists(DATA), false, 'папка /oxide/data не удалена');
  assert.ok(sb.tree.exists('/oxide/plugins/Kits.cs'), 'удалено лишнее рядом с /oxide/data');
  assert.equal(sb.status(), 'running', 'сервер снова работает');
});

test('R-4: 300 подпапок, цель «/oxide/data/**» и исключение внутри — исключённое цело, остальное удалено', async (t) => {
  const sb = createSandbox({ tree: bigTree(300) });
  await sb.load();
  const keep = `${DATA}/${name(7)}/keep.json`;
  const result = await expand(t, sb, [`${DATA}/**`], [keep]);
  assert.equal(result.truncated, false, JSON.stringify(result.limitHit));

  const { run } = await wipe(t, sb, [`${DATA}/**`], [keep]);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.ok(sb.tree.exists(keep), 'исключённый keep.json удалён');
  for (const index of [0, 7, 150, 299]) {
    assert.equal(sb.tree.exists(`${DATA}/${name(index)}/data.json`), false, `${name(index)}/data.json не удалён`);
  }
  assert.ok(sb.tree.exists('/oxide/plugins/Kits.cs'));
});

test('R-4: глубокая папка «/a/b/c/d/e/f/g/h/**» — без предела глубины, папка удаляется целиком', async (t) => {
  const deep = '/a/b/c/d/e/f/g/h';
  const sb = createSandbox({
    tree: { files: { '/RustDedicated': 1024, [`${deep}/sub/x.json`]: '{}', [`${deep}/top.json`]: '{}', '/a/keep.json': '{}' } },
  });
  await sb.load();
  const result = await expand(t, sb, [`${deep}/**`]);
  assert.deepEqual(result.paths, [deep]);
  assert.equal(result.truncated, false, JSON.stringify(result.limitHit));

  const { run } = await wipe(t, sb, [`${deep}/**`]);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.equal(sb.tree.exists(deep), false);
  assert.ok(sb.tree.exists('/a/keep.json'));
});

test('R-4: ссылка внутри X удаляется как ссылка — то, куда она ведёт, цело', async (t) => {
  const spec = bigTree(3);
  spec.files[`${DATA}/${name(0)}/world`] = { link: '/data/server/rust' };
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const { run } = await wipe(t, sb, [`${DATA}/**`]);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.equal(sb.tree.exists(DATA), false);
  assert.ok(sb.tree.exists('/server/rust/cfg/server.cfg'), 'через ссылку удалена папка мира');
});

test('R-4: «X/**», где X — ссылка, по-прежнему не удаляется и попадает в пропущенные', async (t) => {
  const spec = bigTree(3);
  spec.files['/oxide/world'] = { link: '/data/server/rust' };
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const result = await expand(t, sb, ['/oxide/world/**']);
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.skipped.map((item) => item.path), ['/oxide/world']);
});

test('R-4: «**» в середине цели по-прежнему спускается в подпапки', async (t) => {
  const sb = createSandbox({ tree: bigTree(3) });
  await sb.load();
  const result = await expand(t, sb, [`${DATA}/**/*.json`]);
  assert.deepEqual(result.paths, [
    `${DATA}/${name(0)}/data.json`,
    `${DATA}/${name(1)}/data.json`,
    `${DATA}/${name(2)}/data.json`,
    `${DATA}/${name(7)}/keep.json`,
  ]);
});
