/**
 * F1, находка H1 (и случай G6 из L34-4): исключение с «**» не защищало файл
 * внутри каталога, который целиком попал под цель. canMatchDescendant
 * отсекал путь по длине раньше, чем видел «**», и каталог уходил на удаление
 * целиком вместе с исключённым файлом.
 *
 * Правильное поведение (ответ владельца №3 «строго выбранные файлы»;
 * подсказка редактора «** — любая глубина»): исключённое не удаляется ни при
 * какой маске; плагин заходит в каталог и удаляет остальное. Заходит он
 * только в каталоги — файлы не листает, иначе быстро кончится предел запросов.
 *
 * Готовый тест нашедшего — h01-exclude-doublestar-nested.test.mjs; здесь —
 * случаи, которых там нет: цель — сам каталог-предок, файл лежит прямо
 * в нём, «**» в начале шаблона, глубокая вложенность.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-exclude-doublestar.test.mjs
 */

import assert from 'node:assert/strict';

import { canMatchDescendant } from '../../rust-autowipe/backend/lib/glob.js';
import { createSandbox, test } from './sandbox.mjs';

const KEEPS = ['/oxide/data/keep.json', '/oxide/data/Kits/keep.json', '/oxide/data/Kits/sub/deep/keep.json'];
const OTHERS = [
  '/oxide/data/Kits.json',
  '/oxide/data/Kits/players.json',
  '/oxide/data/Kits/sub/deep/cache.json',
  '/oxide/data/Empty/cache.json',
];

function tree() {
  const files = { '/RustDedicated': 1024, '/oxide/plugins/Kits.cs': '// plugin', '/oxide/config/Kits.json': '{}' };
  for (const path of KEEPS) files[path] = '{"keep":true}';
  for (const path of OTHERS) files[path] = '{}';
  return { files };
}

async function wipe(t, targets, excludes) {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets, excludes });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const lists = sb.tunnel.paths('list');
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`delete: ${sb.tunnel.paths('delete').join(', ')}; ok=${run.ok}`);
  t.note(`list (${lists.length}): ${lists.join(', ')}`);
  return { sb, removed, lists, run };
}

/** Запросы list к файлам: их быть не должно. */
function listsOfFiles(sb, lists) {
  return lists.filter((path) => sb.tree.read(path) !== null);
}

test('canMatchDescendant видит «**» на любой глубине', () => {
  assert.equal(canMatchDescendant('/oxide/**/keep.json', '/oxide/data/Kits'), true);
  assert.equal(canMatchDescendant('/oxide/**/keep.json', '/oxide/data/Kits/sub/deep'), true);
  assert.equal(canMatchDescendant('/**/keep.json', '/oxide'), true);
  assert.equal(canMatchDescendant('/oxide/**', '/oxide/data'), true);
  assert.equal(canMatchDescendant('/oxide/data/**/keep.json', '/oxide/data'), true, '«**» может быть и нулём каталогов');
  assert.equal(canMatchDescendant('/oxide/**/keep.json', '/server/rust'), false, 'чужая ветка');
  // Шаблоны без «**» — как раньше.
  assert.equal(canMatchDescendant('/oxide/data/*/keep.json', '/oxide/data/Kits'), true);
  assert.equal(canMatchDescendant('/oxide/data/*/keep.json', '/oxide/data/Kits/keep.json'), false);
  assert.equal(canMatchDescendant('/server/*/cfg', '/server/rust/sv.db'), false);
  assert.equal(canMatchDescendant('/server/*/cfg', '/server/rust'), true);
  assert.equal(canMatchDescendant('/a/b', '/a/b'), false);
});

test('H1/G6: цель — весь каталог /oxide/data, исключение /oxide/**/keep.json — все keep.json целы', async (t) => {
  const { sb, removed, lists } = await wipe(t, ['/oxide/data'], ['/oxide/**/keep.json']);
  assert.deepEqual(KEEPS.filter((path) => !sb.tree.exists(path)), [], 'удалён исключённый keep.json');
  assert.deepEqual(OTHERS.filter((path) => sb.tree.exists(path)), [], 'остальное в /oxide/data должно удалиться');
  assert.deepEqual(removed.filter((path) => !path.startsWith('/oxide/data/')), [], 'удалено что-то вне цели');
  assert.deepEqual(listsOfFiles(sb, lists), [], 'плагин листал файлы — так быстро кончится предел запросов');
});

test('H1: цель /oxide/* (предок), исключение /oxide/data/**/keep.json — keep.json на всех уровнях целы', async (t) => {
  const { sb, lists } = await wipe(t, ['/oxide/*'], ['/oxide/data/**/keep.json']);
  assert.deepEqual(KEEPS.filter((path) => !sb.tree.exists(path)), []);
  assert.deepEqual(OTHERS.filter((path) => sb.tree.exists(path)), []);
  assert.equal(sb.tree.exists('/oxide/plugins/Kits.cs'), false, 'соседний каталог без исключённого удаляется целиком');
  assert.equal(lists.includes('/oxide/plugins'), false, 'в каталог без исключённого заходить не нужно');
  assert.deepEqual(listsOfFiles(sb, lists), []);
});

test('H1: исключение «**» в начале — /**/keep.json — при цели /oxide/data/*', async (t) => {
  const { sb, lists } = await wipe(t, ['/oxide/data/*'], ['/**/keep.json']);
  assert.deepEqual(KEEPS.filter((path) => !sb.tree.exists(path)), []);
  assert.deepEqual(OTHERS.filter((path) => sb.tree.exists(path)), []);
  assert.deepEqual(listsOfFiles(sb, lists), []);
});
