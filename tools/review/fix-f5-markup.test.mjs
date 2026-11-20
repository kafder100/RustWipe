/**
 * Исполнитель F5, находка S12 (вид вкладки в оболочке Catalyst): чип «сервер ·
 * статус» повторял шапку панели над вкладкой; второй <main> внутри <main>
 * панели; заголовки h3/h4 без h2.
 *
 * Должно: без повтора имени и статуса сервера в шапке вкладки, без <main>,
 * заголовок вкладки — h2, разделы — h3, профили — h4.
 *
 * Запуск: node tools/review/fix-f5-markup.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

test('S12: шапка вкладки не повторяет «сервер · статус» из шапки панели', async () => {
  const ui = await setup();
  const header = ui.find((node) => node.tagName === 'HEADER');
  assert.ok(header, 'нет шапки вкладки');
  assert.ok(!header.textContent.includes('Rust EU #1 · работает'), `в шапке вкладки: ${header.textContent}`);
});

test('S12: без второго <main>, заголовки по порядку h2 → h3 → h4', async () => {
  const ui = await setup();
  assert.equal(ui.findAll((node) => node.tagName === 'MAIN').length, 0, 'вкладка рисует свой <main>');
  const headings = ui.findAll((node) => /^H[1-6]$/.test(node.tagName)).map((node) => [node.tagName, node.textContent.trim()]);
  assert.deepEqual(headings[0], ['H2', 'Rust AutoWipe'], `первый заголовок: ${JSON.stringify(headings[0])}`);
  assert.ok(headings.some(([tag, text]) => tag === 'H3' && text.startsWith('Профили вайпа')), 'нет раздела «Профили вайпа»');
  assert.ok(headings.some(([tag, text]) => tag === 'H3' && text.startsWith('История прогонов')), 'нет раздела «История прогонов»');
  assert.ok(headings.some(([tag]) => tag === 'H4'), 'нет заголовка профиля');
  assert.ok(!headings.some(([tag]) => tag === 'H1'), 'вкладка рисует свой h1');
});
