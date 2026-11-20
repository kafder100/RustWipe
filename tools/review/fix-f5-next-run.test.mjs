/**
 * Исполнитель F5, находка L31-12: «Следующий запуск» показан у выключенного
 * профиля и при выключенном планировщике, а прошедшая дата — как «7 дн назад».
 *
 * Должно: «Не запланирован: профиль выключен» / «…планировщик выключен»;
 * для прошедшей даты — «просрочен».
 *
 * Запуск: node tools/review/fix-f5-next-run.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

const DAY = 24 * 3600 * 1000;
const cardText = (ui) => ui.find((node) => node.classList.contains('rw-card'))?.textContent ?? '';

test('L31-12: выключенный профиль — «Не запланирован: профиль выключен»', async () => {
  const ui = await setup({ profiles: [makeProfile({ enabled: false, nextRunAt: new Date(Date.now() + 5 * DAY).toISOString() })] });
  assert.ok(cardText(ui).includes('Не запланирован: профиль выключен'), cardText(ui));
  assert.ok(!cardText(ui).includes('Следующий запуск'), 'у выключенного профиля показан следующий запуск');
});

test('L31-12: планировщик выключен — «Не запланирован: планировщик выключен»', async () => {
  const ui = await setup({ status: makeStatus({ schedulerEnabled: false }) });
  assert.ok(cardText(ui).includes('Не запланирован: планировщик выключен'), cardText(ui));
});

test('L31-12: дата в прошлом — «просрочен», а не «7 дн назад»', async () => {
  const ui = await setup({ profiles: [makeProfile({ nextRunAt: new Date(Date.now() - 7 * DAY).toISOString(), overdue: true })] });
  assert.ok(cardText(ui).includes('просрочен'), cardText(ui));
  assert.ok(!cardText(ui).includes('дн назад'), 'прошедшая дата показана как обычная');
});

test('обычный профиль — «Следующий запуск: … (через …)»', async () => {
  const ui = await setup();
  assert.ok(/Следующий запуск: .+ \(через /.test(cardText(ui)), cardText(ui));
});
