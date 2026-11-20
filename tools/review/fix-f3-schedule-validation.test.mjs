/**
 * Исправление F3: проверка расписания на сервере (находка L32-8, часть
 * расписания; карту и списки проверяет store.js / mapgen.js).
 *
 * Было: неверные поля расписания молча заменялись «похожими» значениями —
 * интервал -7 становился «каждый день», день недели 7 — субботой, время
 * 17:00:00 — 05:00, неделя месяца 5 — первой, вид monthly-day — неделей.
 * Сервер отвечал успехом.
 * Должно быть: 400 с понятной причиной, профиль не сохраняется.
 * Поле не задано (undefined или null) — не ошибка: берётся значение по
 * умолчанию. Поля, которые этому виду расписания не нужны, не проверяются.
 *
 * Запуск: node tools/review/fix-f3-schedule-validation.test.mjs
 * Панель и часы — подмены песочницы.
 */

import assert from 'node:assert/strict';

import { createSandbox, test } from './sandbox.mjs';
import { normalizeSchedule, validateScheduleInput } from '../../rust-autowipe/backend/lib/schedule.js';

/** Расписание, как его шлёт вкладка (blankDraft): все поля, точка отсчёта пустая. */
const draft = (overrides = {}) => ({
  kind: 'weekly',
  weekday: 4,
  nth: 1,
  day: 1,
  time: '05:00',
  intervalDays: 7,
  anchorDate: null,
  timeZone: '',
  ...overrides,
});

function expectError(input, pattern, label) {
  const errors = validateScheduleInput(input);
  assert.equal(errors.length, 1, `${label}: ждали одну ошибку, получили ${JSON.stringify(errors)}`);
  assert.match(errors[0], /^Расписание: /, label);
  assert.match(errors[0], pattern, `${label}: ${errors[0]}`);
}

test('неверные значения — понятная ошибка, а не подмена', () => {
  const cases = [
    [draft({ kind: 'interval', intervalDays: -7 }), /интервал «-7».*от 1 до 365/, 'интервал -7'],
    [draft({ kind: 'interval', intervalDays: 0 }), /интервал «0»/, 'интервал 0'],
    [draft({ kind: 'interval', intervalDays: 366 }), /интервал «366»/, 'интервал 366'],
    [draft({ kind: 'interval', intervalDays: 7.5 }), /интервал «7\.5»/, 'интервал 7.5'],
    [draft({ kind: 'interval', intervalDays: '7 дней' }), /интервал «7 дней»/, 'интервал строкой с буквами'],
    [draft({ weekday: 7 }), /день недели «7».*0 \(воскресенье\) до 6 \(суббота\)/, 'день недели 7'],
    [draft({ weekday: -1 }), /день недели «-1»/, 'день недели -1'],
    [draft({ kind: 'monthly_nth_weekday', weekday: 'пн' }), /день недели «пн»/, 'день недели словом'],
    [draft({ time: '17:00:00' }), /время «17:00:00».*ЧЧ:ММ/, 'время с секундами'],
    [draft({ time: '25:00' }), /время «25:00»/, 'время 25:00'],
    [draft({ time: '' }), /время «»/, 'пустое время'],
    [draft({ time: 500 }), /время «500»/, 'время числом'],
    [draft({ time: ['05:00'] }), /время «\["05:00"\]»/, 'время массивом'],
    [draft({ kind: 'monthly_nth_weekday', nth: 5 }), /неделя месяца «5».*1, 2, 3, 4 или -1/, 'пятая неделя'],
    [draft({ kind: 'monthly_nth_weekday', nth: 0 }), /неделя месяца «0»/, 'нулевая неделя'],
    [draft({ kind: 'monthly_day', day: 0 }), /число месяца «0».*от 1 до 31/, 'число 0'],
    [draft({ kind: 'monthly_day', day: 40 }), /число месяца «40»/, 'число 40'],
    [draft({ kind: 'monthly-day' }), /неизвестный вид «monthly-day».*weekly, monthly_nth_weekday, monthly_day, interval/, 'вид с дефисом'],
    [draft({ kind: 'Weekly' }), /неизвестный вид «Weekly»/, 'вид с большой буквы'],
    [draft({ kind: 'interval', anchorDate: '2026-02-30' }), /точка отсчёта «2026-02-30».*ГГГГ-ММ-ДД/, '30 февраля'],
    [draft({ kind: 'interval', anchorDate: '2026-13-01' }), /точка отсчёта «2026-13-01»/, '13-й месяц'],
    [draft({ kind: 'interval', anchorDate: '01.11.2026' }), /точка отсчёта «01\.11\.2026»/, 'дата по-русски'],
    [draft({ kind: 'interval', anchorDate: 20261101 }), /точка отсчёта «20261101»/, 'дата числом'],
    [draft({ timeZone: 'Europe/Moskow' }), /неизвестный часовой пояс «Europe\/Moskow»/, 'пояс с опечаткой'],
  ];
  for (const [input, pattern, label] of cases) expectError(input, pattern, label);

  for (const bad of ['weekly', 5, true, []]) {
    expectError(bad, /неверный формат/, `расписание ${JSON.stringify(bad)}`);
  }
  // Несколько неверных полей — по ошибке на каждое.
  const many = validateScheduleInput(draft({ kind: 'interval', intervalDays: -7, time: '7', anchorDate: 'вчера', timeZone: 'Mars/Base' }));
  assert.equal(many.length, 4, JSON.stringify(many));
  // Мусор в ошибку целиком не попадает.
  const long = validateScheduleInput(draft({ kind: 'x'.repeat(5000) }))[0];
  assert.ok(long.length < 200, `длина ошибки ${long.length}`);
});

