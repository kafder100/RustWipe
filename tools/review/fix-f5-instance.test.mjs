/**
 * Исполнитель F5, находка S1 (вид вкладки в оболочке Catalyst).
 *
 * Панель передаёт вкладке только serverId и при перерисовке зовёт ref с тем
 * же узлом. Если сервер сменили, не уходя с вкладки («Назад» браузера на ту
 * же вкладку другого сервера), на том же узле запускался второй экземпляр,
 * а таймеры первого (тост 4,5 с, обновление истории, поздний ответ) рисовали
 * профили сервера A под шапкой сервера B.
 *
 * Должно: при смене сервера старый экземпляр останавливается; при уходе со
 * вкладки (ref(null), узел убран) и при onUnmount бандла — тоже.
 *
 * Запуск: node tools/review/fix-f5-instance.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

const SERVERS = {
  srv1: { name: 'Сервер A', profile: 'Профиль сервера A' },
  srv2: { name: 'Сервер B', profile: 'Профиль сервера B' },
};

/** Подмена API на два сервера: у каждого свой статус и свой профиль. */
function twoServers(request) {
  const match = /^servers\/(srv[12])\/(status|profiles|runs|warn-test)$/.exec(request.path);
  if (!match) return undefined;
  const [, id, what] = match;
  const info = SERVERS[id];
  if (what === 'status') {
    return { success: true, data: makeStatus({ server: { id, name: info.name, uuid: `u-${id}`, nodeId: 'n', status: 'running' } }) };
  }
  if (what === 'profiles') {
    return { success: true, data: [makeProfile({ id: `p-${id}`, name: info.profile, serverId: id, serverName: info.name })] };
  }
  if (what === 'warn-test') return { success: true, data: { text: `[тест] ${info.name}` } };
  return { success: true, data: [] };
}

test('S1: смена сервера на той же вкладке — таймеры старого экземпляра не рисуют его профили', async () => {
  const ui = await setup({ handle: twoServers });
  assert.ok(ui.text().includes('Профиль сервера A'));
  // Действие на сервере A оставляет таймер (тост гаснет через 4,5 с).
  ui.click(ui.button('Тест предупреждения'), '«Тест предупреждения»');
  await ui.settle();
  // Панель перешла на ту же вкладку сервера B: тот же узел, другой serverId.
  await ui.remount('srv2');
  assert.ok(ui.text().includes('Профиль сервера B'), 'вкладка не показала сервер B');
  await ui.timers.advance(20000);
  assert.ok(!ui.text().includes('Профиль сервера A'), 'старый экземпляр нарисовал профили сервера A под сервером B');
  assert.ok(ui.text().includes('Профиль сервера B'), 'после таймеров пропал сервер B');
});

test('S1: тот же сервер при перерисовке панели — экземпляр не пересоздаётся и данные не грузятся заново', async () => {
  const ui = await setup({ handle: twoServers });
  const before = ui.requests.length;
  await ui.remount('srv1');
  assert.equal(ui.requests.length, before, 'повторный ref с тем же сервером снова загрузил данные');
});

test('S1: вкладку убрали (ref(null), узел снят со страницы) — экземпляр останавливается', async () => {
  const ui = await setup({ handle: twoServers });
  ui.click(ui.button('Тест предупреждения'), '«Тест предупреждения»');
  await ui.settle();
  ui.root.remove();
  ui.mod.default.tabs[0].component({ serverId: 'srv1' }).props.ref(null);
  await ui.timers.advance(0);
  const requests = ui.requests.length;
  // Узел вернули на страницу (например, чужой код), но экземпляр уже остановлен.
  ui.document.body.appendChild(ui.root);
  const snapshot = ui.text();
  await ui.timers.advance(60000);
  assert.equal(ui.text(), snapshot, 'остановленный экземпляр продолжил рисовать');
  assert.equal(ui.requests.length, requests, 'остановленный экземпляр продолжил ходить в API');
});

test('S2/S1: onUnmount бандла останавливает все экземпляры', async () => {
  const ui = await setup({ handle: twoServers });
  assert.equal(typeof ui.mod.default.onUnmount, 'function', 'бандл не экспортирует onUnmount');
  ui.click(ui.button('Тест предупреждения'), '«Тест предупреждения»');
  await ui.settle();
  ui.mod.default.onUnmount();
  const snapshot = ui.text();
  await ui.timers.advance(60000);
  assert.equal(ui.text(), snapshot, 'после onUnmount экземпляр продолжил рисовать');
});
