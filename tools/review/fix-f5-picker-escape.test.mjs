/**
 * Исполнитель F5, находки H17a, H17b, H17c (договорённость К1, часть вкладки).
 *
 * Путь, выбранный в пикере, — буквальный. Если в имени файла или каталога есть
 * «*», «?» или «[», вкладка экранирует их: «*» → «[*]», «?» → «[?]», «[» → «[[]».
 * Так выбранное имя не становится маской и вайп не захватывает соседей.
 * Обычные имена не меняются, у кнопки «всё внутри» маской остаётся только «/*».
 *
 * Здесь проверяется только вкладка: какие пути она кладёт в профиль и
 * отправляет при сохранении. Что backend понимает «[x]» — часть F1, это
 * проверяют h17a/h17b/h17c-*.test.mjs (они проходят после сведения с F1).
 *
 * Запуск: node tools/review/fix-f5-picker-escape.test.mjs
 * Добавление папки спрашивает подтверждение (L31-3) — тест его подтверждает.
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const dir = (name) => ({ name, isDirectory: true, size: 0 });
const file = (name) => ({ name, isDirectory: false, size: 10 });

const TREE = {
  '/': [dir('oxide')],
  '/oxide': [dir('data')],
  '/oxide/data': [dir('Clans'), dir('Skins'), dir('Backups'), file('ZoneManager.json')],
  '/oxide/data/Clans': [file('*.json'), file('A?.json'), file('[x].cfg'), file('a]b.txt'), file('AB.json')],
  '/oxide/data/Skins': [dir('Bob*'), dir('Team?'), dir('Bob')],
  '/oxide/data/Skins/Bob*': [file('skins.json')],
  '/oxide/data/Skins/Team?': [file('skins.json')],
  '/oxide/data/Skins/Bob': [file('skins.json')],
  '/oxide/data/Backups': [dir('**')],
  '/oxide/data/Backups/**': [file('note.txt')],
};

function files(path) {
  const entries = (TREE[path] || []).map((entry) => ({
    ...entry,
    path: `${path === '/' ? '' : path}/${entry.name}`,
  }));
  const parts = path.split('/').filter(Boolean);
  return {
    path,
    parent: null,
    breadcrumbs: parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` })),
    entries,
  };
}

async function openEditor(ui) {
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Проверка имён');
}

async function openPicker(ui, segments) {
  ui.click(ui.button('Выбрать в файлах…'), '«Выбрать в файлах…»');
  await ui.settle();
  for (const segment of segments) {
    const list = ui.find((node) => node.classList.contains('rw-picker-list'));
    const button = ui.button(segment, list);
    ui.click(button, `каталога «${segment}»`);
    await ui.settle();
  }
}

function checkRow(ui, name) {
  const row = ui.find(
    (node) =>
      node.classList.contains('rw-picker-row') &&
      node.children.some((child) => child.classList?.contains('rw-pname') && child.textContent.trim() === name),
  );
  assert.ok(row, `в пикере нет строки «${name}»`);
  const box = row.children.find((child) => child.tagName === 'INPUT');
  ui.check(box, true);
}

/** Добавление папки спрашивает подтверждение (L31-3) — подтверждаем. */
async function confirmFolder(ui) {
  const overlay = ui.overlays()[0];
  const button = overlay && ui.button('Добавить', overlay);
  if (button && !ui.button('Сохранить')) ui.click(button, '«Добавить» в окне подтверждения');
  await ui.settle();
}

function editorTargets(ui) {
  return ui
    .findAll((node) => node.classList.contains('rw-path-text'))
    .map((node) => node.textContent);
}

async function save(ui) {
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
  const post = ui.requests.find((request) => request.method === 'POST' && request.path.endsWith('/profiles'));
  assert.ok(post, `профиль не отправлен: ${ui.toast()}`);
  return post.body.targets;
}

test('H17a: отмеченные файлы со «*», «?» и «[» в имени уходят буквально, обычные — без изменений', async () => {
  const ui = await setup({ profiles: [], files });
  await openEditor(ui);
  await openPicker(ui, ['oxide', 'data', 'Clans']);
  for (const name of ['*.json', 'A?.json', '[x].cfg', 'a]b.txt', 'AB.json']) checkRow(ui, name);
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  await ui.settle();
  const expected = [
    '/oxide/data/Clans/[*].json',
    '/oxide/data/Clans/A[?].json',
    '/oxide/data/Clans/[[]x].cfg',
    '/oxide/data/Clans/a]b.txt',
    '/oxide/data/Clans/AB.json',
  ];
  assert.deepEqual([...editorTargets(ui)].sort(), [...expected].sort(), 'в списке целей не те пути');
  assert.deepEqual([...(await save(ui))].sort(), [...expected].sort(), 'при сохранении ушли не те пути');
});

test('H17a: отмеченный каталог «**» уходит как «[*][*]», а не как маска любой глубины', async () => {
  const ui = await setup({ profiles: [], files });
  await openEditor(ui);
  await openPicker(ui, ['oxide', 'data', 'Backups']);
  checkRow(ui, '**');
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  await confirmFolder(ui);
  assert.deepEqual(await save(ui), ['/oxide/data/Backups/[*][*]']);
});

test('H17b: «Добавить текущий каталог» в каталоге «Team?» кладёт буквальный путь', async () => {
  const ui = await setup({ profiles: [], files });
  await openEditor(ui);
  await openPicker(ui, ['oxide', 'data', 'Skins', 'Team?']);
  ui.click(ui.button('Добавить текущий каталог'), '«Добавить текущий каталог»');
  await confirmFolder(ui);
  assert.deepEqual(await save(ui), ['/oxide/data/Skins/Team[?]']);
});

test('H17c: «всё внутри» каталога «Bob*» — буквальное имя каталога и маска «/*» в конце', async () => {
  const ui = await setup({ profiles: [], files });
  await openEditor(ui);
  await openPicker(ui, ['oxide', 'data', 'Skins', 'Bob*']);
  ui.click(ui.button('Добавить маску «всё внутри»'), '«Добавить маску «всё внутри»»');
  await confirmFolder(ui);
  assert.deepEqual(await save(ui), ['/oxide/data/Skins/Bob[*]/*']);
});

test('обычный каталог: «всё внутри» по-прежнему /oxide/data/Skins/Bob/*', async () => {
  const ui = await setup({ profiles: [], files });
  await openEditor(ui);
  await openPicker(ui, ['oxide', 'data', 'Skins', 'Bob']);
  ui.click(ui.button('Добавить маску «всё внутри»'), '«Добавить маску «всё внутри»»');
  await confirmFolder(ui);
  assert.deepEqual(await save(ui), ['/oxide/data/Skins/Bob/*']);
});
