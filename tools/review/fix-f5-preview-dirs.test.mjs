/**
 * Исполнитель F5, находка H5b (договорённость К2, часть вкладки) и текст
 * о пределе из L31-19.
 *
 * Окно «Что будет удалено» показывало папку одной строкой «/server/rust»,
 * без пометки, а вайп удаляет её со всем содержимым. При обрезке списка
 * писало «Список обрезан лимитом (500 путей)», хотя предел бывает и другой.
 *
 * Должно (К2): у путей из directories пометка «папка — удалится целиком со
 * всем содержимым»; при truncated — предупреждение, что вайп с такими путями
 * не пойдёт, и какой предел сработал (limitHit); skipped — списком с причинами.
 * Старый ответ без этих полей показывается как раньше.
 *
 * Запуск: node tools/review/fix-f5-preview-dirs.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

function previewWith(data) {
  return (request) =>
    request.path.endsWith('/preview')
      ? { success: true, data: { server: { name: 'Rust EU #1', status: 'running' }, ...data } }
      : undefined;
}

async function openPreview(ui) {
  ui.click(ui.button('Что будет удалено'), '«Что будет удалено»');
  await ui.settle();
  const modal = ui.modal();
  assert.ok(modal, 'окно предпросмотра не открылось');
  return modal;
}

const lines = (modal) =>
  modal.children
    .flatMap((child) => (child.classList?.contains('rw-pre') ? child.children : []))
    .map((line) => line.textContent);

test('H5b: папка помечена — удалится целиком со всем содержимым; файл — без пометки', async () => {
  const ui = await setup({
    handle: previewWith({ paths: ['/server/rust', '/server/x.sav'], directories: ['/server/rust'], count: 2, truncated: false }),
  });
  const modal = await openPreview(ui);
  const shown = lines(modal);
  assert.ok(shown.some((line) => line.startsWith('/server/rust') && line.includes('папка: удалится целиком')), shown.join(' | '));
  assert.ok(shown.some((line) => line === '/server/x.sav'), 'у файла лишняя пометка');
  assert.ok(modal.textContent.includes('из них папок: 1'));
});

test('К2: список обрезан — вайп не пойдёт, сказано, какой предел', async () => {
  const ui = await setup({
    handle: previewWith({
      paths: ['/oxide/data/a.json'],
      directories: [],
      count: 1,
      truncated: true,
      limitHit: { kind: 'listings', detail: '250 каталогов' },
    }),
  });
  const modal = await openPreview(ui);
  assert.ok(modal.textContent.includes('Вайп с такими путями не пойдёт'), modal.textContent);
  assert.ok(modal.textContent.includes('просмотрено слишком много каталогов (250 каталогов)'), modal.textContent);
  assert.ok(!modal.textContent.includes('лимитом (500 путей)'), 'остался старый текст про 500 путей');
});

test('К2: пропущенные пути показаны с причиной', async () => {
  const ui = await setup({
    handle: previewWith({
      paths: [],
      count: 0,
      truncated: false,
      skipped: [{ path: '/oxide/data/link', reason: 'это ссылка — не удаляется' }],
    }),
  });
  const modal = await openPreview(ui);
  assert.ok(modal.textContent.includes('Пропущено: 1'));
  assert.ok(modal.textContent.includes('/oxide/data/link — Это ссылка — не удаляется'), modal.textContent);
});

test('старый ответ без directories и skipped — как раньше, без ошибок', async () => {
  const ui = await setup({ handle: previewWith({ paths: ['/server/rust'], count: 1, truncated: false }) });
  const modal = await openPreview(ui);
  assert.deepEqual(lines(modal), ['/server/rust']);
});
