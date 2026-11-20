/**
 * Тесты: часовой пояс у профиля (ветка feat-profile-timezone).
 *
 * Запуск: node tools/review/feat-profile-timezone.test.mjs
 *
 * Файл самостоятельный: свой маленький test(), только встроенные модули node.
 * Код выхода 1 — хотя бы одна проверка не прошла или не завершилась.
 *
 * Что проверяется: zoned-time.js; расписание в поясе профиля во всех видах и
 * через переходы на летнее время; путь без пояса (сверка с кодом 1.5.6);
 * профиль в store.js и index.js (сохранение, тик, догон); поле в интерфейсе.
 *
 * Без RW_TZ_CHILD файл прогоняет проверки в своём процессе, а потом запускает
 * себя в дочерних node с TZ=UTC, Europe/Moscow и America/New_York. TZ задаётся
 * через env дочернего процесса: из оболочки она доходит до node не везде.
 * Каждый прогон печатает отпечаток (sha256) большого набора расчётов с явным
 * поясом. Родитель сверяет отпечатки: результат не должен зависеть от пояса
 * процесса.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  isValidTimeZone,
  resolveTimeZone,
  timeZonesSupported,
  zonedParts,
  zonedTimeToDate,
} from '../../rust-autowipe/backend/lib/zoned-time.js';
import {
  describeSchedule,
  describeScheduleShort,
  nextOccurrence,
  normalizeSchedule,
  validateScheduleInput,
} from '../../rust-autowipe/backend/lib/schedule.js';
import plugin, { runTick } from '../../rust-autowipe/backend/index.js';

const CHILD_ENV = 'RW_TZ_CHILD';
const CHILD_ZONES = ['UTC', 'Europe/Moscow', 'America/New_York'];
const isChild = Boolean(process.env[CHILD_ENV]);
const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UTC = 'UTC';
const MSK = 'Europe/Moscow';
const NY = 'America/New_York';
const BER = 'Europe/Berlin';
const TYO = 'Asia/Tokyo';
const SYD = 'Australia/Sydney';
const ZONES = [UTC, MSK, NY, BER, TYO, SYD];

// ── Маленький test() ──────────────────────────────────────────────────────

const tests = [];
let reported = false;

function test(name, fn) {
  tests.push({ name, fn, state: 'pending' });
}

function counts() {
  const passed = tests.filter((item) => item.state === 'ok').length;
  return { passed, failed: tests.length - passed, total: tests.length };
}

// Тест, который так и не закончился (обещание повисло, а цикл событий
// опустел), иначе прошёл бы незаметно: процесс просто вышел бы с кодом 0.
process.on('beforeExit', () => {
  if (reported) return;
  reported = true;
  const unfinished = tests.filter((item) => item.state === 'pending' || item.state === 'running');
  for (const item of unfinished) console.error(`FAIL  ${item.name}: не завершился`);
  process.exitCode = 1;
  const { passed, total } = counts();
  console.error(`\nПрогон оборвался: ${passed} из ${total} проверок прошло`);
});

async function runTests() {
  for (const item of tests) {
    item.state = 'running';
    const started = performance.now();
    try {
      await item.fn();
      item.state = 'ok';
      console.log(`  ok  ${item.name} (${Math.round(performance.now() - started)} мс)`);
    } catch (error) {
      item.state = 'fail';
      console.error(`FAIL  ${item.name}`);
      console.error(error);
    }
  }
}

// ── Помощники ─────────────────────────────────────────────────────────────

/** '2026-03-08 02:30' → { year, month, day, hour, minute }. */
function wall(text) {
  const [date, time] = text.split(' ');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return { year, month, day, hour, minute };
}

