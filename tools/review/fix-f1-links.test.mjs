/**
 * F1, находки H3d и H6b: ссылка внутри выбранной папки уводила удаление.
 * Агент Catalyst удаляет не саму ссылку, а то, куда она ведёт
 * (catalyst-agent/src/file_manager.rs, delete_file и resolve_beneath, тег
 * v1.89.2), а «/data/…» в цели ссылки — это корень сервера. Плагин ссылку не
 * отличал: пресет «Данные Oxide» со ссылкой root -> /data стирал весь сервер.
 *
 * Что видно плагину: отдельного признака ссылки в ответе list нет, но права
 * у ссылки всегда 777 (агент берёт права самой ссылки, lstat). Права 777
 * бывают и у обычных файлов — их плагин тоже не тронет, и это видно в
 * причине пропуска.
 *
 * Правильное поведение (ответ владельца №3 «строго выбранные файлы»):
 * запись с правами 777 не удаляется и не обходится, а попадает в skipped
 * с причиной (договорённость К2); точный путь (из пикера) проверяется по
 * листингу его каталога. Остальное удаляется как раньше.
 *
 * Готовые тесты нашедших — h03d-link-wipes-install и h06b-link-inside-target.
 *
 * Всё на подменах песочницы: дерево в памяти, поведение агента со ссылками —
 * по исходникам. Настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-links.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const INSTALL = [
  '/RustDedicated',
  '/RustDedicated_Data/Managed/Assembly-CSharp.dll',
  '/RustDedicated_Data/globalgamemanagers',
  '/start.sh',
  '/runds.sh',
  '/steamapps/appmanifest_258550.acf',
  '/server/rust/cfg/server.cfg',
  '/server/rust/proceduralmap.3000.12345.270.sav',
];

/** Дерево сервера Rust со ссылками на корень сервера и на папку мира (абсолютной и относительной). */
function treeWithLinks() {
  const spec = rustServerTree();
  delete spec.files['/oxide/data/shared'];
  spec.files['/oxide/data/root'] = { link: '/data' };
  spec.files['/oxide/data/maps'] = { link: '/data/server/rust' };
  // Относительная ссылка на папку мира: агент показывает её как каталог.
  spec.files['/oxide/data/world'] = { link: '../../server/rust' };
  spec.files['/oxide/data/Kits/keep.json'] = '{"keep":true}';
  return spec;
}

async function expand(t, sb, targets, excludes = []) {
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const result = await sb.run(expandTargets(sb.ctx, server, targets, excludes));
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`пути: ${result.paths.join(', ') || 'нет'}`);
  t.note(`пропущено: ${result.skipped.map((item) => item.path).join(', ') || 'нет'}`);
  return result;
}

async function wipe(t, sb, targets, excludes = []) {
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets, excludes });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`delete: ${sb.tunnel.paths('delete').join(', ') || 'нет'}; ok=${run.ok}`);
  return { removed, run };
}

const lostInstall = (sb) => INSTALL.filter((path) => !sb.tree.exists(path));

test('Ссылки из маски /oxide/data/* — в skipped с причиной, обычные записи удаляются', async (t) => {
  const sb = createSandbox({ tree: treeWithLinks() });
  await sb.load();
  const result = await expand(t, sb, ['/oxide/data/*']);
  const skipped = result.skipped.map((item) => item.path).sort();
  assert.deepEqual(skipped, [
    '/oxide/data/backup',
    '/oxide/data/cfg-link.json',
    '/oxide/data/maps',
    '/oxide/data/root',
    '/oxide/data/up',
    '/oxide/data/world',
  ]);
  assert.ok(result.skipped.every((item) => /ссылка/.test(item.reason) && /777/.test(item.reason)), 'в причине нет слов «ссылка» и «777»');
  assert.ok(result.paths.includes('/oxide/data/Kits.json'));
  assert.ok(result.paths.includes('/oxide/data/Kits'));
});

test('H3d: точный путь из пикера на ссылку root -> /data — сервер цел, путь в skipped', async (t) => {
  const sb = createSandbox({ tree: treeWithLinks() });
  await sb.load();
  const result = await expand(t, sb, ['/oxide/data/root', '/oxide/data/Kits.json']);
  assert.deepEqual(result.paths, ['/oxide/data/Kits.json']);
  assert.deepEqual(result.skipped.map((item) => item.path), ['/oxide/data/root']);
  const { removed, run } = await wipe(t, sb, ['/oxide/data/root', '/oxide/data/Kits.json']);
  assert.deepEqual(lostInstall(sb), [], 'точный путь на ссылку снёс установку');
  // Пока среди выбранного есть то, что нельзя удалить точно, вайп не идёт
  // целиком (R-3, «строго выбранные файлы»): Kits.json тоже цел, ссылка названа.
  assert.deepEqual(removed, []);
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('/oxide/data/root')), 'в причине отказа нет ссылки');
});

test('H6b: «**» не заходит в ссылку world -> ../../server/rust — server.cfg и мир целы', async (t) => {
  // Ссылки наружу убраны: на них агент отвечает отказом, и обход падает сам —
  // на обычном сервере без таких ссылок этого везения нет.
  const spec = treeWithLinks();
  delete spec.files['/oxide/data/backup'];
  delete spec.files['/oxide/data/up'];
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const { removed } = await wipe(t, sb, ['/oxide/**/*.cfg', '/oxide/**/*.sav']);
  assert.deepEqual(lostInstall(sb), [], 'через ссылку удалены файлы мира или настройки');
  assert.deepEqual(removed.filter((path) => !path.startsWith('/oxide/')), []);
});

