/**
 * Расписание вайпов без внешних зависимостей.
 *
 * Хранится как описание (kind + поля), а не как cron-строка: так проще
 * показать его человеку и не тащить парсер cron в плагин.
 *
 * Время трактуется в часовом поясе процесса панели (TZ контейнера backend).
 * Все расчёты идут через локальные методы Date, поэтому перевод часов
 * учитывается автоматически.
 */

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

/** Приводит произвольный ввод к валидному описанию расписания. */
export function normalizeSchedule(input) {
  const source = input && typeof input === 'object' ? input : {};
  const time = parseTime(source.time) ? source.time.trim() : '05:00';
  const parsedTime = parseTime(time);
  const normalizedTime = `${pad(parsedTime.h)}:${pad(parsedTime.m)}`;
  const kind = SCHEDULE_KINDS.includes(source.kind) ? source.kind : 'weekly';

  const schedule = {
    kind,
    time: normalizedTime,
    weekday: clampInt(source.weekday, 0, 6, 4),
    nth: [1, 2, 3, 4, -1].includes(Number(source.nth)) ? Number(source.nth) : 1,
    day: clampInt(source.day, 1, 31, 1),
    intervalDays: clampInt(source.intervalDays, 1, 365, 7),
  };

  if (kind === 'interval') {
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(source.anchorDate ?? ''))
      ? String(source.anchorDate)
      : null;
    schedule.anchorDate = anchor;
  }

  return schedule;
}

function atTime(year, month, day, h, m) {
  return new Date(year, month, day, h, m, 0, 0);
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function nextWeekly(schedule, after) {
  const { h, m } = parseTime(schedule.time);
  const weekday = schedule.weekday;
  const candidate = atTime(after.getFullYear(), after.getMonth(), after.getDate(), h, m);
  let delta = (weekday - after.getDay() + 7) % 7;
  if (delta === 0 && candidate.getTime() <= after.getTime()) delta = 7;
  return atTime(
    after.getFullYear(),
    after.getMonth(),
    after.getDate() + delta,
    h,
    m,
  );
}

function nthWeekdayDate(year, month, weekday, nth) {
  const total = daysInMonth(year, month);
  if (nth === -1) {
    const last = new Date(year, month, total);
    const diff = (last.getDay() - weekday + 7) % 7;
    return total - diff;
  }
  const first = new Date(year, month, 1);
  const diff = (weekday - first.getDay() + 7) % 7;
  const day = 1 + diff + (nth - 1) * 7;
  return day > total ? null : day;
}

function nextMonthlyNthWeekday(schedule, after) {
  const { h, m } = parseTime(schedule.time);
  const baseYear = after.getFullYear();
  const baseMonth = after.getMonth();
  // 24 месяца вперёд — с запасом: пятый понедельник существует не каждый месяц.
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
  const { h, m } = parseTime(schedule.time);
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

/**
 * Ближайший запуск строго после `after`.
 * @param {object} schedule нормализованное расписание
 * @param {Date} after
 * @returns {Date}
 */
export function nextOccurrence(schedule, after = new Date()) {
  switch (schedule.kind) {
    case 'monthly_nth_weekday':
      return nextMonthlyNthWeekday(schedule, after);
    case 'monthly_day':
      return nextMonthlyDay(schedule, after);
    case 'interval':
      return nextInterval(schedule, after);
    case 'weekly':
    default:
      return nextWeekly(schedule, after);
  }
}

/** Человеческое описание расписания для UI и логов. */
export function describeSchedule(schedule) {
  if (!schedule) return '—';
  const time = schedule.time || '05:00';
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
  switch (schedule.kind) {
    case 'monthly_nth_weekday':
      return `${NTH_LABELS[String(schedule.nth)] || 'первый'} ${WEEKDAY_SHORT[schedule.weekday]}, ${schedule.time}`;
    case 'monthly_day':
      return `${schedule.day}-е число, ${schedule.time}`;
    case 'interval':
      return `каждые ${schedule.intervalDays} дн., ${schedule.time}`;
    case 'weekly':
    default:
      return `${WEEKDAY_SHORT[schedule.weekday]}, ${schedule.time}`;
  }
}
