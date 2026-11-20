/**
 * Часовые пояса IANA без зависимостей: только Intl.
 *
 * Модуль переводит «стенные часы» в поясе (дата и время на часах в Москве,
 * Берлине, Сиднее) в момент времени и обратно. Пояс процесса панели здесь не
 * участвует: результат одинаков при любом TZ контейнера backend.
 *
 * Переход на летнее время:
 *  - несуществующее время (весной часы прыгают вперёд) → первое существующее
 *    время после разрыва, то есть момент перевода часов (02:30 → 03:00);
 *  - двойное время (осенью часы идут назад) → первое из двух.
 */

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

// Имя IANA: «UTC», «Europe/Moscow», «America/Argentina/Buenos_Aires», «Etc/GMT+3».
// Смещения вида «+03:00» Intl тоже принимает, но это не имя пояса — их не берём.
const NAME_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_NAME_LENGTH = 64;

// Форматтеры дорогие: кэшируем по имени пояса, с потолком на случай мусора.
const MAX_FORMATTERS = 64;
const formatters = new Map();

let support = null;

/** Есть ли в этой сборке Node часовые пояса (Intl с данными ICU). */
export function timeZonesSupported() {
  if (support === null) {
    try {
      support =
        typeof Intl === 'object' &&
        typeof Intl.DateTimeFormat === 'function' &&
        new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo' }).resolvedOptions().timeZone ===
          'Asia/Tokyo';
    } catch {
      support = false;
    }
  }
  return support;
}

/**
 * Имя пояса IANA в правильном регистре или null, если пояс неизвестен.
 * Пустая строка тоже null: «пояс не задан» решает вызывающий.
 */
export function resolveTimeZone(name) {
  if (typeof name !== 'string') return null;
  const value = name.trim();
  if (!value || value.length > MAX_NAME_LENGTH || !NAME_RE.test(value)) return null;
  if (!timeZonesSupported()) return null;
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  // Intl может вернуть другое имя того же пояса (Asia/Kolkata → Asia/Calcutta).
  // Берём его, только если это то же имя в другом регистре, иначе — выбор админа.
  if (typeof resolved === 'string' && resolved.toLowerCase() === value.toLowerCase()) {
    return resolved;
  }
  return value;
}

export function isValidTimeZone(name) {
  return resolveTimeZone(name) !== null;
}

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (formatter) return formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    throw new RangeError(`Неизвестный часовой пояс: ${String(timeZone)}`);
  }
  if (formatters.size >= MAX_FORMATTERS) formatters.clear();
  formatters.set(timeZone, formatter);
  return formatter;
}

function toTime(date) {
  const time = date instanceof Date ? date.getTime() : Number(date);
  if (!Number.isFinite(time)) throw new RangeError('Некорректная дата');
  return time;
}

/** Стенные часы как число мс «будто в UTC». Месяц 1–12, переполнение нормализуется. */
function wallTime(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  // setUTCFullYear, а не Date.UTC: тот превращает годы 0–99 в 1900–1999.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/**
 * Стенные часы в поясе для момента времени.
 * @param {Date|number} date момент
 * @param {string} timeZone имя пояса IANA
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number}}
 *   месяц 1–12, день недели 0–6 (0 — воскресенье)
 */
export function zonedParts(date, timeZone) {
  const time = toTime(date);
  const values = {};
  let beforeEra = false;
  for (const part of formatterFor(timeZone).formatToParts(new Date(time))) {
    if (part.type === 'era') beforeEra = /^b/i.test(part.value);
    else if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const { year, month, day, minute, second } = values;
  // Старые движки с hour12: false писали полночь как 24.
  const hour = values.hour === 24 ? 0 : values.hour;
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    throw new Error(`Intl не отдал дату в поясе ${timeZone}`);
  }
  const fullYear = beforeEra ? 1 - year : year;
  const weekday = new Date(wallTime(fullYear, month, day)).getUTCDay();
  return { year: fullYear, month, day, hour, minute, second, weekday };
}

/** Смещение пояса в момент `time`, мс: стенные часы минус UTC. */
function offsetAt(time, timeZone) {
  // Intl отдаёт время с точностью до секунды — миллисекунды отбрасываем.
  const whole = Math.floor(time / SECOND_MS) * SECOND_MS;
  const p = zonedParts(whole, timeZone);
  return wallTime(p.year, p.month, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * Момент времени для стенных часов в поясе.
 * Несуществующее время → момент перевода часов; двойное → первое из двух.
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number, second?: number}} wall
 *   месяц 1–12; переполнение дня и часа нормализуется, как у Date
 * @param {string} timeZone имя пояса IANA
 * @returns {Date}
 */
export function zonedTimeToDate(wall, timeZone) {
  const local = wallTime(wall.year, wall.month, wall.day, wall.hour ?? 0, wall.minute ?? 0, wall.second ?? 0);
  if (!Number.isFinite(local)) throw new RangeError('Некорректные дата или время');

  // Смещения до, во время и после: перевод часов бывает не чаще раза в сутки,
  // поэтому три пробы покрывают и обычный день, и день перехода.
  const offsets = new Set([
    offsetAt(local - DAY_MS, timeZone),
    offsetAt(local, timeZone),
    offsetAt(local + DAY_MS, timeZone),
  ]);
  const matches = [...offsets]
    .map((offset) => local - offset)
    .filter((time) => offsetAt(time, timeZone) === local - time)
    .sort((a, b) => a - b);
  if (matches.length) return new Date(matches[0]);

  // Таких часов нет (весенний разрыв). Ищем момент перевода: до него действует
  // старое смещение, после — новое. Бинарный поиск с точностью до секунды.
  const before = offsetAt(local - DAY_MS, timeZone);
  const after = offsetAt(local + DAY_MS, timeZone);
  let lo = local - Math.max(before, after);
  let hi = local - Math.min(before, after);
  const loOffset = offsetAt(lo, timeZone);
  if (offsetAt(hi, timeZone) === loOffset) return new Date(hi);
  while (hi - lo > SECOND_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * SECOND_MS)) * SECOND_MS;
    if (offsetAt(mid, timeZone) === loOffset) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}
