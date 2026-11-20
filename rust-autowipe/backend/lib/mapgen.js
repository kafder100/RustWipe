/**
 * Сид и размер карты Rust: нормализация настроек профиля и выбор значений
 * перед вайпом. Сама карта генерируется игрой — плагин лишь записывает
 * значения в переменные шаблона (WORLD_SEED / WORLD_SIZE).
 */

import crypto from 'node:crypto';

export const SEED_MIN = 1;
export const SEED_MAX = 2147483647;
export const SIZE_MIN = 1000;
export const SIZE_MAX = 6000;
export const DEFAULT_MAP_SIZE = 3000;
export const DEFAULT_SEED_VAR = 'WORLD_SEED';
export const DEFAULT_SIZE_VAR = 'WORLD_SIZE';

export const SEED_MODES = ['keep', 'random', 'fixed', 'rotate'];
export const SIZE_MODES = ['keep', 'fixed', 'random'];
export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Плагин пишет только сид и размер карты (ответ владельца №18). Имя переменной
 * сида должно содержать SEED, размера — SIZE: так их ищет и кнопка «Определить
 * из шаблона». Иначе вайп ключом панели записал бы число в пароль RCON или порт.
 */
export const SEED_VAR_RE = /SEED/i;
export const SIZE_VAR_RE = /SIZE/i;

/** Имя переменной, если оно допустимо для этой роли, иначе имя по умолчанию. */
function pickVariable(value, fallback, roleRe) {
  const name = String(value ?? '').trim();
  return name && VARIABLE_NAME_RE.test(name) && roleRe.test(name) ? name : fallback;
}

const MAX_LIST = 64;

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export function isValidSeed(value) {
  const n = toInt(value);
  return n !== null && n >= SEED_MIN && n <= SEED_MAX;
}

export function isValidSize(value) {
  const n = toInt(value);
  return n !== null && n >= SIZE_MIN && n <= SIZE_MAX;
}