test('верные расписания и незаданные поля проходят без ошибок', () => {
  const ok = [
    undefined,
    null,
    {},
    draft(),
    draft({ kind: 'monthly_nth_weekday', nth: -1, weekday: 5, time: '03:30' }),
    draft({ kind: 'monthly_day', day: 31, time: '06:00' }),
    draft({ kind: 'interval', intervalDays: 365, anchorDate: '2026-11-01' }),
    draft({ kind: 'interval', intervalDays: 1, anchorDate: '' }),
    draft({ kind: 'interval', anchorDate: '2024-02-29' }),
    draft({ time: '5:07', timeZone: 'Europe/Moscow' }),
    // Числа строкой — как раньше.
    draft({ kind: 'monthly_nth_weekday', weekday: '0', nth: '-1' }),
    draft({ kind: 'interval', intervalDays: '10' }),
    // Незаданные поля — значения по умолчанию.
    { kind: 'interval' },
    { kind: 'weekly', weekday: 4, time: '05:00' },
    { kind: 'monthly_day', day: 8, time: null, weekday: null },
    // Поля другого вида не проверяются: админ сменил вид, а в черновике осталось старое.
    draft({ kind: 'weekly', intervalDays: -7, day: 99, nth: 9, anchorDate: 'вчера' }),
    draft({ kind: 'interval', weekday: 42, nth: 9, day: 0 }),
  ];
  for (const input of ok) {
    assert.deepEqual(validateScheduleInput(input), [], JSON.stringify(input));
  }
  // Сохранённое расписание (после normalizeSchedule) всегда проходит:
  // «Выключить» шлёт только enabled, и проверяется расписание из профиля.
  for (const kind of ['weekly', 'monthly_nth_weekday', 'monthly_day', 'interval']) {
    const stored = normalizeSchedule({ kind, timeZone: 'Asia/Tokyo' });
    assert.deepEqual(validateScheduleInput(stored), [], JSON.stringify(stored));
  }
});

test('профиль: неверное расписание — 400 с причиной, ничего не сохраняется', async () => {
  const sb = createSandbox();
  await sb.load();
  const body = (schedule) => ({
    name: 'Проверка расписания',
    targets: ['/server/*/proceduralmap.*.map'],
    schedule,
    options: { stopServer: true, startServer: true, dryRun: true, warnChat: false, commandsAfter: [] },
  });
  const bad = [
    [draft({ kind: 'interval', intervalDays: -7 }), /интервал «-7»/],
    [draft({ weekday: 7 }), /день недели «7»/],
    [draft({ time: '17:00:00' }), /время «17:00:00»/],
    [draft({ kind: 'monthly_nth_weekday', nth: 5 }), /неделя месяца «5»/],
    [draft({ kind: 'monthly-day' }), /неизвестный вид «monthly-day»/],
    // Раньше это роняло обработчик (500): у массива нет trim().
    [draft({ time: ['05:00'] }), /время «\["05:00"\]»/],
  ];
  for (const [schedule, pattern] of bad) {
    const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', { body: body(schedule) });
    assert.equal(res.status, 400, `${JSON.stringify(schedule)} → ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, pattern);
  }
  assert.equal(sb.profiles().length, 0, 'ни один профиль не сохранён');

  // Верный профиль сохраняется; неверная правка — 400, профиль прежний.
  const created = await sb.call('owner', 'POST', '/servers/srv1/profiles', { body: body(draft({ kind: 'interval', intervalDays: 10 })) });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.data.id;
  const before = structuredClone(sb.profiles()[0].schedule);
  const broken = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${id}`, {
    body: { ...body(draft({ kind: 'interval', intervalDays: -7 })) },
  });
  assert.equal(broken.status, 400, JSON.stringify(broken.body));
  assert.deepEqual(sb.profiles()[0].schedule, before, 'расписание в профиле не изменилось');
  assert.equal(sb.profiles()[0].schedule.intervalDays, 10);

  // «Выключить» шлёт только enabled — проверяется сохранённое расписание, оно верное.
  const off = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${id}`, { body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(sb.profiles()[0].enabled, false);
});
