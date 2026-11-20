/**
 * Исполнитель F5, находка L31-3: выбор папки в пикере проходил без окна
 * с последствиями — «Добавить выбранные (1)», тост «Добавлено путей: 1»,
 * а плановый вайп удалял каталог целиком вместе с cfg.
 *
 * Должно (правила ревью 3.1, «выбор папок»): окно, где обычным текстом
 * сказано, что папка удалится целиком со всем содержимым, «Отмена» (назад
 * в пикер, отметки целы) и «Добавить». Отмеченные файлы — без окна.
 * Исключения папки защищают — для них окна нет.
 *
 * Запуск: node tools/review/fix-f5-folder-confirm.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const TREE = {
  '/': [{ name: 'server', isDirectory: true }],
  '/server': [{ name: 'rust', isDirectory: true }],
  '/server/rust': [
    { name: 'cfg', isDirectory: true },
    { name: 'proceduralmap.1.sav', isDirectory: false },
  ],
};

function files(path) {
  const parts = path.split('/').filter(Boolean);
  return {
    path,
    parent: null,
    breadcrumbs: parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` })),
    entries: (TREE[path] || []).map((entry) => ({ ...entry, size: 1, path: `${path === '/' ? '' : path}/${entry.name}` })),
  };
}

async function openPicker(ui, segments, which = 'targets') {
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Вайп identity');
  const section = ui.find(
    (node) =>
      node.classList.contains('rw-field') &&
      node.children[0]?.textContent === (which === 'targets' ? 'Что удалять (пути и маски)' : 'Исключения (не удалять)'),
  );
  ui.click(ui.button('Выбрать в файлах…', section), '«Выбрать в файлах…»');
  await ui.settle();
  for (const segment of segments) {
    ui.click(ui.button(segment, ui.find((node) => node.classList.contains('rw-picker-list'))), `каталога ${segment}`);
    await ui.settle();
  }
}

function check(ui, name) {
  const row = ui.find((node) => node.classList.contains('rw-picker-row') && node.textContent.includes(name));
  ui.check(row.children.find((node) => node.tagName === 'INPUT'), true);
}

const pathTexts = (ui) => ui.findAll((node) => node.classList.contains('rw-path-text')).map((node) => node.textContent);
const pickerOpen = (ui) => Boolean(ui.find((node) => node.classList.contains('rw-picker-list')));

test('L31-3: отмечена папка — окно с последствиями; «Отмена» возвращает в пикер, ничего не добавлено', async () => {
  const ui = await setup({ profiles: [], files });
  await openPicker(ui, ['server']);
  check(ui, 'rust');
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  const overlay = ui.overlays()[0];
  assert.ok(overlay && !pickerOpen(ui), 'окна подтверждения нет');
  assert.ok(overlay.textContent.includes('«/server/rust» — папка: при вайпе удалится целиком'), overlay.textContent);
  assert.ok(overlay.textContent.includes('Вернуть удалённое нельзя'));
  assert.ok(ui.button('Отмена', overlay) && ui.button('Добавить', overlay), 'в окне нет «Отмена» и «Добавить»');

  ui.click(ui.button('Отмена', overlay), '«Отмена»');
  assert.ok(pickerOpen(ui), '«Отмена» не вернула в пикер');
  assert.ok(ui.buttonLike(/^Добавить выбранные \(1\)/), 'отметка в пикере потерялась');
  ui.click(ui.button('← Назад к профилю'), '«Назад к профилю»');
  assert.deepEqual(pathTexts(ui), [], 'папка добавилась без подтверждения');
});

test('L31-3: подтверждение «Добавить» — папка и файл в списке целей', async () => {
  const ui = await setup({ profiles: [], files });
  await openPicker(ui, ['server', 'rust']);
  check(ui, 'cfg');
  check(ui, 'proceduralmap.1.sav');
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  const overlay = ui.overlays()[0];
  assert.ok(overlay.textContent.includes('«/server/rust/cfg» — папка'), 'в окне не названа папка');
  assert.ok(!overlay.textContent.includes('proceduralmap.1.sav» — папка'), 'файл назван папкой');
  ui.click(ui.button('Добавить', overlay), '«Добавить»');
  await ui.settle();
  assert.deepEqual(pathTexts(ui).sort(), ['/server/rust/cfg', '/server/rust/proceduralmap.1.sav']);
});

test('L31-3: только файлы — без окна, сразу в список', async () => {
  const ui = await setup({ profiles: [], files });
  await openPicker(ui, ['server', 'rust']);
  check(ui, 'proceduralmap.1.sav');
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  await ui.settle();
  assert.deepEqual(pathTexts(ui), ['/server/rust/proceduralmap.1.sav']);
});

test('L31-3: «Добавить текущий каталог» и «всё внутри» тоже спрашивают', async () => {
  const ui = await setup({ profiles: [], files });
  await openPicker(ui, ['server', 'rust']);
  ui.click(ui.button('Добавить текущий каталог'), '«Добавить текущий каталог»');
  assert.ok(ui.overlays()[0]?.textContent.includes('«/server/rust» — папка'), 'нет окна для текущего каталога');
  ui.click(ui.button('Отмена', ui.overlays()[0]), '«Отмена»');
  ui.click(ui.button('Добавить маску «всё внутри»'), '«всё внутри»');
  const overlay = ui.overlays()[0];
  assert.ok(overlay?.textContent.includes('Всё содержимое папки «/server/rust»'), 'нет окна для «всё внутри»');
  ui.click(ui.button('Добавить', overlay), '«Добавить»');
  await ui.settle();
  assert.deepEqual(pathTexts(ui), ['/server/rust/*']);
});

test('исключения: папка в исключения — без окна', async () => {
  const ui = await setup({ profiles: [], files });
  await openPicker(ui, ['server', 'rust'], 'excludes');
  check(ui, 'cfg');
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  await ui.settle();
  assert.deepEqual(pathTexts(ui), ['/server/rust/cfg']);
});
