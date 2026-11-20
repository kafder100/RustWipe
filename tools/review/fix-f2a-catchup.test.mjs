/**
 * Исправление F2a: догон и пропуски плановых вайпов.
 *
 *  - договорённость К6, находки H13d и H13c: следующий срок считается по серии
 *    от планового срока, а не от «сейчас»; у «каждые N дней» без даты-якоря
 *    якорем становится дата планового запуска, и она сохраняется в профиле;
 *    правка без смены расписания срок не трогает; включение после прошедшего
 *    срока даёт следующий срок той же серии, а не догон;
 *  - H13e: опоздание — целыми минутами, catchUpMinutes: 0 не пропускает вайп
 *    в его собственную минуту; мусор в настройке — как по умолчанию (120);
 *  - L33-8: пропуск по окну догона виден во вкладке (lastSkippedAt и
 *    lastSkipReason в GET …/profiles).
 *
 * Запуск: node tools/review/fix-f2a-catchup.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 * Пояс профиля задан явно (Europe/Moscow), поэтому ответы не зависят от TZ процесса.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const MSK = 'Europe/Moscow';
/** «2026-11-09 05:00» по Москве → ISO. */
const msk = (text) => new Date(`${text.replace(' ', 'T')}:00+03:00`).toISOString();
const moveTo = (sb, iso) => sb.clock.advance(Date.parse(iso) - sb.clock.now());

test('L33-8: пропуск по окну догона виден во вкладке — когда и почему', async (t) => {
  const sb = createSandbox({ now: msk('2026-11-19 08:00') });
  await sb.load();
  const profile = await sb.addProfile({
    schedule: { kind: 'weekly', weekday: 4, time: '05:00', timeZone: MSK },
    nextRunAt: msk('2026-11-19 05:00'),
    options: { warnChat: false },
  });
  await sb.tick();
  await sb.idle();
  const card = (await sb.call('admin', 'GET', '/servers/srv1/profiles')).body.data.find((item) => item.id === profile.id);
  t.note(`lastSkippedAt ${card.lastSkippedAt}; причина: ${card.lastSkipReason}; следующий ${card.nextRunAt}`);
  assert.equal(sb.runs().length, 0);
  assert.equal(card.lastSkippedAt, new Date(sb.clock.now()).toISOString());
  assert.match(card.lastSkipReason, /180 мин/);
  assert.match(card.lastSkipReason, /catchUpMinutes/);
  assert.equal(card.nextRunAt, msk('2026-11-26 05:00'));
});

test('catchUpMinutes с мусором (строка, минус) — окно 120 мин, а не «догонять всегда»', async (t) => {
  const rows = [];
  for (const value of ['abc', -5]) {
    const sb = createSandbox({ now: msk('2026-11-19 11:00'), config: { catchUpMinutes: value } });
    await sb.load();
    await sb.addProfile({
      schedule: { kind: 'weekly', weekday: 4, time: '05:00', timeZone: MSK },
      nextRunAt: msk('2026-11-19 05:00'),
      options: { warnChat: false },
    });
    await sb.tick();
    await sb.idle();
    const status = await sb.call('admin', 'GET', '/servers/srv1/status');
    rows.push(`${JSON.stringify(value)}: прогонов ${sb.runs().length}, окно во вкладке ${status.body.data.catchUpMinutes}`);
    assert.equal(sb.runs().length, 0, `${value}: опоздание 6 ч не должно догоняться`);
    assert.equal(status.body.data.catchUpMinutes, 120);
    sb.restore();
  }
  t.note(rows.join('; '));
});

test('«каждые 7 дн., 23:58» без якоря: вайп кончился после полуночи — следующий через 7 дней, якорь сохранён', async (t) => {
  const sb = createSandbox({ now: msk('2026-11-02 23:58') });
  sb.panel.behave('srv1', { stopMs: 3 * 60000, stopAckMs: 0 });
  await sb.load();
  await sb.addProfile({
    schedule: { kind: 'interval', intervalDays: 7, time: '23:58', timeZone: MSK, anchorDate: null },
    nextRunAt: msk('2026-11-02 23:58'),
    options: { warnChat: false },
  });
  await sb.tick();
  await sb.idle();
  const profile = sb.profiles()[0];
  const run = sb.runs()[0];
  t.note(`прогон ${run.startedAt} – ${run.finishedAt}; nextRunAt ${profile.nextRunAt}; якорь ${profile.schedule.anchorDate}`);
  assert.ok(Date.parse(run.finishedAt) > Date.parse(msk('2026-11-03 00:00')), 'предусловие: прогон кончился после полуночи');
  assert.equal(profile.nextRunAt, msk('2026-11-09 23:58'));
  assert.equal(profile.schedule.anchorDate, '2026-11-02');
});

test('«Выключить» в ср и «Включить» во вт после прошедшего срока: следующий срок той же серии, без догона', async (t) => {
  const sb = createSandbox({ now: msk('2026-11-02 12:00') });
  await sb.load();
  const created = await sb.call('admin', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Интервал',
      targets: ['/server/rust/proceduralmap.*.sav'],
      schedule: { kind: 'interval', intervalDays: 7, time: '05:00', timeZone: MSK, anchorDate: null },
      options: { warnChat: false },
    },
  });
  const id = created.body.data.id;
  assert.equal(created.body.data.nextRunAt, msk('2026-11-09 05:00'), 'предусловие: первый вайп 09.11');
  await moveTo(sb, msk('2026-11-04 12:00'));
  const off = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${id}`, { body: { enabled: false } });
  await moveTo(sb, msk('2026-11-10 12:00'));
  const on = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${id}`, { body: { enabled: true } });
  await sb.tick();
  await sb.idle();
  t.note(`выключен → nextRunAt ${off.body.data.nextRunAt}; включён во вт → ${on.body.data.nextRunAt}; прогонов ${sb.runs().length}`);
  assert.equal(off.body.data.nextRunAt, msk('2026-11-09 05:00'), 'выключение срок не трогает');
  assert.equal(on.body.data.nextRunAt, msk('2026-11-16 05:00'), 'серия от 09.11: следующий — 16.11, а не 17.11');
  assert.equal(sb.runs().length, 0, 'включение не запускает догон прошедшего срока');
});

test('правка с другим расписанием срок пересчитывает; переименование — нет', async (t) => {
  const sb = createSandbox({ now: msk('2026-11-16 12:00') });
  await sb.load();
  const created = await sb.call('admin', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Чт', targets: ['/server/rust/proceduralmap.*.sav'], schedule: { kind: 'weekly', weekday: 4, time: '05:00', timeZone: MSK } },
  });
  const id = created.body.data.id;
  const renamed = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${id}`, { body: { name: 'Четверг' } });
  const moved = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${id}`, {
    body: { schedule: { kind: 'weekly', weekday: 5, time: '18:00', timeZone: MSK } },
  });
  t.note(`создан ${created.body.data.nextRunAt}; переименован ${renamed.body.data.nextRunAt}; пятница 18:00 → ${moved.body.data.nextRunAt}`);
  assert.equal(renamed.body.data.nextRunAt, created.body.data.nextRunAt);
  assert.equal(moved.body.data.nextRunAt, msk('2026-11-20 18:00'));
});
