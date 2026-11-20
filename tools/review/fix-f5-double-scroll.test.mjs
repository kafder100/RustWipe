/**
 * Исполнитель F5, находка S11 (вид вкладки в оболочке Catalyst): двойная
 * прокрутка. На 375 px история прокручивалась вбок внутри карточки, шаги
 * ютились в ячейке ~220 px, а списки путей прокручивались внутри и без того
 * прокручиваемого окна.
 *
 * Должно: на узкой вкладке история — строками друг под другом (подписи у
 * ячеек), без прокрутки вбок; в окне на телефоне списки без своей прокрутки.
 *
 * Запуск: node tools/review/fix-f5-double-scroll.test.mjs
 */

import assert from 'node:assert/strict';
import { findAll, setup, test } from './fix-f5-ui-lib.mjs';

const RUN = {
  id: 'run_1',
  profileId: 'wipe_1',
  profileName: 'Еженедельный вайп',
  trigger: 'schedule',
  ok: true,
  startedAt: '2026-11-19T02:00:00.000Z',
  deletedCount: 2,
  steps: [],
};

async function css(ui) {
  return findAll(ui.document.documentElement, (node) => node.tagName === 'STYLE' && node.id === 'rust-autowipe-styles')[0]
    .textContent;
}

function block(text, head) {
  const start = text.indexOf(head);
  assert.ok(start >= 0, `нет блока ${head}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (!depth) return text.slice(start, i + 1);
    }
  }
  return '';
}

test('S11: на узкой вкладке история — строками, без прокрутки вбок', async () => {
  const ui = await setup({ runs: [RUN] });
  const narrow = block(await css(ui), '@container rw-tab (max-width:560px)');
  assert.ok(narrow.includes('.rw-root .rw-panel-block{overflow-x:visible}'), 'история всё ещё прокручивается вбок');
  assert.ok(narrow.includes('.rw-root .rw-table thead{display:none}'));
  assert.ok(/\.rw-root \.rw-table td\{[^}]*\}/.test(narrow), 'ячейки не перестраиваются');
  assert.ok(narrow.includes('td[data-label]::before'), 'у ячеек нет подписей в узком режиме');
  const cells = ui.findAll((node) => node.tagName === 'TD').map((node) => node.getAttribute('data-label'));
  assert.deepEqual(cells.slice(0, 5), ['Когда', 'Профиль', 'Источник', 'Результат', 'Удалено']);
});

test('S11: в окне на телефоне списки путей и предпросмотр без своей прокрутки', async () => {
  const ui = await setup();
  const text = await css(ui);
  const phone = [...text.matchAll(/@media \(max-width:720px\)\{/g)].map((match) => block(text, text.slice(match.index, match.index + 40))).join('\n');
  assert.ok(phone.includes('.rw-root .rw-modal .rw-paths,.rw-root .rw-modal .rw-pre{max-height:none}'), 'в окне на телефоне двойная прокрутка');
});
