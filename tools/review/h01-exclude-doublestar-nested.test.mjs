/**
 * Ревью RustWipe, гипотеза 1 (раздел 4.2), утверждение H1:
 * исключение с «**» не защищает файл внутри каталога, который целиком попал
 * под цель. Каталог удаляется вместе с исключённым файлом.
 *
 * Правильное поведение (руководство, раздел «Выбор каталогов и файлов»; подсказка
 * в редакторе «** — любая глубина»; ответ владельца «строго выбранные файлы»):
 * исключённое не удаляется ни при каком виде маски; плагин спускается внутрь
 * каталога и удаляет всё остальное. Предпросмотр не обещает удалить исключённое.
 *
 * Запуск: node tools/review/h01-exclude-doublestar-nested.test.mjs
 * Всё на подменах песочницы: «диск» в памяти, туннель, панель и часы поддельные.
 * Ссылки и junction из готового дерева убраны, чтобы проверять только маски
 * (ссылки — отдельная гипотеза 6).
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const KEEP = '/oxide/data/Kits/keep.json';
const PLAYERS = '/oxide/data/Kits/players.json';
const CFG_FILES = ['/server/rust/cfg/server.cfg', '/server/rust/cfg/users.cfg', '/server/rust/cfg/bans.cfg'];
const MAP = '/server/rust/proceduralmap.3000.12345.270.map';

/** Дерево сервера Rust из песочницы, но без ссылок и junction. */
function treeWithoutLinks() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  return spec;
}

/** Создать профиль так, как это делает вкладка: POST от владельца сервера. */
async function createProfile(sb, body) {
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Проверка исключений', schedule: { kind: 'weekly', weekday: 4, time: '05:00' }, ...body },
  });
  assert.equal(res.status, 200, `профиль не создан: ${JSON.stringify(res.body)}`);
  return sb.ctx.collection('profiles').findOne({ id: res.body.data.id });
}

async function previewPaths(sb, profile) {
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  assert.equal(res.status, 200, `предпросмотр не ответил: ${JSON.stringify(res.body)}`);
  return res.body.data.paths;
}

/** Пути из списка, удаление которых заденет target (сам target или его предок). */
const covering = (paths, target) => paths.filter((item) => target === item || target.startsWith(`${item}/`));

test('H1: исключение /oxide/**/keep.json защищает файл в каталоге, попавшем под цель /oxide/data/*', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const profile = await createProfile(sb, { targets: ['/oxide/data/*'], excludes: ['/oxide/**/keep.json'] });
  const shown = await previewPaths(sb, profile);
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  const removed = sb.tree.diff(before).removed;
  t.note(`предпросмотр: ${shown.join(', ')}`);
  t.note(`удалено с «диска»: ${removed.join(', ')}; прогон ok=${run.ok}`);

  assert.ok(sb.tree.exists(KEEP), `исключённый ${KEEP} удалён вместе с каталогом`);
  assert.deepEqual(covering(shown, KEEP), [], 'предпросмотр обещает удалить исключённый файл');
  assert.equal(sb.tree.exists(PLAYERS), false, 'остальное содержимое каталога по цели тоже должно удаляться');
  assert.deepEqual(
    removed.filter((item) => !item.startsWith('/oxide/data/')),
    [],
    'удалено что-то вне /oxide/data',
  );
});

test('H1: исключение /**/cfg защищает cfg при цели /server/* (как в пресете «Полный вайп»)', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const profile = await createProfile(sb, { targets: ['/server/*'], excludes: ['/**/cfg'] });
  const shown = await previewPaths(sb, profile);
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  const removed = sb.tree.diff(before).removed;
  t.note(`предпросмотр: ${shown.join(', ')}`);
  t.note(`удалено cfg: ${removed.filter((item) => item.includes('/cfg')).join(', ') || 'ничего'}; прогон ok=${run.ok}`);

  const lost = CFG_FILES.filter((item) => !sb.tree.exists(item));
  assert.deepEqual(lost, [], `исключённые настройки удалены: ${lost.join(', ')}`);
  assert.deepEqual(covering(shown, '/server/rust/cfg'), [], 'предпросмотр обещает удалить исключённый cfg');
  assert.equal(sb.tree.exists(MAP), false, 'файлы мира по цели /server/* должны удаляться');
});

test('контроль (должен проходить): то же исключение без ** — keep.json цел', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const profile = await createProfile(sb, { targets: ['/oxide/data/*'], excludes: ['/oxide/data/Kits/keep.json'] });
  const shown = await previewPaths(sb, profile);
  await sb.wipe(profile);
  t.note(`предпросмотр: ${shown.join(', ')}`);
  assert.ok(sb.tree.exists(KEEP));
  assert.equal(sb.tree.exists(PLAYERS), false);
  assert.deepEqual(covering(shown, KEEP), []);
});
