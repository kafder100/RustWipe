/**
 * Исправление P3 (R-11, регрессия R3-1): правка старого «каждые N дней» во
 * время отсчёта догона не сдвигает серию.
 *
 * Было: профиль «каждые 7 дн., 23:30» без точки отсчёта (так их хранила
 * 1.5.6), срок — 02.11 23:30. Панель лежала с 23:00 до 00:45 и поднялась в
 * окне догона: сначала отсчёт в чате, вайп — в 00:50. Пока шёл отсчёт, админ
 * переименовал профиль (или нажал «Выключить», а потом «Включить»). Точкой
 * отсчёта становилась дата 03.11 — дата времени после отсчёта (nextRunAt), а
 * не дата планового срока. Следующий вайп выходил 03.11 23:30: лишний вайп
 * через сутки, дальше вся серия на день позже.
 * Должно: точка отсчёта — 02.11 (дата планового срока, он лежит в catchUpOf),
 * следующий вайп — 09.11 23:30. Так же, как без правки.
 *
 * У профиля нет пояса: время — в поясе панели (TZ процесса). Поэтому даты в
 * тесте местные, и тест проходит в любом поясе.
 *
 * Запуск: node tools/review/post-p3-countdown-edit.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const MIN = 60000;
/** «Каждые 7 дней, 23:30», как его хранила 1.5.6: без пояса и без точки отсчёта. */
const OLD_INTERVAL = { kind: 'interval', time: '23:30', weekday: 4, nth: 1, day: 1, intervalDays: 7, anchorDate: null };
/** Местное время панели (пояс процесса), ноябрь 2026. */
const local = (day, hours, minutes, ms = 0) => new Date(2026, 10, day, hours, minutes, 0, ms).getTime();
const iso = (ms) => new Date(ms).toISOString();
const scheduled = (sb) => sb.runs().filter((run) => run.trigger === 'schedule');

/**
 * Срок 02.11 23:30, панель поднялась 03.11 в 00:45 — догон с отсчётом до 00:50.
 * Дальше тик в начале каждой минуты до 01:10; edit(minute) — правка в эту минуту.
 */
async function catchUpWithEdit(edit) {
  const slot = local(2, 23, 30);
  const sb = createSandbox({ now: iso(slot - 30 * MIN) });
  const profile = await sb.addProfile({ schedule: { ...OLD_INTERVAL }, nextRunAt: iso(slot) });
  sb.clock.setNow(local(3, 0, 45, 40));
  await sb.load({ enable: true }); // onEnable сразу делает тик
  await sb.idle();
  const countdown = { ...sb.profiles()[0] };
  const edits = [];
  for (let minute = 46; minute <= 70; minute += 1) {
    const at = local(3, 0, minute);
    await sb.clock.advance(at + 40 - sb.clock.now());
    const result = await edit(sb, profile, minute);
    if (result) edits.push(`${result.label} → ${result.response.status}`);
    await sb.tick();
  }
  await sb.idle();
  return { sb, countdown, edits, stored: sb.profiles()[0] };
}

const describe = ({ countdown, edits, stored, sb }) =>
  `отсчёт: nextRunAt ${countdown.nextRunAt}, catchUpOf ${countdown.catchUpOf}; правки: ${edits.join(', ')}; ` +
  `плановых вайпов ${scheduled(sb).length}; следующий ${stored.nextRunAt}, точка отсчёта ${stored.schedule.anchorDate}`;

test('R-11: переименование во время отсчёта догона — точка отсчёта 02.11, следующий вайп 09.11 23:30', async (t) => {
  const result = await catchUpWithEdit(async (sb, profile, minute) => {
    if (minute !== 47) return null;
    // Как редактор вкладки: весь профиль из карточки, новое имя и версия.
    const card = (await sb.call('admin', 'GET', '/servers/srv1/profiles')).body.data[0];
    const response = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${profile.id}`, {
      body: {
        name: 'Переименован',
        serverId: card.serverId,
        enabled: card.enabled,
        schedule: card.schedule,
        targets: card.targets,
        excludes: card.excludes,
        options: card.options,
        map: card.map,
        expectedUpdatedAt: card.updatedAt,
      },
    });
    return { label: '00:47 переименование', response };
  });
  t.note(describe(result));

  assert.equal(result.countdown.catchUpOf, iso(local(2, 23, 30)), 'догон с отсчётом: плановый срок — в catchUpOf');
  assert.deepEqual(result.edits, ['00:47 переименование → 200']);
  assert.equal(scheduled(result.sb).length, 1, 'догон — один вайп');
  assert.equal(result.stored.name, 'Переименован');
  assert.equal(result.stored.schedule.anchorDate, '2026-11-02', 'точка отсчёта — дата планового срока, а не 03.11');
  assert.equal(result.stored.nextRunAt, iso(local(9, 23, 30)), 'следующий — через 7 дней от 02.11, а не 03.11 23:30');
});

test('R-11: «Выключить» во время отсчёта и «Включить» через 20 минут — серия та же: 09.11 23:30', async (t) => {
  const result = await catchUpWithEdit(async (sb, profile, minute) => {
    if (minute === 47) {
      const response = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${profile.id}`, { body: { enabled: false } });
      return { label: '00:47 «Выключить»', response };
    }
    if (minute === 67) {
      const response = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${profile.id}`, { body: { enabled: true } });
      return { label: '01:07 «Включить»', response };
    }
    return null;
  });
  t.note(describe(result));

  assert.deepEqual(result.edits, ['00:47 «Выключить» → 200', '01:07 «Включить» → 200']);
  assert.equal(scheduled(result.sb).length, 0, 'выключенный профиль не вайпает, включение догон не запускает');
  assert.equal(result.stored.enabled, true);
  assert.equal(result.stored.schedule.anchorDate, '2026-11-02', 'точка отсчёта — дата планового срока, а не 03.11');
  assert.equal(result.stored.nextRunAt, iso(local(9, 23, 30)), 'следующий — 09.11 23:30, а не 03.11 23:30');
  assert.equal(result.stored.catchUpOf, null, 'новый срок — отсчёт догона больше не нужен');
});

test('без правки (для сравнения): догон идёт после отсчёта, следующий — 09.11 23:30', async (t) => {
  const result = await catchUpWithEdit(async () => null);
  t.note(describe(result));
  assert.equal(scheduled(result.sb).length, 1);
  assert.ok(Date.parse(scheduled(result.sb)[0].startedAt) >= local(3, 0, 50), 'вайп — после отсчёта');
  assert.equal(result.stored.schedule.anchorDate, '2026-11-02');
  assert.equal(result.stored.nextRunAt, iso(local(9, 23, 30)));
});
