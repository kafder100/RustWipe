/**
 * Исправление F3: точка отсчёта у расписания «каждые N дней» (находки H13c, H13d,
 * договорённость К6).
 *
 * Ответ владельца №10: считать от даты-якоря; если якорь не задан, плагин
 * запоминает первую дату и считает от неё; правка, не меняющая расписание,
 * отсчёт не сбрасывает.
 *
 * Что проверяется:
 *   - normalizeSchedule ставит интервалу без якоря сегодняшнюю дату — в поясе
 *     профиля, а без пояса — в поясе панели; заданный якорь не меняется;
 *   - необязательный anchorFrom: якорь — дата этого момента;
 *   - «Выключить» в среду и «Включить» через неделю не сдвигают серию;
 *   - вайп «каждые 7 дн., 23:58» кончился после полуночи — следующий через
 *     7 дней, а не на следующий вечер.
 *
 * Запуск: node tools/review/fix-f3-interval-anchor.test.mjs
 * Файл прогоняет проверки у себя и ещё раз в дочерних node с TZ=UTC,
 * Europe/Moscow и America/New_York. Часы и панель — подмены песочницы.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createClock, createSandbox, runNode, test } from './sandbox.mjs';
import { normalizeSchedule } from '../../rust-autowipe/backend/lib/schedule.js';

const ZONES = ['UTC', 'Europe/Moscow', 'America/New_York'];
const CHILD = process.env.RW_F3_CHILD === '1';

const local = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
function fmtLocal(value) {
  const d = new Date(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Тело профиля, как его шлёт вкладка: поле «Точка отсчёта» пустое — anchorDate: null. */
function intervalBody(time, extra = {}) {
  return {
    name: `Каждые 7 дн., ${time}`,
    enabled: true,
    targets: ['/server/*/proceduralmap.*.sav'],
    schedule: { kind: 'interval', intervalDays: 7, time, weekday: 4, nth: 1, day: 1, anchorDate: null, ...extra },
    options: { stopServer: true, startServer: true, dryRun: false, warnChat: false, commandsAfter: [] },
  };
}

// ── normalizeSchedule ───────────────────────────────────────────────────────

test('normalizeSchedule: интервал без точки отсчёта получает сегодняшнюю дату (пояс панели)', () => {
  const clock = createClock({ now: local(2026, 11, 2, 23, 59) });
  clock.install();
  for (const anchorDate of [null, undefined, '', 'мусор']) {
    const schedule = normalizeSchedule({ kind: 'interval', intervalDays: 7, time: '05:00', anchorDate });
    assert.equal(schedule.anchorDate, '2026-11-02', `anchorDate ${JSON.stringify(anchorDate)} → ${schedule.anchorDate}`);
  }
  clock.setNow(local(2026, 11, 3, 0, 1));
  assert.equal(normalizeSchedule({ kind: 'interval' }).anchorDate, '2026-11-03', 'после полуночи — уже новый день');
});

test('normalizeSchedule: «сегодня» — в поясе профиля, а не панели', () => {
  const clock = createClock({ now: '2026-11-19T22:00:00Z' });
  clock.install();
  // В Токио уже 20.11 07:00, в UTC и Нью-Йорке ещё 19.11.
  const cases = [
    ['Asia/Tokyo', '2026-11-20'],
    ['UTC', '2026-11-19'],
    ['America/New_York', '2026-11-19'],
    ['Europe/Moscow', '2026-11-20'],
  ];
  for (const [timeZone, expected] of cases) {
    const schedule = normalizeSchedule({ kind: 'interval', intervalDays: 3, time: '08:00', anchorDate: null, timeZone });
    assert.equal(schedule.timeZone, timeZone);
    assert.equal(schedule.anchorDate, expected, `${timeZone}: ${schedule.anchorDate}`);
  }
});

test('normalizeSchedule: заданная точка отсчёта не меняется; у других видов её нет', () => {
  const clock = createClock({ now: local(2026, 11, 20, 12, 0) });
  clock.install();
  const kept = normalizeSchedule({ kind: 'interval', intervalDays: 10, time: '05:00', anchorDate: '2026-10-01' });
  assert.equal(kept.anchorDate, '2026-10-01');
  // Повторная нормализация (тик, правка «Выключить») — тот же якорь, и через неделю тоже.
  clock.setNow(local(2026, 11, 27, 12, 0));
  assert.equal(normalizeSchedule(kept).anchorDate, '2026-10-01');
  for (const kind of ['weekly', 'monthly_nth_weekday', 'monthly_day']) {
    assert.ok(!('anchorDate' in normalizeSchedule({ kind, anchorDate: '2026-10-01' })), `${kind}: якорь не нужен`);
  }
});

