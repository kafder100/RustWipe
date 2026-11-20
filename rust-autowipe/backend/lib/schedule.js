/**
 * Расписание вайпов без внешних зависимостей.
 *
 * Хранится как описание (kind + поля), а не как cron-строка: так проще
 * показать его человеку и не тащить парсер cron в плагин.
 *
 * Время трактуется в часовом поясе профиля (schedule.timeZone, имя IANA).
 * Пояс не задан — в часовом поясе процесса панели (TZ контейнера backend),
 * как до появления поясов у профиля: расчёт идёт через локальные методы Date.
 * С поясом расчёт идёт через zoned-time.js и от TZ процесса не зависит.
 *
 * Перевод часов:
 *  - с поясом профиля несуществующее время (весной) переносится на момент
 *    перевода (02:30 → 03:00), из двойного (осенью) берётся первое;
 *  - без пояса — правила Date: несуществующее 02:30 → 03:30, из двойного — первое.
 */

import {
  resolveTimeZone,
  timeZonesSupported,
  zonedParts,
  zonedTimeToDate,
} from './zoned-time.js';

export const WEEKDAY_NAMES = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
];

export const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const NTH_LABELS = {
  '1': 'первый',
  '2': 'второй',
  '3': 'третий',
  '4': 'четвёртый',
  '-1': 'последний',
};

export const SCHEDULE_KINDS = [
  'weekly',
  'monthly_nth_weekday',
  'monthly_day',
  'interval',
];

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, '0');
}

/** "5:00", "05:00" → { h, m } либо null. */
export function parseTime(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { h: Number(match[1]), m: Number(match[2]) };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Дата момента «ГГГГ-ММ-ДД» в поясе timeZone; пусто — в поясе панели. */
function dateText(moment, timeZone) {
  const parts = timeZone
    ? zonedParts(moment, timeZone)
    : { year: moment.getFullYear(), month: moment.getMonth() + 1, day: moment.getDate() };
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * Приводит произвольный ввод к валидному описанию расписания.
 * @param {object} input расписание из запроса или из профиля
 * @param {{anchorFrom?: Date|string|number}} [options] anchorFrom — момент, дата
 *   которого станет точкой отсчёта интервала без неё; по умолчанию — сейчас
 */
export function normalizeSchedule(input, { anchorFrom } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const time = parseTime(source.time) ? String(source.time).trim() : '05:00';
  const parsedTime = parseTime(time);
  const normalizedTime = `${pad(parsedTime.h)}:${pad(parsedTime.m)}`;
  const kind = SCHEDULE_KINDS.includes(source.kind) ? source.kind : 'weekly';

  const schedule = {
    kind,
    time: normalizedTime,
    // Пусто — пояс панели. Неизвестный пояс отбрасывается, как и прочий мусор;
    // при сохранении профиля его раньше отсекает validateScheduleInput.
    timeZone: resolveTimeZone(source.timeZone) || '',
    weekday: clampInt(source.weekday, 0, 6, 4),
    nth: [1, 2, 3, 4, -1].includes(Number(source.nth)) ? Number(source.nth) : 1,
    day: clampInt(source.day, 1, 31, 1),
    intervalDays: clampInt(source.intervalDays, 1, 365, 7),
  };

  if (kind === 'interval') {
    // Без точки отсчёта серия начиналась бы заново от каждой правки профиля и
    // от каждого прогона. Поэтому запоминаем первую дату: сегодня в поясе
    // профиля (или дату anchorFrom). Дальше она хранится в профиле.
    let anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(source.anchorDate ?? ''))
      ? String(source.anchorDate)
      : null;
    if (!anchor) {
      const from = anchorFrom === undefined || anchorFrom === null ? new Date() : new Date(anchorFrom);
      anchor = dateText(Number.isNaN(from.getTime()) ? new Date() : from, schedule.timeZone);
    }
    schedule.anchorDate = anchor;
  }

  return schedule;
}

/** undefined и null — поле не задано: тогда берётся значение по умолчанию. */
function given(value) {
  return value !== undefined && value !== null;
}

/** Целое число (или строка из цифр) от min до max; иначе null. */
function strictInt(value, min, max) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** Значение для текста ошибки: коротко, чтобы мусор не попал в ответ целиком. */
function shown(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.trim().slice(0, 64);
}

/** «2026-11-01» — настоящая дата; «2026-02-30» и «2026-13-01» — нет. */
function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month - 1);
}

