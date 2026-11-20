/**
 * Исполнитель F5, находка L31-18 (часть): обновление страницы или закрытие
 * вкладки браузера теряли несохранённый профиль без вопроса.
 *
 * Должно: при несохранённых правках в редакторе браузер спрашивает «Уйти со
 * страницы?» (beforeunload). Без правок, после сохранения и после «Отмена» —
 * не спрашивает. «Назад» браузера не перехватывается (см. итог исполнителя).
 *
 * Запуск: node tools/review/fix-f5-unsaved.test.mjs
 *
 * Правка исполнителя P4: «Отмена» в редакторе с правками теперь сначала
 * спрашивает «Закрыть без сохранения?» (L31-18), тест подтверждает вопрос.
 * Суть проверки не менялась.
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

/** Событие beforeunload, как его шлёт браузер: true — браузер спросит. */
function unload(ui) {
  let asked = false;
  const event = {
    type: 'beforeunload',
    returnValue: undefined,
    preventDefault() {
      asked = true;
    },
  };
  for (const handler of ui.winListeners.beforeunload || []) {
    const result = handler(event);
    if (typeof result === 'string') asked = true;
  }
  return asked || event.returnValue === '';
}

async function editor(ui) {
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
}

test('L31-18: правки в редакторе — браузер спросит перед уходом', async () => {
  const ui = await setup({ profiles: [] });
  await editor(ui);
  assert.equal(unload(ui), false, 'спрашивает, хотя правок нет');
  ui.type(ui.field('Название'), 'Вайп карты');
  assert.equal(unload(ui), true, 'несохранённый профиль пропадёт без вопроса');
});

test('L31-18: набранное, но не добавленное исключение — тоже правка', async () => {
  const ui = await setup({ profiles: [] });
  await editor(ui);
  ui.type(ui.input((node) => node.getAttribute('placeholder') === 'например /server/*/cfg'), '/server/rust/cfg');
  assert.equal(unload(ui), true);
});

test('L31-18: после «Отмена» и после сохранения — не спрашивает', async () => {
  const ui = await setup({ profiles: [] });
  await editor(ui);
  ui.type(ui.field('Название'), 'Вайп карты');
  ui.click(ui.button('Отмена'), '«Отмена»');
  // С правками «Отмена» сначала спрашивает (L31-18): пока открыт вопрос, правки не брошены.
  assert.equal(unload(ui), true, 'пока открыт вопрос «Закрыть без сохранения?», правки пропадут без вопроса');
  ui.click(ui.button('Закрыть без сохранения'), '«Закрыть без сохранения»');
  assert.equal(unload(ui), false, 'спрашивает после «Отмена»');

  await editor(ui);
  ui.type(ui.field('Название'), 'Вайп карты');
  ui.addTarget('/server/*/proceduralmap.*.sav');
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
  assert.ok(!ui.modal(), `профиль не сохранился: ${ui.toast()}`);
  assert.equal(unload(ui), false, 'спрашивает после сохранения');
});