test('normalizeSchedule: anchorFrom — якорь от даты заданного момента', () => {
  const clock = createClock({ now: local(2026, 11, 20, 12, 0) });
  clock.install();
  const zoned = normalizeSchedule(
    { kind: 'interval', time: '05:00', timeZone: 'Europe/Moscow' },
    { anchorFrom: '2026-11-08T22:30:00Z' },
  );
  assert.equal(zoned.anchorDate, '2026-11-09', 'в Москве это уже 09.11 01:30');
  const panel = normalizeSchedule({ kind: 'interval', time: '05:00' }, { anchorFrom: local(2026, 11, 9, 5, 0) });
  assert.equal(panel.anchorDate, '2026-11-09');
  // Свой якорь главнее anchorFrom; негодный anchorFrom — значит «сегодня».
  assert.equal(normalizeSchedule({ kind: 'interval', anchorDate: '2026-10-01' }, { anchorFrom: local(2026, 11, 9) }).anchorDate, '2026-10-01');
  for (const anchorFrom of [null, 'вчера', Number.NaN]) {
    assert.equal(normalizeSchedule({ kind: 'interval' }, { anchorFrom }).anchorDate, '2026-11-20', String(anchorFrom));
  }
});

// ── Профиль и тик ─────────────────────────────────────────────────────────

test('«Выключить» в среду и «Включить» через неделю: серия идёт от дня создания', async () => {
  // Понедельник 02.11.2026 12:00 — создаём «каждые 7 дн., 05:00» без точки отсчёта.
  const sb = createSandbox({ now: local(2026, 11, 2, 12, 0) });
  await sb.load();
  const created = await sb.call('owner', 'POST', '/servers/srv1/profiles', { body: intervalBody('05:00') });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.schedule.anchorDate, '2026-11-02', 'якорь — день создания');
  assert.equal(fmtLocal(created.body.data.nextRunAt), '2026-11-09 05:00');

  sb.clock.setNow(local(2026, 11, 4, 12, 0));
  const off = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${id}`, { body: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  sb.clock.setNow(local(2026, 11, 10, 12, 0));
  const on = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${id}`, { body: { enabled: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(fmtLocal(on.body.data.nextRunAt), '2026-11-16 05:00', 'по серии 02.11 → 09.11 → 16.11, а не 17.11');

  // Карточка отдаёт якорь — редактор покажет его в поле «Точка отсчёта».
  const list = await sb.call('owner', 'GET', '/servers/srv1/profiles');
  assert.equal(list.body.data.find((item) => item.id === id).schedule.anchorDate, '2026-11-02');
});

test('«каждые 7 дн., 23:58»: вайп кончился после полуночи — следующий через 7 дней', async () => {
  const sb = createSandbox({ now: local(2026, 11, 2, 12, 0) });
  await sb.load();
  // Сервер сохраняет мир 3 минуты: вайп начинается в 23:58, а кончается уже 03.11.
  sb.panel.behave('srv1', { stopMs: 3 * 60000, stopAckMs: 1000 });
  const created = await sb.call('owner', 'POST', '/servers/srv1/profiles', { body: intervalBody('23:58') });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(fmtLocal(created.body.data.nextRunAt), '2026-11-02 23:58');

  sb.clock.setNow(local(2026, 11, 2, 23, 58, 0, 40));
  await sb.tick();
  const runs = sb.runs();
  assert.equal(runs.length, 1, 'плановый вайп прошёл');
  assert.equal(runs[0].ok, true, JSON.stringify(runs[0].error ?? runs[0].steps));
  assert.equal(fmtLocal(runs[0].finishedAt).slice(0, 10), '2026-11-03', `предусловие: вайп кончился после полуночи (${fmtLocal(runs[0].finishedAt)})`);
  const next = fmtLocal(sb.profiles()[0].nextRunAt);
  assert.equal(next, '2026-11-09 23:58', `следующий вайп ${next}, а должен быть через 7 дней`);
});

// ── Те же проверки в других поясах процесса ─────────────────────────────────

if (!CHILD) {
  for (const zone of ZONES) {
    test(
      `те же проверки при TZ=${zone}`,
      async () => {
        const result = await runNode({ file: fileURLToPath(import.meta.url), tz: zone, env: { RW_F3_CHILD: '1' } });
        assert.equal(result.code, 0, `дочерний процесс TZ=${zone} провалился:\n${result.stdout}\n${result.stderr}`);
      },
      { timeoutMs: 120000 },
    );
  }
}