/** Пояс с опечаткой нельзя заменить поясом панели: вайп пройдёт не в то время. */
function timeZoneErrors(raw) {
  if (!given(raw)) return [];
  if (typeof raw === 'string' && !raw.trim()) return [];
  if (resolveTimeZone(raw)) return [];
  if (!timeZonesSupported()) {
    return ['Расписание: Node панели не знает часовых поясов. Выберите «Пояс панели»'];
  }
  return [`Расписание: неизвестный часовой пояс «${String(raw).trim().slice(0, 64)}». Укажите пояс вида Europe/Moscow`];
}

/**
 * Ошибки расписания, которые нельзя молча исправить: неизвестный вид, время не
 * в виде ЧЧ:ММ, число вне диапазона, несуществующая дата, неизвестный пояс.
 * Подставить «похожее» значение — значит провести вайп не в то время.
 * Поле не задано (undefined или null) — не ошибка, берётся значение по умолчанию.
 * Поля, которые этому виду расписания не нужны, не проверяются.
 * @returns {string[]} пустой массив — всё в порядке
 */
export function validateScheduleInput(input) {
  if (!given(input)) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    return ['Расписание: неверный формат. Нужен объект с полями kind и time'];
  }
  const errors = [];
  const kind = given(input.kind) ? input.kind : 'weekly';
  if (!SCHEDULE_KINDS.includes(kind)) {
    errors.push(`Расписание: неизвестный вид «${shown(kind)}». Нужен один из: ${SCHEDULE_KINDS.join(', ')}`);
  }
  if (given(input.time) && (typeof input.time !== 'string' || !parseTime(input.time))) {
    errors.push(`Расписание: время «${shown(input.time)}» не подходит. Нужно ЧЧ:ММ, например 05:00`);
  }
  if ((kind === 'weekly' || kind === 'monthly_nth_weekday') && given(input.weekday) && strictInt(input.weekday, 0, 6) === null) {
    errors.push(`Расписание: день недели «${shown(input.weekday)}» не подходит. Нужно число от 0 (воскресенье) до 6 (суббота)`);
  }
  if (kind === 'monthly_nth_weekday' && given(input.nth) && ![1, 2, 3, 4, -1].includes(strictInt(input.nth, -1, 4))) {
    errors.push(`Расписание: неделя месяца «${shown(input.nth)}» не подходит. Нужно 1, 2, 3, 4 или -1 (последняя)`);
  }
  if (kind === 'monthly_day' && given(input.day) && strictInt(input.day, 1, 31) === null) {
    errors.push(`Расписание: число месяца «${shown(input.day)}» не подходит. Нужно от 1 до 31`);
  }
  if (kind === 'interval') {
    if (given(input.intervalDays) && strictInt(input.intervalDays, 1, 365) === null) {
      errors.push(`Расписание: интервал «${shown(input.intervalDays)}» не подходит. Нужно целое число дней от 1 до 365`);
    }
    if (given(input.anchorDate) && input.anchorDate !== '' && !isCalendarDate(input.anchorDate)) {
      errors.push(`Расписание: точка отсчёта «${shown(input.anchorDate)}» не подходит. Нужна дата ГГГГ-ММ-ДД, например 2026-11-01`);
    }
  }
  errors.push(...timeZoneErrors(input.timeZone));
  return errors;
}

function atTime(year, month, day, h, m) {
  return new Date(year, month, day, h, m, 0, 0);
}

/** Номер дня от 1970-01-01. Месяц 0–11; переполнение нормализуется, как у Date. */
function dayNumber(year, month, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return Math.floor(date.getTime() / DAY_MS);
}

