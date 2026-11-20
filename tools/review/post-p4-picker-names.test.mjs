/**
 * Исполнитель P4, находка L32-4 (часть пикера).
 *
 * Панель меняет путь перед отправкой агенту: «\» превращается в «/», пробел
 * в конце обрезается. В пикере можно было отметить «Kits\data.json» — в
 * профиль ложился /oxide/data/Kits\data.json, а вайп удалял другой файл,
 * Kits/data.json. Backend уже присылает причину в ответе списка файлов
 * (nameProblem), но пикер её не смотрел.
 *
 * Должно: такое имя в пикере не отмечается (галочка неактивна), причина
 * видна в строке и в подсказке. В каталог с таким именем не зайти: панель
 * открыла бы другой каталог, и «Добавить текущий каталог» взял бы чужой.
 * Обычные имена — как раньше.
 *
 * Запуск: node tools/review/post-p4-picker-names.test.mjs
 */

import assert from 'node:assert/strict';
import { find, setup, test } from './fix-f5-ui-lib.mjs';

const SLASH = 'в имени есть «\\»: панель заменяет его на «/», и удалился бы другой путь. Не трогаем — удалите вручную';
const SPACE = 'имя кончается пробелом: панель обрезает его, и удалился бы другой путь. Не трогаем — удалите вручную';

const ENTRIES = [
  { name: 'Backup ', isDirectory: true, size: 0, nameProblem: SPACE },
  { name: 'Clans', isDirectory: true, size: 0, nameProblem: null },
  { name: 'Kits.json', isDirectory: false, size: 10, nameProblem: null },
  { name: 'Kits\\data.json', isDirectory: false, size: 10, nameProblem: SLASH },
  { name: 'player.blueprints.5.db ', isDirectory: false, size: 10, nameProblem: SPACE },
];

/** Любой каталог отвечает списком /oxide/data — пикер открывается сразу в нём. */
const files = () => ({
  path: '/oxide/data',
  parent: '/oxide',
  breadcrumbs: [
    { name: 'oxide', path: '/oxide' },
    { name: 'data', path: '/oxide/data' },
  ],
  entries: ENTRIES.map((entry) => ({ ...entry, path: `/oxide/data/${entry.name}` })),
});

async function openPicker() {
  const ui = await setup({ files });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.click(ui.button('Выбрать в файлах…'), '«Выбрать в файлах…»');
  await ui.settle();
  assert.ok(ui.text().includes('Выбор файлов и каталогов'), 'пикер не открылся');
  return ui;
}

/** Строка пикера по точному имени (с пробелом в конце, если он есть). */
function row(ui, name) {
  const found = ui.find(
    (node) =>
      node.classList.contains('rw-picker-row') &&
      node.children.some((child) => child.classList?.contains('rw-pname') && child.textContent === name),
  );
  assert.ok(found, `нет строки «${name}»`);
  return found;
}
const checkbox = (item) => find(item, (node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox');

for (const [name, reason] of [
  ['Kits\\data.json', 'В имени есть «\\»'],
  ['player.blueprints.5.db ', 'Имя кончается пробелом'],
]) {
  test(`L32-4: «${name}» — отметить нельзя, причина видна в строке и в подсказке`, async () => {
    const ui = await openPicker();
    const item = row(ui, name);
    assert.ok(checkbox(item)?.disabled, `галочку у «${name}» можно поставить — удалился бы другой путь`);
    assert.ok(item.textContent.includes(reason), `в строке не видно причины: ${item.textContent}`);
    assert.ok(String(checkbox(item).getAttribute('title')).includes(reason), 'у галочки нет подсказки с причиной');
  });
}

test('L32-4: в каталог «Backup » (пробел в конце) не зайти и не отметить — открылся бы другой каталог', async () => {
  const ui = await openPicker();
  const item = row(ui, 'Backup ');
  assert.ok(!find(item, (node) => node.tagName === 'BUTTON'), 'имя каталога — кнопка перехода');
  assert.ok(checkbox(item)?.disabled, 'галочку у «Backup » можно поставить');
  assert.ok(item.textContent.includes('Имя кончается пробелом'), item.textContent);
});

test('обычные имена — как раньше: галочка активна, в каталог можно зайти, путь добавляется', async () => {
  const ui = await openPicker();
  assert.ok(!checkbox(row(ui, 'Kits.json')).disabled, 'у обычного файла неактивна галочка');
  assert.ok(find(row(ui, 'Clans'), (node) => node.tagName === 'BUTTON' && node.textContent === 'Clans'), 'в обычный каталог не зайти');
  ui.check(checkbox(row(ui, 'Kits.json')), true);
  ui.click(ui.button('Добавить выбранные (1)'), '«Добавить выбранные (1)»');
  assert.ok(ui.text().includes('/oxide/data/Kits.json'), 'обычный файл не добавился');
});
