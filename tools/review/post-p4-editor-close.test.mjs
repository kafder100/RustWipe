/**
 * Исполнитель P4, находка L31-18 (часть) и замечание к документации.
 *
 * Esc в редакторе с несохранёнными правками спрашивает «Закрыть без
 * сохранения?», а кнопки «Закрыть» (вверху окна) и «Отмена» (внизу)
 * закрывали редактор молча — набранный профиль пропадал от одного промаха.
 *
 * Должно: «Закрыть» и «Отмена» при несохранённых правках спрашивают так же,
 * как Esc. «Отмена» в вопросе возвращает в тот же редактор с правками,
 * «Закрыть без сохранения» закрывает. Без правок — закрывают сразу.
 *
 * Запуск: node tools/review/post-p4-editor-close.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const dialog = (ui) => ui.find((node) => node.getAttribute('role') === 'dialog');
const asked = (ui) => dialog(ui)?.getAttribute('aria-label') === 'Закрыть без сохранения?';
const editorOpen = (ui) => /профиль вайпа$/.test(dialog(ui)?.getAttribute('aria-label') || '');
/** Кнопка внизу окна редактора (в ряду «Отмена» / «Сохранить»). */
const footerCancel = (ui) =>
  ui.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Отмена' && node.parentNode?.classList.contains('rw-modal-actions'));

for (const [label, press] of [
  ['«Закрыть»', (ui) => ui.click(ui.button('Закрыть', dialog(ui)), '«Закрыть»')],
  ['«Отмена»', (ui) => ui.click(footerCancel(ui), '«Отмена» внизу редактора')],
]) {
  test(`L31-18: ${label} при несохранённых правках спрашивает «Закрыть без сохранения?»`, async () => {
    const ui = await setup({ profiles: [] });
    ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
    ui.type(ui.field('Название'), 'Вайп карты');
    ui.addTarget('/server/*/proceduralmap.*.sav');
    press(ui);
    assert.ok(asked(ui), `${label} закрыл редактор с правками без вопроса`);

    // «Отмена» в вопросе — назад в тот же редактор, правки на месте.
    ui.click(ui.button('Отмена', dialog(ui)), '«Отмена» в вопросе');
    assert.ok(editorOpen(ui), 'после «Отмена» в вопросе редактор не вернулся');
    assert.equal(ui.field('Название')?.value, 'Вайп карты', 'после «Отмена» в вопросе правки пропали');
    assert.ok(ui.text().includes('/server/*/proceduralmap.*.sav'), 'после «Отмена» в вопросе пропал путь');

    // «Закрыть без сохранения» — закрывает; ничего не сохранено.
    press(ui);
    ui.click(ui.button('Закрыть без сохранения'), '«Закрыть без сохранения»');
    await ui.settle();
    assert.ok(!dialog(ui), 'редактор не закрылся');
    assert.equal(ui.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/profiles')).length, 0);
  });

  test(`L31-18: ${label} без правок закрывает сразу`, async () => {
    const ui = await setup();
    ui.click(ui.button('Изменить'), '«Изменить»');
    assert.ok(editorOpen(ui), 'редактор не открылся');
    press(ui);
    assert.ok(!dialog(ui), `${label} без правок не закрыл редактор`);
  });
}
