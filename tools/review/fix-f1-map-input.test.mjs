/**
 * F1, находка L32-8 (часть про карту; расписание правит F3): неверная карта
 * подменялась «похожим» значением без ошибки. map: "keep" строкой вместо
 * настроек сохранялся как случайный сид и размер 3000 — вайп писал
 * WORLD_SIZE=3000 вместо 4500 и новый сид, а сервер отвечал «успешно».
 *
 * Правильное поведение: map — это объект с настройками или отсутствие поля.
 * Строка, число или список — 400 с понятной причиной. Обычные настройки
 * сохраняются как раньше.
 *
 * Всё на подменах песочницы: панель поддельная, файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-map-input.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, test } from './sandbox.mjs';

const SCHEDULE = { kind: 'weekly', weekday: 4, time: '05:00' };

function post(sb, extra) {
  return sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Проверка карты', targets: ['/server/*/proceduralmap.*.map'], schedule: SCHEDULE, ...extra },
  });
}

test('L32-8: map строкой, числом или списком — ошибка 400, а не случайный сид и размер 3000', async (t) => {
  const sb = createSandbox();
  await sb.load();
  for (const map of ['keep', 5, ['keep'], true]) {
    const res = await post(sb, { map });
    t.note(`map=${JSON.stringify(map)} → ${res.status}: ${res.body?.error ?? ''}`);
    assert.equal(res.status, 400, `map=${JSON.stringify(map)} принят`);
    assert.match(res.body.error, /Карта/);
  }
  assert.equal(sb.profiles().length, 0, 'профиль с неверной картой сохранён');
});

test('Без поля map и с обычными настройками — сохраняется как раньше', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const none = await post(sb, {});
  assert.equal(none.status, 200, JSON.stringify(none.body));
  const nul = await post(sb, { map: null });
  assert.equal(nul.status, 200, JSON.stringify(nul.body));
  const full = await post(sb, { map: { seed: { mode: 'keep' }, size: { mode: 'fixed', value: 4500 } } });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const saved = sb.profiles().find((profile) => profile.id === full.body.data.id);
  t.note(`сохранено: ${JSON.stringify(saved.map)}`);
  assert.equal(saved.map.seed.mode, 'keep');
  assert.equal(saved.map.size.value, 4500);
});
