/**
 * Исполнитель F5, находка L31-11: после первой загрузки ошибки «Обновить» и
 * перезагрузки после действий не показывались. Пропала сеть или истекла
 * сессия — «Обновить» молча ничего не меняет; «Выключить» прошёл, а список
 * не перечитался — на карточке по-прежнему «Выключить».
 *
 * Должно: сообщение «Не удалось обновить данные: …» и пометка, что на экране
 * может быть старое состояние, с кнопкой «Повторить».
 *
 * Запуск: node tools/review/fix-f5-reload-errors.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

/** Подмена, у которой можно «уронить» чтение статуса. */
function flaky() {
  const control = { down: false };
  control.handle = (request) => {
    if (control.down && request.method === 'GET' && request.path.endsWith('/status')) {
      return { status: 401, json: { success: false, error: 'Unauthorized' } };
    }
    return undefined;
  };
  return control;
}

test('L31-11: «Обновить» не удалось — видна ошибка, старые данные помечены, «Повторить» работает', async () => {
  const net = flaky();
  const ui = await setup({ handle: net.handle });
  net.down = true;
  ui.click(ui.button('Обновить'), '«Обновить»');
  await ui.settle();
  assert.ok(ui.text().includes('Не удалось обновить данные: Unauthorized'), 'ошибка не показана');
  assert.ok(ui.text().includes('старое состояние'), 'нет пометки о старых данных');
  assert.ok(ui.text().includes('Еженедельный вайп'), 'старые данные пропали');
  net.down = false;
  ui.click(ui.button('Повторить'), '«Повторить»');
  await ui.settle();
  assert.ok(!ui.text().includes('Не удалось обновить'), 'пометка не ушла после удачного обновления');
});

test('L31-11: «Выключить» прошёл, а перечитать список не вышло — это видно', async () => {
  const net = flaky();
  const ui = await setup({
    handle: (request, state) => {
      if (request.method === 'PUT') {
        state.profiles[0] = { ...state.profiles[0], enabled: false };
        net.down = true;
        return { success: true, data: state.profiles[0] };
      }
      return net.handle(request);
    },
  });
  ui.click(ui.button('Выключить'), '«Выключить»');
  await ui.settle();
  assert.ok(ui.text().includes('Не удалось обновить данные'), 'неудачная перезагрузка после «Выключить» прошла молча');
});

test('ответ истории не массивом не роняет вкладку', async () => {
  const ui = await setup({ handle: (request) => (request.path.endsWith('/runs') ? { success: true, data: {} } : undefined) });
  assert.ok(ui.text().includes('Прогонов ещё не было'), 'вкладка не нарисовала историю');
});
