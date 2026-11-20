/**
 * F1, находка L31-5: у профиля, созданного до 1.2.0, нет поля map. Вайп
 * карту не трогает (сид и размер не меняются), но карточка писала «сид
 * случайный при вайпе · размер 3000», а редактор получал эти же настройки.
 * Админ только переименовал профиль — и в профиль записались случайный сид
 * и размер 3000: следующий вайп писал WORLD_SIZE=3000 вместо 4500.
 *
 * Правильное поведение (обещание CHANGELOG: обновление не меняет карту
 * старым профилям): карточка и редактор показывают «не менять», и сохранение
 * без правки блока «Карта» его не меняет.
 *
 * Всё на подменах песочницы: панель и переменные шаблона поддельные.
 *
 * Запуск: node tools/review/fix-f1-legacy-map.test.mjs
 */

import assert from 'node:assert/strict';

import { describeMap } from '../../rust-autowipe/backend/lib/mapgen.js';
import { createSandbox, test } from './sandbox.mjs';

test('describeMap: нет настроек карты — «не меняется»', () => {
  assert.equal(describeMap(undefined), 'сид не меняется · размер не меняется');
  assert.equal(describeMap(null), 'сид не меняется · размер не меняется');
  assert.match(describeMap({ seed: { mode: 'random' }, size: { mode: 'fixed', value: 3000 } }), /сид случайный/);
});

test('L31-5: старый профиль без map — карточка «не меняется», переименование не включает смену карты', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.server('srv1').environment.WORLD_SIZE = '4500';
  // Так профиль лежит в базе с версии до 1.2.0: поля map нет.
  const legacy = await sb.addProfile({ name: 'Старый профиль' });
  assert.equal(legacy.map, undefined, 'предусловие: у профиля нет map');

  const list = await sb.call('owner', 'GET', '/servers/srv1/profiles');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const card = list.body.data.find((profile) => profile.id === legacy.id);
  t.note(`карточка: ${card.mapText}; map для редактора: ${JSON.stringify(card.map)}`);
  assert.equal(card.mapText, 'сид не меняется · размер не меняется');
  assert.equal(card.map.seed.mode, 'keep');
  assert.equal(card.map.size.mode, 'keep');

  // Редактор отправляет профиль целиком, с тем map, что получил.
  const put = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${legacy.id}`, {
    body: { name: 'Старый профиль (переименован)', targets: card.targets, excludes: card.excludes, schedule: card.schedule, options: card.options, map: card.map },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const saved = sb.profiles().find((profile) => profile.id === legacy.id);
  t.note(`после сохранения: ${JSON.stringify(saved.map)}`);
  assert.equal(saved.map.seed.mode, 'keep');
  assert.equal(saved.map.size.mode, 'keep');

  const run = await sb.wipe(saved);
  await sb.idle();
  const patches = sb.panel.calls.filter((call) => call.method === 'PATCH');
  t.note(`вайп: ok=${run.ok}; PATCH /variables: ${patches.length}; WORLD_SIZE=${sb.panel.server('srv1').environment.WORLD_SIZE}`);
  assert.equal(patches.length, 0, 'вайп после переименования поменял переменные карты');
  assert.equal(sb.panel.server('srv1').environment.WORLD_SIZE, '4500');
});