function wallText(parts) {
  const p = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${p(parts.month)}-${p(parts.day)} ${p(parts.hour)}:${p(parts.minute)}`;
}

function iso(date) {
  return date.toISOString();
}

function localDate(y, mo, d, h = 0, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function fmtLocal(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Номер календарного дня — независимо от модулей под тестом. */
function dayIndex(year, month, day) {
  return Math.round(Date.UTC(year, month - 1, day) / DAY);
}

function daysIn(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Эталон без хитростей: перебираем минуты UTC около нужной даты и берём первую,
 * у которой стенные часы в поясе не раньше нужных. Для обычного времени это оно
 * само, для двойного — первое из двух, для разрыва — момент перевода часов.
 */
function referenceInstant(target, timeZone) {
  const goal = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const wallOf = (time) => {
    const p = {};
    for (const part of formatter.formatToParts(new Date(time))) p[part.type] = Number(part.value);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  };
  for (let time = goal - 15 * HOUR; time <= goal + 15 * HOUR; time += MINUTE) {
    if (wallOf(time) >= goal) return new Date(time);
  }
  throw new Error(`эталон не нашёл момент для ${wallText(target)} ${timeZone}`);
}

// Пояс кладём в расписание сами: проверяем расчёт, а не нормализацию.
// Якорь тоже: normalizeSchedule ставит интервалу без якоря сегодняшнюю дату,
// а расчёт без якоря остаётся для старых профилей (у них anchorDate: null).
const asGiven = (schedule) => {
  const out = normalizeSchedule(schedule);
  if (out.kind === 'interval' && !schedule.anchorDate) out.anchorDate = null;
  return out;
};
const zoned = (schedule, timeZone) => ({ ...asGiven(schedule), timeZone });
const weekly = (weekday, time, timeZone) => zoned({ kind: 'weekly', weekday, time }, timeZone);
const nth = (n, weekday, time, timeZone) => zoned({ kind: 'monthly_nth_weekday', nth: n, weekday, time }, timeZone);
const mday = (day, time, timeZone) => zoned({ kind: 'monthly_day', day, time }, timeZone);
const interval = (intervalDays, time, anchorDate, timeZone) =>
  zoned({ kind: 'interval', intervalDays, time, anchorDate }, timeZone);

// ── Эталон прежнего кода: nextOccurrence версии 1.5.6, до поясов ───────────
// Копия без изменений: с ней сверяется путь «без пояса» на тысячах дат.

const legacyNextOccurrence = (() => {
  const atTime = (year, month, day, h, m) => new Date(year, month, day, h, m, 0, 0);
  const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const parse = (value) => {
    const [h, m] = String(value).split(':').map(Number);
    return { h, m };
  };
  function nextWeekly(schedule, after) {
    const { h, m } = parse(schedule.time);
    const weekday = schedule.weekday;
    const candidate = atTime(after.getFullYear(), after.getMonth(), after.getDate(), h, m);
    let delta = (weekday - after.getDay() + 7) % 7;
    if (delta === 0 && candidate.getTime() <= after.getTime()) delta = 7;
    return atTime(after.getFullYear(), after.getMonth(), after.getDate() + delta, h, m);
  }
  function nthWeekdayDate(year, month, weekday, n) {
    const total = daysInMonth(year, month);
    if (n === -1) {
      const last = new Date(year, month, total);
      const diff = (last.getDay() - weekday + 7) % 7;
      return total - diff;
    }
    const first = new Date(year, month, 1);
    const diff = (weekday - first.getDay() + 7) % 7;
    const day = 1 + diff + (n - 1) * 7;
    return day > total ? null : day;
  }
  function nextMonthlyNthWeekday(schedule, after) {
    const { h, m } = parse(schedule.time);
    const baseYear = after.getFullYear();
    const baseMonth = after.getMonth();
    for (let offset = 0; offset <= 24; offset += 1) {
      const year = baseYear + Math.floor((baseMonth + offset) / 12);
      const month = (baseMonth + offset) % 12;
      const day = nthWeekdayDate(year, month, schedule.weekday, schedule.nth);
      if (day == null) continue;
      const candidate = atTime(year, month, day, h, m);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    return atTime(baseYear, baseMonth + 1, 1, h, m);
  }
  function nextMonthlyDay(schedule, after) {
    const { h, m } = parse(schedule.time);
    const baseYear = after.getFullYear();
    const baseMonth = after.getMonth();
    for (let offset = 0; offset <= 24; offset += 1) {
      const year = baseYear + Math.floor((baseMonth + offset) / 12);
      const month = (baseMonth + offset) % 12;
      const day = Math.min(schedule.day, daysInMonth(year, month));
      const candidate = atTime(year, month, day, h, m);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
    return atTime(baseYear, baseMonth + 1, 1, h, m);
  }
  function nextInterval(schedule, after) {
    const { h, m } = parse(schedule.time);
    const step = Math.max(1, Number(schedule.intervalDays) || 7);
    let year = after.getFullYear();
    let month = after.getMonth();
    let day = after.getDate();
    if (schedule.anchorDate) {
      const [ay, am, ad] = schedule.anchorDate.split('-').map(Number);
      if (Number.isFinite(ay) && Number.isFinite(am) && Number.isFinite(ad)) {
        year = ay;
        month = am - 1;
        day = ad;
      }
    }
    let candidate = atTime(year, month, day, h, m);
    let guard = 0;
    while (candidate.getTime() <= after.getTime() && guard < 5000) {
      candidate = atTime(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + step, h, m);
      guard += 1;
    }
    if (candidate.getTime() <= after.getTime()) {
      candidate = atTime(after.getFullYear(), after.getMonth(), after.getDate() + step, h, m);
    }
    return candidate;
  }
  return (schedule, after) => {
    switch (schedule.kind) {
      case 'monthly_nth_weekday':
        return nextMonthlyNthWeekday(schedule, after);
      case 'monthly_day':
        return nextMonthlyDay(schedule, after);
      case 'interval':
        return nextInterval(schedule, after);
      default:
        return nextWeekly(schedule, after);
    }
  };
})();

// ── 1. Имя пояса ──────────────────────────────────────────────────────────

test('пояса есть в этой сборке node', () => {
  assert.equal(timeZonesSupported(), true);
});

test('имя пояса: известные принимаются, регистр исправляется', () => {
  for (const zone of ZONES) assert.equal(resolveTimeZone(zone), zone);
  assert.equal(resolveTimeZone('europe/moscow'), MSK);
  assert.equal(resolveTimeZone('  Asia/Tokyo  '), TYO);
  assert.equal(resolveTimeZone('utc'), UTC);
  assert.equal(resolveTimeZone('Etc/GMT+3'), 'Etc/GMT+3');
  // Синоним остаётся тем, что выбрал админ, даже если Intl считает главным другое имя.
  assert.equal(resolveTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(isValidTimeZone(SYD), true);
});

test('имя пояса: мусор и смещения отклоняются', () => {
  const bad = [
    'Moscow',
    'Europe/Moskow',
    'Mars/Olympus_Mons',
    '',
    '   ',
    '+03:00',
    '-05:00',
    'UTC+3',
    'Europe/../Moscow',
    'Europe/Moscow/',
    `Europe/${'x'.repeat(80)}`,
    42,
    null,
    undefined,
    {},
    ['Europe/Moscow'],
  ];
  for (const value of bad) {
    assert.equal(resolveTimeZone(value), null, `принят мусор: ${String(value)}`);
    assert.equal(isValidTimeZone(value), false);
  }
});

// ── 2. Стенные часы ↔ момент времени ──────────────────────────────────────

const WALL_CASES = [
  // UTC: перевода нет.
  [UTC, '2026-03-08 02:30', '2026-03-08T02:30:00.000Z'],
  [UTC, '2026-11-01 01:30', '2026-11-01T01:30:00.000Z'],
  // Москва: UTC+3 круглый год, европейские даты перевода её не касаются.
  [MSK, '2026-03-29 02:30', '2026-03-28T23:30:00.000Z'],
  [MSK, '2026-10-25 02:30', '2026-10-24T23:30:00.000Z'],
  [MSK, '2026-07-01 12:00', '2026-07-01T09:00:00.000Z'],
  // Нью-Йорк: 8 марта 02:00 → 03:00 (разрыв), 1 ноября 02:00 → 01:00 (двойной час).
  [NY, '2026-01-15 12:00', '2026-01-15T17:00:00.000Z'],
  [NY, '2026-07-15 12:00', '2026-07-15T16:00:00.000Z'],
  [NY, '2026-03-08 01:59', '2026-03-08T06:59:00.000Z'],
  [NY, '2026-03-08 02:00', '2026-03-08T07:00:00.000Z'],
  [NY, '2026-03-08 02:30', '2026-03-08T07:00:00.000Z'],
  [NY, '2026-03-08 02:59', '2026-03-08T07:00:00.000Z'],
  [NY, '2026-03-08 03:00', '2026-03-08T07:00:00.000Z'],
  [NY, '2026-03-08 03:01', '2026-03-08T07:01:00.000Z'],
  [NY, '2026-11-01 00:59', '2026-11-01T04:59:00.000Z'],
  [NY, '2026-11-01 01:00', '2026-11-01T05:00:00.000Z'],
  [NY, '2026-11-01 01:30', '2026-11-01T05:30:00.000Z'],
  [NY, '2026-11-01 01:59', '2026-11-01T05:59:00.000Z'],
  [NY, '2026-11-01 02:00', '2026-11-01T07:00:00.000Z'],
  // Берлин: 29 марта 02:00 → 03:00, 25 октября 03:00 → 02:00.
  [BER, '2026-03-29 01:59', '2026-03-29T00:59:00.000Z'],
  [BER, '2026-03-29 02:00', '2026-03-29T01:00:00.000Z'],
  [BER, '2026-03-29 02:30', '2026-03-29T01:00:00.000Z'],
  [BER, '2026-03-29 03:00', '2026-03-29T01:00:00.000Z'],
  [BER, '2026-10-25 01:59', '2026-10-24T23:59:00.000Z'],
  [BER, '2026-10-25 02:00', '2026-10-25T00:00:00.000Z'],
  [BER, '2026-10-25 02:30', '2026-10-25T00:30:00.000Z'],
  [BER, '2026-10-25 02:59', '2026-10-25T00:59:00.000Z'],
  [BER, '2026-10-25 03:00', '2026-10-25T02:00:00.000Z'],
  // Токио: UTC+9, перевода нет.
  [TYO, '2026-03-08 02:30', '2026-03-07T17:30:00.000Z'],
  [TYO, '2026-11-19 05:00', '2026-11-18T20:00:00.000Z'],
  // Сидней (южное полушарие): 5 апреля 03:00 → 02:00, 4 октября 02:00 → 03:00.
  [SYD, '2026-01-15 12:00', '2026-01-15T01:00:00.000Z'],
  [SYD, '2026-07-15 12:00', '2026-07-15T02:00:00.000Z'],
  [SYD, '2026-04-05 01:59', '2026-04-04T14:59:00.000Z'],
  [SYD, '2026-04-05 02:00', '2026-04-04T15:00:00.000Z'],
  [SYD, '2026-04-05 02:30', '2026-04-04T15:30:00.000Z'],
  [SYD, '2026-04-05 03:00', '2026-04-04T17:00:00.000Z'],
  [SYD, '2026-10-04 01:59', '2026-10-03T15:59:00.000Z'],
  [SYD, '2026-10-04 02:00', '2026-10-03T16:00:00.000Z'],
  [SYD, '2026-10-04 02:30', '2026-10-03T16:00:00.000Z'],
  [SYD, '2026-10-04 03:00', '2026-10-03T16:00:00.000Z'],
  [SYD, '2026-10-04 03:01', '2026-10-03T16:01:00.000Z'],
];

test('стенные часы → момент: обычное время, разрыв и двойной час', () => {
  for (const [zone, text, expected] of WALL_CASES) {
    assert.equal(iso(zonedTimeToDate(wall(text), zone)), expected, `${zone} ${text}`);
  }
});

test('стенные часы → момент: совпадает с эталоном перебором минут', () => {
  for (const [zone, text] of WALL_CASES) {
    assert.equal(
      iso(zonedTimeToDate(wall(text), zone)),
      iso(referenceInstant(wall(text), zone)),
      `${zone} ${text}`,
    );
  }
});

const PARTS_CASES = [
  [NY, '2026-03-08T06:59:00Z', '2026-03-08 01:59', 0],
  [NY, '2026-03-08T07:00:00Z', '2026-03-08 03:00', 0],
  [NY, '2026-11-01T05:30:00Z', '2026-11-01 01:30', 0],
  [NY, '2026-11-01T06:30:00Z', '2026-11-01 01:30', 0],
  [BER, '2026-03-29T01:00:00Z', '2026-03-29 03:00', 0],
  [BER, '2026-10-25T01:30:00Z', '2026-10-25 02:30', 0],
  [TYO, '2026-11-18T21:00:00Z', '2026-11-19 06:00', 4],
  [SYD, '2026-10-03T16:00:00Z', '2026-10-04 03:00', 0],
  [SYD, '2026-04-04T16:30:00Z', '2026-04-05 02:30', 0],
  [MSK, '2026-12-31T21:00:00Z', '2027-01-01 00:00', 5],
  [UTC, '1970-01-01T00:00:00Z', '1970-01-01 00:00', 4],
];

test('момент → стенные часы и день недели в поясе', () => {
  for (const [zone, instant, expected, weekday] of PARTS_CASES) {
    const parts = zonedParts(new Date(instant), zone);
    assert.equal(wallText(parts), expected, `${zone} ${instant}`);
    assert.equal(parts.weekday, weekday, `день недели ${zone} ${instant}`);
    assert.equal(parts.second, 0);
  }
});

test('стенные часы: переполнение дня нормализуется, мусор — ошибка', () => {
  assert.equal(
    iso(zonedTimeToDate({ year: 2026, month: 2, day: 31, hour: 5, minute: 0 }, MSK)),
    '2026-03-03T02:00:00.000Z',
  );
  assert.throws(() => zonedTimeToDate(wall('2026-03-08 02:30'), 'Europe/Moskow'), /часовой пояс/);
  assert.throws(() => zonedParts(new Date(Number.NaN), UTC), RangeError);
});

// ── 3. Расписание в поясе профиля ─────────────────────────────────────────

const NEXT_CASES = [
  // Еженедельно, четверг 05:00, от воскресенья 15.11.2026 12:00 UTC.
  ['UTC: чт 05:00', weekly(4, '05:00', UTC), '2026-11-15T12:00:00Z', '2026-11-19T05:00:00.000Z'],
  ['Москва: чт 05:00', weekly(4, '05:00', MSK), '2026-11-15T12:00:00Z', '2026-11-19T02:00:00.000Z'],
  ['Нью-Йорк: чт 05:00', weekly(4, '05:00', NY), '2026-11-15T12:00:00Z', '2026-11-19T10:00:00.000Z'],
  ['Берлин: чт 05:00', weekly(4, '05:00', BER), '2026-11-15T12:00:00Z', '2026-11-19T04:00:00.000Z'],
  ['Токио: чт 05:00', weekly(4, '05:00', TYO), '2026-11-15T12:00:00Z', '2026-11-18T20:00:00.000Z'],
  ['Сидней: чт 05:00', weekly(4, '05:00', SYD), '2026-11-15T12:00:00Z', '2026-11-18T18:00:00.000Z'],
  // «Сегодня» и день недели — в поясе профиля, а не процесса.
  ['Токио: в четверг до 05:00 — сегодня', weekly(4, '05:00', TYO), '2026-11-18T19:59:00Z', '2026-11-18T20:00:00.000Z'],
  ['Токио: ровно в 05:00 — через неделю', weekly(4, '05:00', TYO), '2026-11-18T20:00:00Z', '2026-11-25T20:00:00.000Z'],
  ['Токио: в четверг после 05:00 — через неделю', weekly(4, '05:00', TYO), '2026-11-18T21:00:00Z', '2026-11-25T20:00:00.000Z'],
  // Нью-Йорк: 8 марта и 1 ноября.
  ['Нью-Йорк: вс 02:30 в день разрыва → 03:00', weekly(0, '02:30', NY), '2026-03-01T12:00:00Z', '2026-03-08T07:00:00.000Z'],
  ['Нью-Йорк: после разрыва — обычное 02:30', weekly(0, '02:30', NY), '2026-03-08T07:00:00Z', '2026-03-15T06:30:00.000Z'],
  ['Нью-Йорк: вс 01:30 в двойной час → первое', weekly(0, '01:30', NY), '2026-10-31T12:00:00Z', '2026-11-01T05:30:00.000Z'],
  ['Нью-Йорк: после первого 01:30 второго запуска нет', weekly(0, '01:30', NY), '2026-11-01T05:30:00Z', '2026-11-08T06:30:00.000Z'],
  ['Нью-Йорк: между двумя 01:30 — следующая неделя', weekly(0, '01:30', NY), '2026-11-01T06:15:00Z', '2026-11-08T06:30:00.000Z'],
  ['Нью-Йорк: вс 05:00 держит стенные часы осенью', weekly(0, '05:00', NY), '2026-10-30T12:00:00Z', '2026-11-01T10:00:00.000Z'],
  ['Нью-Йорк: вс 05:00 держит стенные часы весной', weekly(0, '05:00', NY), '2026-03-07T12:00:00Z', '2026-03-08T09:00:00.000Z'],
  // Берлин: 29 марта и 25 октября.
  ['Берлин: вс 02:30 в день разрыва → 03:00', weekly(0, '02:30', BER), '2026-03-22T12:00:00Z', '2026-03-29T01:00:00.000Z'],
  ['Берлин: вс 02:30 в двойной час → первое', weekly(0, '02:30', BER), '2026-10-18T12:00:00Z', '2026-10-25T00:30:00.000Z'],
  ['Берлин: после первого 02:30 — следующая неделя', weekly(0, '02:30', BER), '2026-10-25T00:30:00Z', '2026-11-01T01:30:00.000Z'],
  ['Берлин: между двумя 02:30 — следующая неделя', weekly(0, '02:30', BER), '2026-10-25T01:10:00Z', '2026-11-01T01:30:00.000Z'],
  // Москва: в европейские даты перевода ничего не происходит.
  ['Москва: вс 02:30, 29 марта', weekly(0, '02:30', MSK), '2026-03-22T12:00:00Z', '2026-03-28T23:30:00.000Z'],
  ['Москва: вс 02:30, 25 октября', weekly(0, '02:30', MSK), '2026-10-18T12:00:00Z', '2026-10-24T23:30:00.000Z'],
  // Сидней: 5 апреля и 4 октября.
  ['Сидней: вс 02:30 в двойной час → первое', weekly(0, '02:30', SYD), '2026-03-29T12:00:00Z', '2026-04-04T15:30:00.000Z'],
  ['Сидней: после первого 02:30 — следующая неделя', weekly(0, '02:30', SYD), '2026-04-04T15:30:00Z', '2026-04-11T16:30:00.000Z'],
  ['Сидней: между двумя 02:30 — следующая неделя', weekly(0, '02:30', SYD), '2026-04-04T16:10:00Z', '2026-04-11T16:30:00.000Z'],
  ['Сидней: вс 02:30 в день разрыва → 03:00', weekly(0, '02:30', SYD), '2026-09-27T12:00:00Z', '2026-10-03T16:00:00.000Z'],
  ['Сидней: после разрыва — обычное 02:30', weekly(0, '02:30', SYD), '2026-10-03T16:00:00Z', '2026-10-10T15:30:00.000Z'],
  // Без перевода часов.
  ['Токио: вс 02:30, 8 марта', weekly(0, '02:30', TYO), '2026-03-01T12:00:00Z', '2026-03-07T17:30:00.000Z'],
  ['UTC: вс 02:30, 8 марта', weekly(0, '02:30', UTC), '2026-03-01T12:00:00Z', '2026-03-08T02:30:00.000Z'],
  // N-й день недели месяца.
  ['Берлин: первый чт 19:00', nth(1, 4, '19:00', BER), '2026-11-15T12:00:00Z', '2026-12-03T18:00:00.000Z'],
  ['Берлин: первый чт 19:00, следующий месяц', nth(1, 4, '19:00', BER), '2026-12-03T18:00:00Z', '2027-01-07T18:00:00.000Z'],
  ['Москва: первый чт 19:00', nth(1, 4, '19:00', MSK), '2026-11-15T12:00:00Z', '2026-12-03T16:00:00.000Z'],
  ['Нью-Йорк: последняя пт 03:30', nth(-1, 5, '03:30', NY), '2026-11-01T00:00:00Z', '2026-11-27T08:30:00.000Z'],
  ['UTC: последняя пт 03:30', nth(-1, 5, '03:30', UTC), '2026-11-01T00:00:00Z', '2026-11-27T03:30:00.000Z'],
  ['Нью-Йорк: второе вс 02:30 — разрыв', nth(2, 0, '02:30', NY), '2026-03-01T00:00:00Z', '2026-03-08T07:00:00.000Z'],
  ['Нью-Йорк: первое вс 01:30 — первое из двух', nth(1, 0, '01:30', NY), '2026-10-15T00:00:00Z', '2026-11-01T05:30:00.000Z'],
  ['Берлин: последнее вс 02:30 — разрыв', nth(-1, 0, '02:30', BER), '2026-03-01T00:00:00Z', '2026-03-29T01:00:00.000Z'],
  ['Берлин: последнее вс 02:30 — первое из двух', nth(-1, 0, '02:30', BER), '2026-10-01T00:00:00Z', '2026-10-25T00:30:00.000Z'],
  ['Сидней: первое вс 02:30 — первое из двух', nth(1, 0, '02:30', SYD), '2026-04-01T00:00:00Z', '2026-04-04T15:30:00.000Z'],
  ['Сидней: первое вс 02:30 — разрыв', nth(1, 0, '02:30', SYD), '2026-10-01T00:00:00Z', '2026-10-03T16:00:00.000Z'],
  ['Токио: первый чт 05:00 — декабрь по поясу', nth(1, 4, '05:00', TYO), '2026-11-30T21:00:00Z', '2026-12-02T20:00:00.000Z'],
  // День месяца.
  ['Токио: 31-е в феврале → 28-е', mday(31, '06:00', TYO), '2027-02-01T00:00:00Z', '2027-02-27T21:00:00.000Z'],
  ['Сидней: 1-е 00:30', mday(1, '00:30', SYD), '2026-11-15T00:00:00Z', '2026-11-30T13:30:00.000Z'],
  ['Берлин: 25-е 02:30 — первое из двух', mday(25, '02:30', BER), '2026-10-01T00:00:00Z', '2026-10-25T00:30:00.000Z'],
  ['Нью-Йорк: 8-е 02:30 — разрыв', mday(8, '02:30', NY), '2026-03-01T00:00:00Z', '2026-03-08T07:00:00.000Z'],
  ['Сидней: 4-е 02:30 — разрыв', mday(4, '02:30', SYD), '2026-09-15T00:00:00Z', '2026-10-03T16:00:00.000Z'],
  ['Москва: 1-е 05:00 — месяц по поясу', mday(1, '05:00', MSK), '2026-11-30T22:00:00Z', '2026-12-01T02:00:00.000Z'],
  // Каждые N дней; якорь — дата в поясе профиля.
  ['Москва: каждые 7 дн. от 01.11', interval(7, '05:00', '2026-11-01', MSK), '2026-11-15T12:00:00Z', '2026-11-22T02:00:00.000Z'],
  ['Москва: каждые 7 дн., следующий цикл', interval(7, '05:00', '2026-11-01', MSK), '2026-11-22T02:30:00Z', '2026-11-29T02:00:00.000Z'],
  ['Москва: якорь сегодня, время прошло', interval(7, '05:00', '2026-11-15', MSK), '2026-11-15T12:00:00Z', '2026-11-22T02:00:00.000Z'],
  ['Нью-Йорк: цикл через разрыв', interval(7, '02:30', '2026-03-01', NY), '2026-03-01T12:00:00Z', '2026-03-08T07:00:00.000Z'],
  ['Нью-Йорк: после разрыва цикл не сдвигается', interval(7, '02:30', '2026-03-01', NY), '2026-03-08T07:00:00Z', '2026-03-15T06:30:00.000Z'],
  ['Нью-Йорк: цикл через двойной час', interval(7, '01:30', '2026-10-25', NY), '2026-10-25T12:00:00Z', '2026-11-01T05:30:00.000Z'],
  ['Берлин: между двумя 02:30 — следующий цикл', interval(7, '02:30', '2026-10-18', BER), '2026-10-25T01:10:00Z', '2026-11-01T01:30:00.000Z'],
  ['Сидней: 14 дн. через разрыв', interval(14, '02:30', '2026-09-20', SYD), '2026-09-21T00:00:00Z', '2026-10-03T16:00:00.000Z'],
  ['Сидней: 7 дн. через двойной час', interval(7, '02:30', '2026-03-29', SYD), '2026-03-29T12:00:00Z', '2026-04-04T15:30:00.000Z'],
  ['Токио: якорь — дата в поясе профиля', interval(1, '08:00', '2026-11-19', TYO), '2026-11-18T22:00:00Z', '2026-11-18T23:00:00.000Z'],
  ['Токио: якорь в будущем', interval(7, '05:00', '2026-12-10', TYO), '2026-11-15T00:00:00Z', '2026-12-09T20:00:00.000Z'],
  ['Токио: без якоря — от «сегодня» в поясе', interval(3, '08:00', null, TYO), '2026-11-18T22:00:00Z', '2026-11-18T23:00:00.000Z'],
  ['Токио: без якоря, время прошло', interval(3, '08:00', null, TYO), '2026-11-18T23:30:00Z', '2026-11-21T23:00:00.000Z'],
  ['UTC: якорь 26 лет назад — без перебора', interval(1, '05:00', '2000-01-01', UTC), '2026-11-15T12:00:00Z', '2026-11-16T05:00:00.000Z'],
];

test('nextOccurrence в поясе профиля: все виды и все пояса', () => {
  for (const [title, schedule, after, expected] of NEXT_CASES) {
    assert.ok(schedule.timeZone, `${title}: пояс не сохранился в расписании`);
    assert.equal(iso(nextOccurrence(schedule, new Date(after), schedule.timeZone)), expected, title);
  }
});

test('пояс по умолчанию берётся из schedule.timeZone', () => {
  for (const [title, schedule, after, expected] of NEXT_CASES) {
    assert.equal(iso(nextOccurrence(schedule, new Date(after))), expected, title);
  }
});

test('явный пояс главнее schedule.timeZone', () => {
  const schedule = weekly(4, '05:00', TYO);
  assert.equal(iso(nextOccurrence(schedule, new Date('2026-11-15T12:00:00Z'), MSK)), '2026-11-19T02:00:00.000Z');
  assert.throws(() => nextOccurrence(schedule, new Date(), 'Europe/Moskow'), /Неизвестный часовой пояс/);
});

// ── 4. Без пояса — прежнее поведение (пояс процесса) ─────────────────────

test('без пояса: те же ответы, что в tools/test.mjs', () => {
  const s = normalizeSchedule({ kind: 'weekly', weekday: 4, time: '05:00' });
  assert.ok(!s.timeZone);
  assert.equal(fmtLocal(nextOccurrence(s, localDate(2026, 11, 15, 12, 0))), '2026-11-19 05:00');
  assert.equal(fmtLocal(nextOccurrence(s, localDate(2026, 11, 19, 4, 0))), '2026-11-19 05:00');
  assert.equal(fmtLocal(nextOccurrence(s, localDate(2026, 11, 19, 6, 0))), '2026-11-26 05:00');

  const first = normalizeSchedule({ kind: 'monthly_nth_weekday', nth: 1, weekday: 4, time: '19:00' });
  assert.equal(fmtLocal(nextOccurrence(first, localDate(2026, 11, 15, 12, 0))), '2026-12-03 19:00');
  assert.equal(fmtLocal(nextOccurrence(first, localDate(2026, 12, 3, 20, 0))), '2027-01-07 19:00');

  const last = normalizeSchedule({ kind: 'monthly_nth_weekday', nth: -1, weekday: 5, time: '03:30' });
  assert.equal(fmtLocal(nextOccurrence(last, localDate(2026, 11, 1, 0, 0))), '2026-11-27 03:30');

  const day31 = normalizeSchedule({ kind: 'monthly_day', day: 31, time: '06:00' });
  assert.equal(fmtLocal(nextOccurrence(day31, localDate(2027, 2, 1, 0, 0))), '2027-02-28 06:00');

  const every7 = normalizeSchedule({ kind: 'interval', intervalDays: 7, time: '05:00', anchorDate: '2026-11-01' });
  assert.equal(fmtLocal(nextOccurrence(every7, localDate(2026, 11, 15, 12, 0))), '2026-11-22 05:00');
  assert.equal(fmtLocal(nextOccurrence(every7, localDate(2026, 11, 22, 5, 30))), '2026-11-29 05:00');
});

test('без пояса: стенные часы процесса держатся через перевод часов', () => {
  const sunday = normalizeSchedule({ kind: 'weekly', weekday: 0, time: '05:00' });
  assert.equal(fmtLocal(nextOccurrence(sunday, localDate(2026, 10, 30, 12, 0))), '2026-11-01 05:00');
  assert.equal(fmtLocal(nextOccurrence(sunday, localDate(2026, 3, 7, 12, 0))), '2026-03-08 05:00');
  assert.equal(fmtLocal(nextOccurrence(sunday, localDate(2026, 3, 28, 12, 0))), '2026-03-29 05:00');
  assert.equal(fmtLocal(nextOccurrence(sunday, localDate(2026, 4, 4, 12, 0))), '2026-04-05 05:00');
});

test('без пояса: пусто, null и undefined — одно и то же', () => {
  const s = normalizeSchedule({ kind: 'weekly', weekday: 4, time: '05:00' });
  const after = localDate(2026, 11, 15, 12, 0);
  const expected = nextOccurrence(s, after).getTime();
  for (const zone of [undefined, null, '', '   ']) {
    assert.equal(nextOccurrence(s, after, zone).getTime(), expected, `пояс ${JSON.stringify(zone)}`);
  }
  // У расписания свой пояс, но вызывающий явно просит пояс процесса.
  const zoned = weekly(4, '05:00', TYO);
  assert.equal(nextOccurrence(zoned, after, '').getTime(), expected);
});

test('без пояса: несуществующее время — по правилам Date, как раньше', () => {
  const s = normalizeSchedule({ kind: 'weekly', weekday: 0, time: '02:30' });
  const after = localDate(2026, 3, 1, 12, 0);
  const got = nextOccurrence(s, after);
  assert.equal(got.getTime(), new Date(2026, 2, 8, 2, 30, 0, 0).getTime());
  if (processZone === NY) {
    // Date переносит 02:30 на 03:30, а пояс профиля — на момент перевода, 03:00.
    assert.equal(iso(got), '2026-03-08T07:30:00.000Z');
    assert.equal(iso(nextOccurrence(s, after, NY)), '2026-03-08T07:00:00.000Z');
  }
});

const LEGACY_SCHEDULES = [
  { kind: 'weekly', weekday: 0, time: '02:30' },
  { kind: 'weekly', weekday: 4, time: '05:00' },
  { kind: 'weekly', weekday: 6, time: '23:30' },
  { kind: 'monthly_nth_weekday', nth: 1, weekday: 4, time: '19:00' },
  { kind: 'monthly_nth_weekday', nth: -1, weekday: 0, time: '02:30' },
  { kind: 'monthly_nth_weekday', nth: 2, weekday: 0, time: '02:30' },
  { kind: 'monthly_day', day: 31, time: '06:00' },
  { kind: 'monthly_day', day: 8, time: '02:30' },
  { kind: 'interval', intervalDays: 7, time: '02:30', anchorDate: '2026-03-01' },
  { kind: 'interval', intervalDays: 3, time: '05:00' },
].map((item) => asGiven(item));

// Якорь так давно, что прежний цикл упирается в предел 5000 шагов, —
// и эта особенность без пояса тоже должна остаться прежней.
const LEGACY_GUARD = normalizeSchedule({ kind: 'interval', intervalDays: 1, time: '05:00', anchorDate: '2000-01-01' });

test('без пояса: совпадает с кодом 1.5.6 на тысячах дат 2026 года', () => {
  let checked = 0;
  const compare = (schedule, after) => {
    assert.equal(
      iso(nextOccurrence(schedule, after)),
      iso(legacyNextOccurrence(schedule, after)),
      `${describeSchedule(schedule)} после ${iso(after)}`,
    );
    checked += 1;
  };
  for (let time = Date.UTC(2026, 0, 1); time < Date.UTC(2027, 0, 1); time += 5 * HOUR + 17 * MINUTE) {
    for (const schedule of LEGACY_SCHEDULES) compare(schedule, new Date(time));
  }
  for (let time = Date.UTC(2026, 0, 1); time < Date.UTC(2027, 0, 1); time += 3 * DAY + 5 * HOUR) {
    compare(LEGACY_GUARD, new Date(time));
  }
  assert.ok(checked > 15000);
});

// ── 5. Свип: инварианты и отпечаток ───────────────────────────────────────

// Моменты перевода часов в 2026 году. Для поясов без перевода берём
// европейские даты: проверяем, что там ничего не происходит.
const TRANSITIONS = {
  [UTC]: ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
  [MSK]: ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
  [TYO]: ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
  [NY]: ['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z'],
  [BER]: ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
  [SYD]: ['2026-04-04T16:00:00Z', '2026-10-03T16:00:00Z'],
};

const SWEEP_SCHEDULES = [
  { kind: 'weekly', weekday: 0, time: '02:30' },
  { kind: 'weekly', weekday: 0, time: '01:30' },
  { kind: 'weekly', weekday: 4, time: '05:00' },
  { kind: 'monthly_nth_weekday', nth: 1, weekday: 0, time: '02:30' },
  { kind: 'monthly_nth_weekday', nth: -1, weekday: 0, time: '02:30' },
  { kind: 'monthly_day', day: 31, time: '00:30' },
  { kind: 'interval', intervalDays: 7, time: '02:30', anchorDate: '2026-01-04' },
  { kind: 'interval', intervalDays: 3, time: '23:30' },
];

function sweepAfters(zone) {
  const out = [];
  for (let time = Date.UTC(2026, 0, 1); time < Date.UTC(2027, 0, 1); time += 5 * DAY + 7 * HOUR) out.push(time);
  for (const text of TRANSITIONS[zone]) {
    const moment = Date.parse(text);
    for (let k = -40; k <= 40; k += 1) out.push(moment + k * 53 * MINUTE);
    for (let k = 0; k <= 28; k += 1) out.push(moment - 7 * DAY + k * 6 * HOUR);
  }
  return out.map((time) => new Date(Math.floor(time / MINUTE) * MINUTE));
}

function nthDayOfMonth(year, month, weekday, n) {
  const days = [];
  for (let day = 1; day <= daysIn(year, month); day += 1) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) days.push(day);
  }
  return n === -1 ? days[days.length - 1] : days[n - 1];
}

/** Предыдущий день расписания перед днём результата, или null, если его нет. */
function previousRunDay(schedule, parts, after, zone) {
  const [h, m] = schedule.time.split(':').map(Number);
  const back = (year, month, day) => zonedTimeToDate({ year, month, day, hour: h, minute: m }, zone);
  switch (schedule.kind) {
    case 'weekly':
      return back(parts.year, parts.month, parts.day - 7);
    case 'monthly_nth_weekday':
    case 'monthly_day': {
      const year = parts.month === 1 ? parts.year - 1 : parts.year;
      const month = parts.month === 1 ? 12 : parts.month - 1;
      const day =
        schedule.kind === 'monthly_day'
          ? Math.min(schedule.day, daysIn(year, month))
          : nthDayOfMonth(year, month, schedule.weekday, schedule.nth);
      return back(year, month, day);
    }
    case 'interval': {
      if (!schedule.anchorDate) {
        const today = zonedParts(after, zone);
        const start = dayIndex(today.year, today.month, today.day);
        return dayIndex(parts.year, parts.month, parts.day) - schedule.intervalDays >= start
          ? back(parts.year, parts.month, parts.day - schedule.intervalDays)
          : null;
      }
      const [ay, am, ad] = schedule.anchorDate.split('-').map(Number);
      return dayIndex(parts.year, parts.month, parts.day) - schedule.intervalDays >= dayIndex(ay, am, ad)
        ? back(parts.year, parts.month, parts.day - schedule.intervalDays)
        : null;
    }
    default:
      return null;
  }
}

function checkSweepResult(schedule, zone, after, result) {
  const label = `${zone} ${describeSchedule(schedule)} после ${iso(after)} → ${iso(result)}`;
  assert.ok(result.getTime() > after.getTime(), `не строго позже: ${label}`);

  const parts = zonedParts(result, zone);
  const [h, m] = schedule.time.split(':').map(Number);
  const target = h * 60 + m;
  const got = parts.hour * 60 + parts.minute;
  if (got !== target) {
    // Только разрыв: минутой раньше часы показывали меньше нужного, сейчас — больше.
    const before = zonedParts(result.getTime() - MINUTE, zone);
    const sameDay = before.day === parts.day;
    assert.ok(sameDay && before.hour * 60 + before.minute < target && target < got, `не то время: ${label}`);
  }

  // Двойной час: раньше на 30, 60 и 120 минут таких же стенных часов быть не должно.
  for (const shift of [30, 60, 120]) {
    const earlier = zonedParts(result.getTime() - shift * MINUTE, zone);
    assert.notEqual(wallText(earlier), wallText(parts), `взято второе из двух: ${label}`);
  }

  switch (schedule.kind) {
    case 'weekly':
      assert.equal(parts.weekday, schedule.weekday, `не тот день недели: ${label}`);
      break;
    case 'monthly_nth_weekday':
      assert.equal(parts.day, nthDayOfMonth(parts.year, parts.month, schedule.weekday, schedule.nth), `не тот день: ${label}`);
      break;
    case 'monthly_day':
      assert.equal(parts.day, Math.min(schedule.day, daysIn(parts.year, parts.month)), `не то число: ${label}`);
      break;
    case 'interval': {
      const base = schedule.anchorDate
        ? schedule.anchorDate.split('-').map(Number)
        : (() => {
            const today = zonedParts(after, zone);
            return [today.year, today.month, today.day];
          })();
      const diff = dayIndex(parts.year, parts.month, parts.day) - dayIndex(...base);
      assert.ok(diff >= 0 && diff % schedule.intervalDays === 0, `сбился цикл: ${label}`);
      break;
    }
    default:
      break;
  }

  // Ничего не пропущено: предыдущий день расписания уже наступил.
  const previous = previousRunDay(schedule, parts, after, zone);
  if (previous) assert.ok(previous.getTime() <= after.getTime(), `пропущен запуск ${iso(previous)}: ${label}`);
}

let sweepDigest = null;
let sweepCount = 0;

test('свип: инварианты расписания в поясе и отпечаток расчётов', () => {
  const hash = createHash('sha256');
  const schedules = SWEEP_SCHEDULES.map((item) => asGiven(item));
  for (const zone of ZONES) {
    for (const after of sweepAfters(zone)) {
      // Обратный перевод: те же стенные часы; раньше — только во втором проходе двойного часа.
      const parts = zonedParts(after, zone);
      const back = zonedTimeToDate(parts, zone);
      assert.equal(wallText(zonedParts(back, zone)), wallText(parts), `${zone} ${iso(after)}`);
      assert.ok(back.getTime() === after.getTime() || back.getTime() === after.getTime() - HOUR, `${zone} ${iso(after)}`);
      hash.update(`${zone}|${iso(after)}|${wallText(parts)}|${iso(back)}\n`);

      for (const [index, base] of schedules.entries()) {
        const schedule = { ...base, timeZone: zone };
        const result = nextOccurrence(schedule, after, zone);
        checkSweepResult(schedule, zone, after, result);
        hash.update(`${zone}|${index}|${iso(after)}|${iso(result)}\n`);
        sweepCount += 1;
      }
    }
  }
  for (const [title, schedule, after] of NEXT_CASES) {
    hash.update(`${title}|${iso(nextOccurrence(schedule, new Date(after)))}\n`);
  }
  sweepDigest = hash.digest('hex');
  assert.ok(sweepCount > 10000, `мало расчётов: ${sweepCount}`);
});

// ── 6. Нормализация, проверка и описание ──────────────────────────────────

test('normalizeSchedule хранит пояс; мусор отбрасывает', () => {
  assert.equal(normalizeSchedule({}).timeZone, '');
  assert.equal(normalizeSchedule({ timeZone: '' }).timeZone, '');
  assert.equal(normalizeSchedule({ timeZone: 'europe/berlin' }).timeZone, BER);
  assert.equal(normalizeSchedule({ timeZone: 'Europe/Moskow' }).timeZone, '');
  assert.equal(normalizeSchedule({ timeZone: 42 }).timeZone, '');
  const s = normalizeSchedule({ kind: 'interval', intervalDays: 14, time: '4:05', anchorDate: '2026-11-01', timeZone: SYD });
  assert.deepEqual(s, {
    kind: 'interval',
    time: '04:05',
    timeZone: SYD,
    weekday: 4,
    nth: 1,
    day: 1,
    intervalDays: 14,
    anchorDate: '2026-11-01',
  });
});

test('validateScheduleInput: понятная ошибка на неизвестный пояс', () => {
  for (const ok of [undefined, null, {}, { timeZone: '' }, { timeZone: '  ' }, { timeZone: MSK }, { timeZone: 'europe/moscow' }]) {
    assert.deepEqual(validateScheduleInput(ok), [], JSON.stringify(ok));
  }
  const [error, ...rest] = validateScheduleInput({ timeZone: 'Europe/Moskow' });
  assert.equal(rest.length, 0);
  assert.match(error, /часовой пояс/);
  assert.match(error, /«Europe\/Moskow»/);
  assert.match(error, /Europe\/Moscow/);
  assert.equal(validateScheduleInput({ timeZone: 42 }).length, 1);
  assert.equal(validateScheduleInput({ timeZone: '+03:00' }).length, 1);
  const long = validateScheduleInput({ timeZone: `Europe/${'x'.repeat(500)}` })[0];
  assert.ok(long.length < 160, 'в ошибку не должен попадать весь мусор');
});

test('describeSchedule показывает пояс, только если он задан', () => {
  assert.equal(describeSchedule(weekly(4, '05:00', '')), 'Еженедельно: четверг, 05:00');
  assert.equal(describeSchedule(weekly(4, '05:00', MSK)), 'Еженедельно: четверг, 05:00 (Europe/Moscow)');
  assert.equal(describeSchedule(nth(-1, 5, '03:30', NY)), 'Ежемесячно: последний пятница, 03:30 (America/New_York)');
  assert.equal(describeSchedule(mday(31, '06:00', TYO)), 'Ежемесячно: 31-е число, 06:00 (Asia/Tokyo)');
  assert.equal(describeSchedule(interval(7, '05:00', null, SYD)), 'Каждые 7 дн., 05:00 (Australia/Sydney)');
  assert.equal(describeScheduleShort(weekly(4, '05:00', BER)), 'Чт, 05:00 (Europe/Berlin)');
  assert.equal(describeScheduleShort(weekly(4, '05:00', '')), 'Чт, 05:00');
});

// ── 7. Профиль: store.js и index.js ───────────────────────────────────────

const SERVER = { id: 'srv1', uuid: 'uuid-1', nodeId: 'node-1', ownerId: 'owner', name: 'Rust', status: 'stopped' };

/** Контекст плагина в памяти: коллекции, сервер, туннель с деревом файлов. */
function fakeContext({ config = {}, tree = {} } = {}) {
  const stores = new Map();
  const routes = [];
  const matches = (doc, filter) => Object.entries(filter || {}).every(([key, value]) => doc[key] === value);
  const collection = (name) => {
    if (!stores.has(name)) stores.set(name, []);
    const docs = stores.get(name);
    return {
      async find(filter = {}, options = {}) {
        const found = docs.filter((doc) => matches(doc, filter));
        return structuredClone(options.limit ? found.slice(0, options.limit) : found);
      },
      async findOne(filter) {
        const doc = docs.find((item) => matches(item, filter));
        return doc ? structuredClone(doc) : null;
      },
      async insert(doc) {
        docs.push(structuredClone(doc));
        return doc;
      },
      async update(filter, update) {
        let count = 0;
        for (const doc of docs) {
          if (!matches(doc, filter)) continue;
          Object.assign(doc, structuredClone(update.$set || {}));
          count += 1;
        }
        return count;
      },
      async delete(filter) {
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i -= 1) if (matches(docs[i], filter)) docs.splice(i, 1);
        return before - docs.length;
      },
      async count(filter) {
        return docs.filter((doc) => matches(doc, filter)).length;
      },
    };
  };
  const ctx = {
    manifest: { name: 'rust-autowipe', version: 'test' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: (key) => config[key],
    getStorage: async () => null,
    setStorage: async () => {},
    collection,
    db: { servers: { findUnique: async ({ where }) => (where.id === SERVER.id ? { ...SERVER } : null) } },
    registerRoute: (route) => routes.push(route),
    scheduleTask: () => {},
    emit: () => {},
    getUserId: () => 'owner',
    hasPermission: () => true,
    fileTunnel: {
      async queueRequest(_nodeId, operation, _uuid, path) {
        if (operation === 'list') return { success: true, data: tree[path] || [] };
        return { success: true };
      },
    },
  };
  return { ctx, stores, routes };
}

async function callRoute(routes, method, url, { params = {}, body } = {}) {
  const route = routes.find((item) => item.method === method && item.url === url);
  assert.ok(route, `нет роута ${method} ${url}`);
  const reply = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      return payload;
    },
  };
  const result = await route.handler({ params, query: {}, body, headers: {} }, reply);
  return { result, status: reply.statusCode };
}

/** Поддельные часы: new Date() и Date.now() отдают заданный момент. */
async function atFakeNow(text, fn) {
  const RealDate = Date;
  const fixed = RealDate.parse(text);
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }

    static now() {
      return fixed;
    }
  }
  globalThis.Date = FakeDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

const zonedProfile = (overrides = {}) => ({
  id: 'p1',
  name: 'Вайп',
  serverId: SERVER.id,
  enabled: true,
  targets: ['/server/*.db'],
  excludes: [],
  options: { stopServer: false, startServer: false, dryRun: true, warnChat: false, commandsAfter: [] },
  ...overrides,
});

test('профиль: неизвестный пояс — ошибка, профиль не сохраняется', async () => {
  const { ctx, stores, routes } = fakeContext();
  await plugin.onLoad(ctx);
  const { result, status } = await callRoute(routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: SERVER.id },
    body: { name: 'x', targets: ['/server/*'], schedule: { kind: 'weekly', weekday: 4, time: '05:00', timeZone: 'Europe/Moskow' } },
  });
  assert.equal(status, 400);
  assert.match(result.error, /неизвестный часовой пояс «Europe\/Moskow»/);
  assert.equal((stores.get('profiles') || []).length, 0);
});

test('профиль: создание и правка считают nextRunAt в поясе профиля', async () => {
  const { ctx, stores, routes } = fakeContext();
  await plugin.onLoad(ctx);
  const params = { serverId: SERVER.id };
  const schedule = { kind: 'weekly', weekday: 4, time: '05:00' };

  await atFakeNow('2026-11-15T12:00:00Z', async () => {
    const created = await callRoute(routes, 'POST', '/servers/:serverId/profiles', {
      params,
      body: { name: 'Вайп', targets: ['/server/*'], schedule: { ...schedule, timeZone: 'asia/tokyo' } },
    });
    assert.equal(created.status, 200);
    const id = created.result.data.id;
    assert.equal(created.result.data.schedule.timeZone, TYO);
    assert.equal(created.result.data.nextRunAt, '2026-11-18T20:00:00.000Z');

    const list = await callRoute(routes, 'GET', '/servers/:serverId/profiles', { params });
    assert.equal(list.result.data[0].scheduleText, 'Еженедельно: четверг, 05:00 (Asia/Tokyo)');

    const moved = await callRoute(routes, 'PUT', '/servers/:serverId/profiles/:profileId', {
      params: { ...params, profileId: id },
      body: { schedule: { ...schedule, timeZone: MSK } },
    });
    assert.equal(moved.result.data.nextRunAt, '2026-11-19T02:00:00.000Z');

    // «Выключить» шлёт только enabled: пояс остаётся прежним.
    const toggled = await callRoute(routes, 'PUT', '/servers/:serverId/profiles/:profileId', {
      params: { ...params, profileId: id },
      body: { enabled: false },
    });
    assert.equal(toggled.result.data.schedule.timeZone, MSK);
    assert.equal(toggled.result.data.nextRunAt, '2026-11-19T02:00:00.000Z');

    const broken = await callRoute(routes, 'PUT', '/servers/:serverId/profiles/:profileId', {
      params: { ...params, profileId: id },
      body: { schedule: { ...schedule, timeZone: 'Mars/Base' } },
    });
    assert.equal(broken.status, 400);
    assert.equal(stores.get('profiles')[0].schedule.timeZone, MSK);

    // Пустой пояс — пояс панели, как у профилей до этой версии.
    const panel = await callRoute(routes, 'PUT', '/servers/:serverId/profiles/:profileId', {
      params: { ...params, profileId: id },
      body: { schedule: { ...schedule, timeZone: '' } },
    });
    assert.equal(panel.result.data.schedule.timeZone, '');
    assert.equal(panel.result.data.nextRunAt, iso(legacyNextOccurrence(normalizeSchedule(schedule), new Date())));
  });
});

test('тик: пустой nextRunAt считается в поясе профиля', async () => {
  const { ctx, stores } = fakeContext();
  stores.set('profiles', [zonedProfile({ schedule: { kind: 'weekly', weekday: 4, time: '05:00', timeZone: SYD } })]);
  await atFakeNow('2026-11-15T12:00:00Z', () => runTick(ctx));
  assert.equal(stores.get('profiles')[0].nextRunAt, '2026-11-18T18:00:00.000Z');
});

test('тик: догон вне окна переносит запуск на неделю, а не на второе 01:30', async () => {
  const { ctx, stores } = fakeContext({ config: { catchUpMinutes: 30 } });
  stores.set('profiles', [
    zonedProfile({
      schedule: { kind: 'weekly', weekday: 0, time: '01:30', timeZone: NY },
      nextRunAt: '2026-11-01T05:30:00.000Z',
    }),
  ]);
  // 01:15 по Нью-Йорку во втором проходе двойного часа, опоздание 45 минут.
  await atFakeNow('2026-11-01T06:15:00Z', () => runTick(ctx));
  const profile = stores.get('profiles')[0];
  assert.equal(profile.nextRunAt, '2026-11-08T06:30:00.000Z');
  assert.equal(profile.lastSkippedAt, '2026-11-01T06:15:00.000Z');
  assert.equal((stores.get('runs') || []).length, 0);
});

test('тик: после планового прогона nextRunAt — в поясе профиля', async () => {
  const tree = {
    '/': [{ name: 'server', isDirectory: true }],
    '/server': [{ name: 'sv.db', isDirectory: false }],
  };
  const { ctx, stores } = fakeContext({ tree });
  stores.set('profiles', [
    zonedProfile({
      schedule: { kind: 'weekly', weekday: 0, time: '02:30', timeZone: BER },
      nextRunAt: '2026-10-25T00:30:00.000Z',
    }),
  ]);
  // Первое 02:30 по Берлину прошло минуту назад; второе 02:30 (01:30 UTC) — не повод для ещё одного вайпа.
  await atFakeNow('2026-10-25T00:31:00Z', () => runTick(ctx));
  const runs = stores.get('runs') || [];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, 'schedule');
  assert.equal(runs[0].dryRun, true);
  assert.equal(stores.get('profiles')[0].nextRunAt, '2026-11-01T01:30:00.000Z');
});

test('тик: старый профиль без пояса считается как раньше — в поясе процесса', async () => {
  const { ctx, stores } = fakeContext();
  const schedule = { kind: 'weekly', weekday: 4, time: '05:00' };
  stores.set('profiles', [zonedProfile({ schedule })]);
  await atFakeNow('2026-11-15T12:00:00Z', () => runTick(ctx));
  const expected = legacyNextOccurrence(normalizeSchedule(schedule), new Date('2026-11-15T12:00:00Z'));
  assert.equal(stores.get('profiles')[0].nextRunAt, iso(expected));
});

// ── 8. Интерфейс: поле «Часовой пояс» и описание у профиля ────────────────

class FakeNode {
  constructor(tag, nodeType = 1) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.text = '';
    this.isConnected = true;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get classList() {
    const node = this;
    return {
      add: (...names) => {
        node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' ');
      },
      remove: () => {},
      contains: (name) => node.className.split(/\s+/).includes(name),
    };
  }

  get textContent() {
    return this.nodeType === 3 ? this.text : this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this.text = String(value);
      return;
    }
    this.children = [];
    const node = new FakeNode('#text', 3);
    node.text = String(value);
    this.appendChild(node);
  }

  set innerHTML(value) {
    this.children = [];
    if (value) this.textContent = value;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  querySelector() {
    return null;
  }

  focus() {}
}

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

const byText = (root, tag, text) =>
  findNode(root, (node) => node.tagName === tag && node.textContent.trim() === text);

/** Монтирует вкладку на поддельном DOM и отдаёт корень и PUT-запросы. */
async function mountTab(moduleUrl, profiles) {
  const wait = () => new Promise((resolve) => realSetTimeout(resolve, 20));
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace('/api/plugins/rust-autowipe/', '');
    requests.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const data = path.endsWith('/status')
      ? {
          server: { ...SERVER },
          version: 'test',
          clock: { now: '2026-11-15T12:00:00.000Z', timezone: 'Asia/Novosibirsk', offsetMinutes: 420 },
          hasApiKey: true,
          permissions: { canManage: true, canRun: true },
        }
      : path.endsWith('/profiles')
        ? profiles
        : [];
    return { ok: true, status: 200, json: async () => ({ success: true, data }) };
  };
  const mod = await import(moduleUrl);
  const root = new FakeNode('div');
  mod.default.tabs[0].component({ serverId: SERVER.id }).props.ref(root);
  await wait();
  return { root, requests, wait };
}

function zoneControl(root) {
  const label = byText(root, 'LABEL', 'Часовой пояс');
  assert.ok(label, 'нет поля «Часовой пояс»');
  return label.parentNode.children.find((node) => node.tagName === 'SELECT' || node.tagName === 'INPUT');
}

const realSetTimeout = globalThis.setTimeout;

test('интерфейс: пояс в описании, список поясов, сохранение', async () => {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    Node: globalThis.Node,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    supportedValuesOf: Intl.supportedValuesOf,
  };
  globalThis.document = {
    head: new FakeNode('head'),
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => Object.assign(new FakeNode('#text', 3), { text: String(text) }),
    getElementById: () => null,
  };
  globalThis.window = {};
  globalThis.Node = FakeNode;
  globalThis.setInterval = () => 0;
  globalThis.setTimeout = () => 0;
  try {
    // Asia/Kolkata — допустимое имя, которого может не быть в списке браузера.
    const profile = {
      ...zonedProfile({ id: 'p-ui', name: 'Вайп UI' }),
      schedule: { kind: 'weekly', weekday: 4, nth: 1, day: 1, time: '05:00', intervalDays: 7, timeZone: 'Asia/Kolkata' },
      nextRunAt: '2026-11-18T23:30:00.000Z',
    };
    const { root, requests, wait } = await mountTab('../../rust-autowipe/frontend/frontend.mjs', [profile]);
    assert.ok(root.textContent.includes('еженедельно: четверг, 05:00 (Asia/Kolkata)'), 'нет пояса в описании');

    byText(root, 'BUTTON', 'Изменить').listeners.click[0]();
    assert.ok(byText(root, 'LABEL', 'Время'), 'подпись «Время» без пояса панели');
    const select = zoneControl(root);
    assert.equal(select.tagName, 'SELECT');
    const options = select.children;
    assert.equal(options[0].attributes.value, '');
    assert.equal(options[0].textContent, 'Пояс панели (Asia/Novosibirsk)');
    const selected = options.filter((option) => option.attributes.selected !== undefined);
    assert.deepEqual(selected.map((option) => option.attributes.value), ['Asia/Kolkata']);
    assert.ok(options.some((option) => option.attributes.value === 'UTC'), 'нет UTC');
    assert.ok(options.some((option) => option.attributes.value === SYD), 'нет Australia/Sydney');

    select.listeners.change[0]({ target: { value: MSK } });
    byText(root, 'BUTTON', 'Сохранить').listeners.click[0]();
    await wait();
    const put = requests.find((request) => request.method === 'PUT');
    assert.ok(put, 'не было PUT');
    assert.equal(put.body.schedule.timeZone, MSK);

    // Новый профиль — «Пояс панели».
    byText(root, 'BUTTON', '+ Новый профиль').listeners.click[0]();
    const fresh = zoneControl(root).children.filter((option) => option.attributes.selected !== undefined);
    assert.deepEqual(fresh.map((option) => option.attributes.value), ['']);

    // Браузер без Intl.supportedValuesOf — текстовое поле.
    Intl.supportedValuesOf = undefined;
    const old = await mountTab('../../rust-autowipe/frontend/frontend.mjs?без-списка', [profile]);
    byText(old.root, 'BUTTON', 'Изменить').listeners.click[0]();
    const input = zoneControl(old.root);
    assert.equal(input.tagName, 'INPUT');
    assert.equal(input.attributes.value, 'Asia/Kolkata');
  } finally {
    Intl.supportedValuesOf = saved.supportedValuesOf;
    Object.assign(globalThis, {
      document: saved.document,
      window: saved.window,
      Node: saved.Node,
      fetch: saved.fetch,
      setInterval: saved.setInterval,
      setTimeout: saved.setTimeout,
    });
  }
});

// ── 9. Дочерний процесс: TZ действительно дошла ──────────────────────────

if (isChild) {
  test('TZ дошла до дочернего процесса', () => {
    assert.equal(processZone, process.env.TZ);
    const january = { UTC: 0, 'Europe/Moscow': -180, 'America/New_York': 300 }[process.env.TZ];
    if (january !== undefined) assert.equal(new Date(2026, 0, 15).getTimezoneOffset(), january);
  });
}

// ── Запуск ────────────────────────────────────────────────────────────────

function runChild(zone) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ: zone, [CHILD_ENV]: '1' },
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = String(child.stdout || '')
    .split(/\r?\n/)
    .find((item) => item.startsWith('RESULT '));
  let result = null;
  try {
    result = line ? JSON.parse(line.slice('RESULT '.length)) : null;
  } catch {
    result = null;
  }
  return { zone, status: child.status, error: child.error, stdout: child.stdout, stderr: child.stderr, result };
}

async function main() {
  // Сторож: если что-то держит процесс, прогон не должен висеть вечно.
  const watchdog = setTimeout(() => {
    console.error('FAIL  прогон не уложился в 120 с');
    process.exit(1);
  }, 120000);
  watchdog.unref();

  console.log(`Пояс процесса: ${processZone}${isChild ? ' (дочерний)' : ''}`);
  await runTests();
  clearTimeout(watchdog);
  reported = true;

  const own = counts();
  const ownResult = { tz: processZone, ...own, digest: sweepDigest, sweep: sweepCount };
  if (isChild) {
    console.log(`RESULT ${JSON.stringify(ownResult)}`);
    if (own.failed) process.exitCode = 1;
    return;
  }

  const rows = [{ ...ownResult, ok: own.failed === 0 }];
  for (const zone of CHILD_ZONES) {
    const child = runChild(zone);
    const ok = child.status === 0 && child.result && child.result.failed === 0;
    if (!ok) {
      console.error(`\n── Дочерний процесс TZ=${zone}: код ${child.status} ──`);
      if (child.error) console.error(child.error);
      console.error(String(child.stdout || '').trim());
      console.error(String(child.stderr || '').trim());
    }
    rows.push({
      ...(child.result || { tz: zone, passed: 0, failed: 0, total: 0, digest: null, sweep: 0 }),
      requested: zone,
      ok: Boolean(ok),
    });
  }

  console.log('\nПояс процесса        Проверок   Итог   Отпечаток');
  for (const row of rows) {
    const name = String(row.requested && row.tz !== row.requested ? `${row.requested}?` : row.tz).padEnd(20);
    const score = `${row.passed}/${row.total}`.padEnd(10);
    console.log(`${name} ${score} ${row.ok ? 'ok    ' : 'FAIL  '} ${row.digest ? row.digest.slice(0, 16) : '—'}`);
  }

  const digests = new Set(rows.map((row) => row.digest));
  const same = digests.size === 1 && !digests.has(null);
  if (same) {
    console.log(`\nОтпечатки совпали (${rows[0].sweep} расчётов в каждом поясе процесса): результат с поясом профиля не зависит от TZ.`);
  } else {
    console.error('\nFAIL  отпечатки разошлись: результат зависит от пояса процесса');
  }

  const allOk = rows.every((row) => row.ok) && same;
  console.log(allOk ? '\nВсе проверки прошли' : '\nЕсть ошибки');
  if (!allOk) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