test('H3d: обход исключений не заходит в ссылку — цель /oxide/data, исключение keep.json', async (t) => {
  const spec = treeWithLinks();
  delete spec.files['/oxide/data/backup'];
  delete spec.files['/oxide/data/up'];
  const sb = createSandbox({ tree: spec });
  await sb.load();
  // Обход исключений: обычные записи выбраны, а в ссылки он не заходит.
  const result = await expand(t, sb, ['/oxide/data'], ['/oxide/data/*/keep.json']);
  assert.ok(result.paths.includes('/oxide/data/Kits.json'), 'обычные файлы должны попасть в список');
  assert.deepEqual(
    result.paths.filter((path) => /^\/oxide\/data\/(root|maps|world)(\/|$)/.test(path)),
    [],
    'в список попало что-то через ссылку',
  );
  assert.ok(result.skipped.some((item) => item.path === '/oxide/data/root'));
  const { removed, run } = await wipe(t, sb, ['/oxide/data'], ['/oxide/data/*/keep.json']);
  assert.deepEqual(lostInstall(sb), [], 'обход исключений через ссылку root снёс установку');
  assert.deepEqual(removed.filter((path) => !path.startsWith('/oxide/data/')), []);
  assert.ok(sb.tree.exists('/oxide/data/Kits/keep.json'));
  // Ссылки внутри папки, которую удаляем по частям, удалить точно нельзя —
  // вайп не идёт целиком (R-3): обычные файлы тоже целы, ссылки названы.
  assert.ok(sb.tree.exists('/oxide/data/Kits.json'), 'вайп с пропущенными ссылками всё-таки удалял');
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('/oxide/data/root')), 'в причине отказа нет ссылки');
});

test('Обычный файл с правами 777 тоже не удаляется — так видно, почему', async (t) => {
  const spec = rustServerTree();
  delete spec.files['/oxide/data/shared'];
  spec.files['/oxide/data/Open.json'] = { content: '{}', mode: 0o777 };
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const result = await expand(t, sb, ['/oxide/data/*.json']);
  const open = result.skipped.find((item) => item.path === '/oxide/data/Open.json');
  assert.ok(open, 'файл с правами 777 должен попасть в skipped');
  assert.match(open.reason, /777/);
  assert.equal(result.paths.includes('/oxide/data/Open.json'), false);
});

test('Пикер: у записей есть mode и maybeLink — ссылку можно пометить во вкладке', async (t) => {
  const sb = createSandbox({ tree: treeWithLinks() });
  await sb.load();
  const res = await sb.call('owner', 'GET', '/servers/srv1/files', { query: { path: '/oxide/data' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byName = Object.fromEntries(res.body.data.entries.map((entry) => [entry.name, entry]));
  t.note(`root: ${JSON.stringify(byName.root)}; Kits.json: ${JSON.stringify(byName['Kits.json'])}`);
  assert.equal(byName.root.maybeLink, true);
  assert.equal(byName.root.mode, 0o777);
  assert.equal(byName['Kits.json'].maybeLink, false);
  assert.equal(byName.Kits.maybeLink, false);
});

test('Цель «/oxide/data/world/**», где world — ссылка: ни сама ссылка, ни то, что за ней, не удаляется', async (t) => {
  const spec = treeWithLinks();
  delete spec.files['/oxide/data/backup'];
  delete spec.files['/oxide/data/up'];
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const result = await expand(t, sb, ['/oxide/data/world/**']);
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.skipped.map((item) => item.path), ['/oxide/data/world']);
  const { removed } = await wipe(t, sb, ['/oxide/data/world/**']);
  assert.deepEqual(removed, [], 'через ссылку world удалены файлы мира');
  assert.deepEqual(lostInstall(sb), []);
});

test('Предел глубины «**» не срабатывает из-за ссылки: в ссылку «**» не заходит и без предела', async (t) => {
  const sb = createSandbox({
    tree: {
      files: {
        '/RustDedicated': 1024,
        '/a/top.json': '{}',
        '/a/b/link': { link: '../../c' },
        '/c/x.json': '{}',
      },
    },
  });
  await sb.load();
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const onlyLink = await sb.run(expandTargets(sb.ctx, server, ['/a/**/*.json'], [], { maxDepth: 2 }));
  t.note(`только ссылка на пределе: truncated=${onlyLink.truncated}, limitHit=${JSON.stringify(onlyLink.limitHit)}`);
  assert.equal(onlyLink.truncated, false);
  sb.tree.add('/a/b/real/y.json', '{}');
  const withDir = await sb.run(expandTargets(sb.ctx, server, ['/a/**/*.json'], [], { maxDepth: 2 }));
  t.note(`обычный каталог на пределе: truncated=${withDir.truncated}, limitHit=${JSON.stringify(withDir.limitHit)}`);
  assert.equal(withDir.limitHit?.kind, 'depth', 'обычный каталог за пределом глубины должен давать отметку');
});