function uniqueInts(values, validator) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const n = toInt(raw);
    if (n === null || !validator(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

export function randomSeed() {
  return crypto.randomInt(SEED_MIN, SEED_MAX + 1);
}

function pickRandom(values, fallback) {
  const pool = Array.isArray(values) && values.length ? values : [fallback];
  return pool[crypto.randomInt(0, pool.length)];
}

/** Проверка сырого ввода из API до нормализации (сообщения для UI). */
export function validateMapInput(input) {
  const errors = [];
  // Поля нет — карта не меняется (или как у старого профиля). Но строка,
  // число или список вместо настроек — ошибка: иначе «keep» строкой молча
  // превращался в случайный сид и размер 3000.
  if (input === undefined || input === null) return errors;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return ['Карта: нужны настройки сида и размера (объект с полями seed и size), а не строка или число'];
  }

  const seed = input.seed && typeof input.seed === 'object' ? input.seed : {};
  const size = input.size && typeof input.size === 'object' ? input.size : {};
  const vars = input.vars && typeof input.vars === 'object' ? input.vars : {};

  if (!SEED_MODES.includes(seed.mode)) {
    errors.push('Карта: неизвестный режим сида');
  }
  if (seed.mode === 'fixed' && !isValidSeed(seed.value)) {
    errors.push(`Карта: фиксированный сид должен быть целым от ${SEED_MIN} до ${SEED_MAX}`);
  }
  if (seed.mode === 'rotate' && uniqueInts(seed.values, isValidSeed).length === 0) {
    errors.push('Карта: для ротации добавьте хотя бы один сид из диапазона 1…2147483647');
  }

  if (!SIZE_MODES.includes(size.mode)) {
    errors.push('Карта: неизвестный режим размера');
  }
  if (size.mode === 'fixed' && !isValidSize(size.value)) {
    errors.push(`Карта: размер должен быть целым от ${SIZE_MIN} до ${SIZE_MAX}`);
  }
  if (size.mode === 'random' && uniqueInts(size.values, isValidSize).length === 0) {
    errors.push('Карта: для случайного размера добавьте хотя бы одно значение 1000…6000');
  }

  for (const key of ['seed', 'size']) {
    const value = vars[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    const name = String(value).trim();
    if (!VARIABLE_NAME_RE.test(name)) {
      errors.push(`Карта: имя переменной ${key === 'seed' ? 'сида' : 'размера'} — латиница, цифры и _, начиная с буквы`);
    } else if (key === 'seed' && !SEED_VAR_RE.test(name)) {
      errors.push(`Карта: переменная сида ${name} — в имени должно быть SEED (например ${DEFAULT_SEED_VAR}). Другие переменные шаблона плагин не меняет`);
    } else if (key === 'size' && !SIZE_VAR_RE.test(name)) {
      errors.push(`Карта: переменная размера ${name} — в имени должно быть SIZE (например ${DEFAULT_SIZE_VAR}). Другие переменные шаблона плагин не меняет`);
    }
  }
  const seedName = String(vars.seed ?? '').trim();
  if (seedName && seedName === String(vars.size ?? '').trim()) {
    errors.push('Карта: сид и размер не могут писаться в одну переменную');
  }

  return errors;
}

/**
 * Приводит произвольный ввод к валидной структуре настроек карты.
 *
 * legacy=true (у профиля нет поля map) сохраняет прежнее поведение — «не
 * трогать карту», чтобы обновление плагина не меняло сид существующим серверам.
 * Новые профили из UI присылают готовую структуру (random + 3000).
 */
export function normalizeMapSettings(input, { legacy = false } = {}) {
  if (!input || typeof input !== 'object') {
    if (legacy) {
      return {
        seed: { mode: 'keep', value: null, values: [] },
        size: { mode: 'keep', value: null, values: [] },
        vars: { seed: DEFAULT_SEED_VAR, size: DEFAULT_SIZE_VAR },
      };
    }
    return {
      seed: { mode: 'random', value: null, values: [] },
      size: { mode: 'fixed', value: DEFAULT_MAP_SIZE, values: [2000, 3000, 4000, 5000, 6000] },
      vars: { seed: DEFAULT_SEED_VAR, size: DEFAULT_SIZE_VAR },
    };
  }

  const seedSource = input.seed && typeof input.seed === 'object' ? input.seed : {};
  const sizeSource = input.size && typeof input.size === 'object' ? input.size : {};
  const varsSource = input.vars && typeof input.vars === 'object' ? input.vars : {};

  const seedMode = SEED_MODES.includes(seedSource.mode) ? seedSource.mode : 'keep';
  const sizeMode = SIZE_MODES.includes(sizeSource.mode) ? sizeSource.mode : 'keep';

  const seedValue = toInt(seedSource.value);
  const sizeValue = toInt(sizeSource.value);

  // Профиль, сохранённый до этой проверки, мог указать любую переменную
  // шаблона. Такую плагин не пишет: вместо неё — имя по умолчанию.
  let seedVar = pickVariable(varsSource.seed, DEFAULT_SEED_VAR, SEED_VAR_RE);
  let sizeVar = pickVariable(varsSource.size, DEFAULT_SIZE_VAR, SIZE_VAR_RE);
  if (seedVar === sizeVar) {
    seedVar = DEFAULT_SEED_VAR;
    sizeVar = DEFAULT_SIZE_VAR;
  }

  return {
    seed: {
      mode: seedMode,
      value: isValidSeed(seedValue) ? seedValue : null,
      values: uniqueInts(seedSource.values, isValidSeed),
    },
    size: {
      mode: sizeMode,
      value: isValidSize(sizeValue) ? sizeValue : null,
      values: uniqueInts(sizeSource.values, isValidSize),
    },
    vars: { seed: seedVar, size: sizeVar },
  };
}

/**
 * Выбирает значения для ближайшего вайпа. null = значение не меняем.
 *
 * @param {object} map нормализованные настройки
 * @param {{seedCursor?: number}} state сохранённое состояние профиля
 */
export function decideMapValues(map, state = {}) {
  const settings = normalizeMapSettings(map);
  let seed = null;
  let nextCursor = Number.isInteger(state?.seedCursor) ? state.seedCursor : 0;

  if (settings.seed.mode === 'fixed' && isValidSeed(settings.seed.value)) {
    seed = settings.seed.value;
  } else if (settings.seed.mode === 'random') {
    seed = randomSeed();
  } else if (settings.seed.mode === 'rotate') {
    if (settings.seed.values.length) {
      const index = ((nextCursor % settings.seed.values.length) + settings.seed.values.length) % settings.seed.values.length;
      seed = settings.seed.values[index];
      nextCursor = (index + 1) % settings.seed.values.length;
    } else {
      seed = randomSeed();
    }
  }

  let size = null;
  if (settings.size.mode === 'fixed' && isValidSize(settings.size.value)) {
    size = settings.size.value;
  } else if (settings.size.mode === 'random') {
    size = pickRandom(settings.size.values, DEFAULT_MAP_SIZE);
  }

  return { seed, size, nextCursor };
}

/**
 * Человеческое описание для карточки профиля. Нет настроек (профиль до
 * 1.2.0) — вайп карту не трогает, и описание говорит то же.
 */
export function describeMap(map) {
  const settings = normalizeMapSettings(map, { legacy: !map });
  const seedText =
    settings.seed.mode === 'keep'
      ? 'сид не меняется'
      : settings.seed.mode === 'random'
        ? 'сид случайный при вайпе'
        : settings.seed.mode === 'fixed'
          ? `сид ${settings.seed.value ?? '—'}`
          : `сид по списку (${settings.seed.values.length} шт.)`;
  const sizeText =
    settings.size.mode === 'keep'
      ? 'размер не меняется'
      : settings.size.mode === 'fixed'
        ? `размер ${settings.size.value ?? '—'}`
        : `размер случайный (${settings.size.values.length || 1} вар.)`;
  return `${seedText} · ${sizeText}`;
}
