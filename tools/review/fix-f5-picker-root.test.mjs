/**
 * Исполнитель F5, находка L31-16: в корне пикера «Добавить маску «всё внутри»»
 * неактивна, а «Добавить текущий каталог» активна и кладёт «/». Сервер молча
 * выбрасывает «/», и «Сохранить» отвечает «Добавьте хотя бы один путь».
 *
 * Должно: в корне «Добавить текущий каталог» неактивна и объясняет почему;
 * отмеченные в корне файлы и папки добавляются как обычно.
 *
 * Запуск: node tools/review/fix-f5-picker-root.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const files = (path) => ({
  path,
  parent: null,
  breadcrumbs: [],
  entries: path === '/' ? [{ name: 'start.sh', path: '/start.sh', isDirectory: false, size: 1 }] : [],
});

async function openRoot(ui) {
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.click(ui.button('Выбрать в файлах…'), '«Выбрать в файлах…»');
  await ui.settle();
}

const pathTexts = (ui) => ui.findAll((node) => node.classList.contains('rw-path-text')).map((node) => node.textContent);

test('L31-16: в корне «Добавить текущий каталог» неактивна и «/» в список не попадает', async () => {
  const ui = await setup({ profiles: [], files });
  await openRoot(ui);
  const button = ui.button('Добавить текущий каталог');
  assert.ok(button, 'нет кнопки «Добавить текущий каталог»');
  assert.ok(button.disabled, 'в корне кнопка активна');
  assert.ok(/корень/.test(button.getAttribute('title') || ''), 'кнопка не объясняет, почему неактивна');
  ui.click(button);
  ui.click(ui.button('← Назад к профилю'), '«Назад к профилю»');
  assert.deepEqual(pathTexts(ui), [], 'в список попал «/»');
});

test('L31-16: отмеченный в корне файл добавляется как обычно', async () => {
  const ui = await setup({ profiles: [], files });
  await openRoot(ui);
  const row = ui.find((node) => node.classList.contains('rw-picker-row') && node.textContent.includes('start.sh'));
  ui.check(row.children.find((node) => node.tagName === 'INPUT'), true);
  const add = ui.buttonLike(/^Добавить выбранные/);
  assert.ok(add && !add.disabled, '«Добавить выбранные» неактивна');
  ui.click(add);
  await ui.settle();
  assert.deepEqual(pathTexts(ui), ['/start.sh']);
});
