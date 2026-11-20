/**
 * Исполнитель F5, находка L31-13: подпись галочки всегда «за 5 минут», а
 * выключенные в настройках предупреждения во вкладке не видны: зелёный
 * «Чат: ок» после теста и отмеченная галочка, хотя игроки ничего не получат.
 *
 * Должно: минуты — из status.wipeWarning.minutes; при enabled: false — пометка
 * в шапке (без «Чат: ок»), подсказка у галочки и честный тост после теста.
 *
 * Запуск: node tools/review/fix-f5-warning-settings.test.mjs
 */

import assert from 'node:assert/strict';
import { makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

const header = (ui) => ui.find((node) => node.tagName === 'HEADER')?.textContent ?? '';
const warnLabel = (ui) => ui.find((node) => node.tagName === 'LABEL' && /Предупреждать в чате/.test(node.textContent))?.textContent ?? '';

test('L31-13: подпись галочки берёт минуты из настроек (10 мин)', async () => {
  const ui = await setup({ status: makeStatus({ wipeWarning: { enabled: true, minutes: 10, text: '', state: null } }) });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  assert.ok(warnLabel(ui).includes('за 10 мин'), `подпись: «${warnLabel(ui)}»`);
  assert.ok(!ui.text().includes('выключены в настройках'), 'лишняя пометка при включённых предупреждениях');
});

test('L31-13: предупреждения выключены — пометка в шапке вместо «Чат: ок», подсказка у галочки', async () => {
  const state = { ok: true, text: '[тест] Вайп сервера через 5 мин', at: '2026-11-20T10:00:00.000Z' };
  const ui = await setup({ status: makeStatus({ wipeWarning: { enabled: false, minutes: 5, text: '', state } }) });
  assert.ok(header(ui).includes('Предупреждения в чате выключены'), `шапка: ${header(ui)}`);
  assert.ok(!header(ui).includes('Чат: ок'), 'в шапке «Чат: ок», хотя рассылка выключена');
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  assert.ok(ui.text().includes('Предупреждения выключены в настройках плагина'), 'нет подсказки у галочки');
});

test('L31-13: «Тест предупреждения» при выключенной рассылке честно говорит, что перед вайпом ничего не уйдёт', async () => {
  const ui = await setup({
    status: makeStatus({ wipeWarning: { enabled: false, minutes: 5, text: '', state: null } }),
    handle: (request) =>
      request.path.endsWith('/warn-test') ? { success: true, data: { text: '[тест] Вайп сервера через 5 мин' } } : undefined,
  });
  ui.click(ui.button('Тест предупреждения'), '«Тест предупреждения»');
  await ui.settle();
  assert.ok(/не уйдут: они выключены/.test(ui.toast()), `тост: «${ui.toast()}»`);
});
