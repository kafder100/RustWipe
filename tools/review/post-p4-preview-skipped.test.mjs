/**
 * Исполнитель P4, регрессии R1-1 и R1-2 (в сводке — R-3, часть вкладки).
 *
 * Пути, похожие на ссылку (права 777), и имена, которые нельзя передать
 * агенту точно, раскрытие пропускает (skipped). Теперь вайп с такими
 * пропусками не начинается вовсе: лучше не вайпать, чем вайпнуть наполовину
 * (правка backend в этой же серии). А «Что будет удалено» прятало пропуски
 * в свёрнутый список внизу и не говорило, что вайп не пойдёт.
 *
 * Должно: в предпросмотре заметная пометка — сколько путей пропущено и что,
 * пока они есть, вайп не начнётся; список пропущенных с причинами раскрыт
 * сразу. Без пропусков — пометки нет.
 *
 * Запуск: node tools/review/post-p4-preview-skipped.test.mjs
 */

import assert from 'node:assert/strict';
import { find, findAll, setup, test } from './fix-f5-ui-lib.mjs';

const LINK =
  'возможно, это ссылка (права 777): агент удалил бы не ссылку, а то, куда она ведёт';
const NAME = 'в имени есть «\\»: панель заменяет его на «/», и удалился бы другой путь';

function previewWith(data) {
  return (request) =>
    request.path.endsWith('/preview')
      ? { success: true, data: { server: { name: 'Rust EU #1', status: 'running' }, truncated: false, ...data } }
      : undefined;
}

async function openPreview(data) {
  const ui = await setup({ handle: previewWith(data) });
  ui.click(ui.button('Что будет удалено'), '«Что будет удалено»');
  await ui.settle();
  const modal = ui.modal();
  assert.ok(modal, 'окно предпросмотра не открылось');
  return modal;
}

const notices = (modal) => findAll(modal, (node) => node.classList.contains('rw-notice')).map((node) => node.textContent);

test('R-3: есть пропущенные пути — сказано, что пока они есть, вайп не начнётся', async () => {
  const modal = await openPreview({
    paths: ['/oxide/data/Kits.json'],
    count: 1,
    skipped: [
      { path: '/oxide/data/Backpacks', reason: LINK },
      { path: '/oxide/data/Kits\\old.json', reason: NAME },
    ],
  });
  const notice = notices(modal).find((text) => text.includes('вайп не начнётся'));
  assert.ok(notice, `нет пометки, что вайп не начнётся: ${notices(modal).join(' | ') || 'пометок нет'}`);
  assert.ok(notice.includes('Пропущено путей: 2'), notice);
  assert.ok(notice.includes('Пока они есть'), notice);
  const bad = find(modal, (node) => node.classList.contains('rw-notice') && node.textContent === notice);
  assert.ok(bad.classList.contains('bad'), 'пометка не выделена как ошибка');
});

test('R-3: список пропущенных с причинами раскрыт сразу, а не спрятан', async () => {
  const modal = await openPreview({ paths: [], count: 0, skipped: [{ path: '/oxide/data/Backpacks', reason: LINK }] });
  const list = find(modal, (node) => node.tagName === 'DETAILS' && node.textContent.startsWith('Пропущено: 1'));
  assert.ok(list, 'нет списка пропущенных');
  assert.ok(list.hasAttribute('open'), 'список пропущенных свёрнут');
  assert.ok(list.textContent.includes('/oxide/data/Backpacks — Возможно, это ссылка (права 777)'), list.textContent);
});

test('пропусков нет — пометки про пропуски нет', async () => {
  const modal = await openPreview({ paths: ['/oxide/data/Kits.json'], count: 1, skipped: [] });
  assert.ok(!notices(modal).some((text) => text.includes('Пропущено')), notices(modal).join(' | '));
  assert.ok(!modal.textContent.includes('вайп не начнётся'));
});