/** Календарь не зависит от пояса: считаем его в UTC. */
function dateOfDay(number) {
  const date = new Date(number * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function daysInMonth(year, month) {
  return dateOfDay(dayNumber(year, month + 1, 0)).day;
}

/**
 * Часы процесса панели — прежнее поведение, когда у профиля нет пояса.
 * today — календарная дата момента, at — момент для даты и времени.
 */
const LOCAL_CLOCK = {
  today(after) {
    return {
      year: after.getFullYear(),
      month: after.getMonth(),
      day: after.getDate(),
      weekday: after.getDay(),
    };
  },
  at: atTime,
};

/** Часы пояса профиля: «сегодня» и моменты считаются в этом поясе. */
function zonedClock(timeZone) {
  return {
    today(after) {
      const parts = zonedParts(after, timeZone);
      return { year: parts.year, month: parts.month - 1, day: parts.day, weekday: parts.weekday };
    },
    at(year, month, day, h, m) {
      return zonedTimeToDate({ year, month: month + 1, day, hour: h, minute: m }, timeZone);
    },
  };
}

function nextWeekly(schedule, after, clock) {
  const { h, m } = parseTime(schedule.time);
  const today = clock.today(after);
  let delta = (schedule.weekday - today.weekday + 7) % 7;
  if (delta === 0 && clock.at(today.year, today.month, today.day, h, m).getTime() <= after.getTime()) {
    delta = 7;
  }
  return clock.at(today.year, today.month, today.day + delta, h, m);
}

function nthWeekdayDate(year, month, weekday, nth) {
  const total = daysInMonth(year, month);
  if (nth === -1) {
    const last = dateOfDay(dayNumber(year, month, total));
    const diff = (last.weekday - weekday + 7) % 7;
    return total - diff;
  }
  const first = dateOfDay(dayNumber(year, month, 1));
  const diff = (weekday - first.weekday + 7) % 7;
  const day = 1 + diff + (nth - 1) * 7;
  return day > total ? null : day;
}

function nextMonthlyNthWeekday(schedule, after, clock) {
  const { h, m } = parseTime(schedule.time);
  const today = clock.today(after);
  const baseYear = today.year;
  const baseMonth = today.month;
  // 24 месяца вперёд — с запасом: пятый понедельник существует не каждый месяц.
  for (let offset = 0; offset <= 24; offset += 1) {
    const year = baseYear + Math.floor((baseMonth + offset) / 12);
    const month = (baseMonth + offset) % 12;
    const day = nthWeekdayDate(year, month, schedule.weekday, schedule.nth);
    if (day == null) continue;
    const candidate = clock.at(year, month, day, h, m);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return clock.at(baseYear, baseMonth + 1, 1, h, m);
}

function nextMonthlyDay(schedule, after, clock) {
  const { h, m } = parseTime(schedule.time);
  const today = clock.today(after);
  const baseYear = today.year;
  const baseMonth = today.month;
  for (let offset = 0; offset <= 24; offset += 1) {
    const year = baseYear + Math.floor((baseMonth + offset) / 12);
    const month = (baseMonth + offset) % 12;
    const day = Math.min(schedule.day, daysInMonth(year, month));
    const candidate = clock.at(year, month, day, h, m);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  return clock.at(baseYear, baseMonth + 1, 1, h, m);
}

function nextInterval(schedule, after) {
  const { h, m } = parseTime(schedule.time);
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

  // Дни серии считаем от первого дня, а не от прошлого запуска. Если время
  // попало в перевод часов через полночь (Гренландия: сб 23:00 → вс 00:00),
  // Date переносит запуск на следующий день — от него серия съехала бы навсегда.
  let candidate = atTime(year, month, day, h, m);
  let guard = 0;
  while (candidate.getTime() <= after.getTime() && guard < 5000) {
    guard += 1;
    candidate = atTime(year, month, day + guard * step, h, m);
  }
  if (candidate.getTime() <= after.getTime()) {
    candidate = atTime(after.getFullYear(), after.getMonth(), after.getDate() + step, h, m);
  }
  return candidate;
}

/**
 * Интервал в поясе профиля. Дата-якорь — дата в этом поясе; без якоря отсчёт
 * идёт от «сегодня» в поясе. Дни считаются по календарю, а не по моментам,
 * поэтому перевод часов не сдвигает цикл, а до текущего дня цикла прыгаем сразу.
 */
function nextIntervalZoned(schedule, after, clock) {
  const { h, m } = parseTime(schedule.time);
  const step = Math.max(1, Number(schedule.intervalDays) || 7);
  const today = clock.today(after);
  const todayNumber = dayNumber(today.year, today.month, today.day);
  let number = todayNumber;

  const [ay, am, ad] = String(schedule.anchorDate || '').split('-').map(Number);
  if (schedule.anchorDate && Number.isFinite(ay) && Number.isFinite(am) && Number.isFinite(ad)) {
    const anchorNumber = dayNumber(ay, am - 1, ad);
    number =
      anchorNumber >= todayNumber
        ? anchorNumber
        : anchorNumber + Math.floor((todayNumber - anchorNumber) / step) * step;
  }

  const at = (n) => {
    const date = dateOfDay(n);
    return clock.at(date.year, date.month, date.day, h, m);
  };
  let candidate = at(number);
  // Обычно хватает одного шага: день цикла сегодня или раньше, а время уже прошло.
  for (let guard = 0; candidate.getTime() <= after.getTime() && guard < 1000; guard += 1) {
    number += step;
    candidate = at(number);
  }
  return candidate;
}

/**
 * Ближайший запуск строго после `after`.
 * @param {object} schedule нормализованное расписание
 * @param {Date} after
 * @param {string} [timeZone] пояс IANA; по умолчанию — schedule.timeZone;
 *   пусто — пояс процесса панели (прежнее поведение)
 * @returns {Date}
 */
export function nextOccurrence(schedule, after = new Date(), timeZone = schedule?.timeZone) {
  const wanted = typeof timeZone === 'string' ? timeZone.trim() : timeZone;
  const zone = wanted ? resolveTimeZone(wanted) : null;
  if (wanted && !zone) throw new RangeError(`Неизвестный часовой пояс: ${String(wanted)}`);
  const clock = zone ? zonedClock(zone) : LOCAL_CLOCK;
  switch (schedule.kind) {
    case 'monthly_nth_weekday':
      return nextMonthlyNthWeekday(schedule, after, clock);
    case 'monthly_day':
      return nextMonthlyDay(schedule, after, clock);
    case 'interval':
      return zone ? nextIntervalZoned(schedule, after, clock) : nextInterval(schedule, after);
    case 'weekly':
    default:
      return nextWeekly(schedule, after, clock);
  }
}

/** «05:00» или «05:00 (Europe/Moscow)», если у расписания свой пояс. */
function timeWithZone(time, timeZone) {
  return typeof timeZone === 'string' && timeZone ? `${time} (${timeZone})` : time;
}

/** Человеческое описание расписания для UI и логов. */
export function describeSchedule(schedule) {
  if (!schedule) return '—';
  const time = timeWithZone(schedule.time || '05:00', schedule.timeZone);
  switch (schedule.kind) {
    case 'monthly_nth_weekday': {
      const nth = NTH_LABELS[String(schedule.nth)] || 'первый';
      return `Ежемесячно: ${nth} ${WEEKDAY_NAMES[schedule.weekday]}, ${time}`;
    }
    case 'monthly_day':
      return `Ежемесячно: ${schedule.day}-е число, ${time}`;
    case 'interval':
      return `Каждые ${schedule.intervalDays} дн., ${time}`;
    case 'weekly':
    default:
      return `Еженедельно: ${WEEKDAY_NAMES[schedule.weekday]}, ${time}`;
  }
}

/** Короткая версия для таблиц. */
export function describeScheduleShort(schedule) {
  if (!schedule) return '—';
  const time = timeWithZone(schedule.time, schedule.timeZone);
  switch (schedule.kind) {
    case 'monthly_nth_weekday':
      return `${NTH_LABELS[String(schedule.nth)] || 'первый'} ${WEEKDAY_SHORT[schedule.weekday]}, ${time}`;
    case 'monthly_day':
      return `${schedule.day}-е число, ${time}`;
    case 'interval':
      return `каждые ${schedule.intervalDays} дн., ${time}`;
    case 'weekly':
    default:
      return `${WEEKDAY_SHORT[schedule.weekday]}, ${time}`;
  }
}
