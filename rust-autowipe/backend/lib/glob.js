/**
 * Разбор путей и glob-шаблонов для вайпа.
 *
 * Поддерживается:
 *   *   — любое количество символов внутри сегмента
 *   ?   — один символ внутри сегмента
 *   **  — весь сегмент целиком: ноль или более каталогов
 *   [*], [?], [[] — сама звёздочка, сам вопрос, сама открывающая скобка.
 *         Только эти три записи. Так в пути пишут имя, где есть «*», «?»
 *         или «[» (так пишет пути и выбор в файлах). Например, файл «*.json» —
 *         это путь «/oxide/data/[*].json».
 *   Любые другие квадратные скобки — обычные символы, как в 1.5.6:
 *         «Kits[1].json», «[backup]», «a[b]c», «[.]» значат ровно то, что
 *         написано. Поэтому старые профили не меняют смысла.
 *   Обратный слэш для этого не годится: панель и плагин превращают «\» в «/».
 *
 * Сегмент, где после такой замены не осталось «*» и «?», — точное имя.
 *
 * Имя сравнивается с шаблоном без RegExp: шагов не больше, чем «длина
 * шаблона × длина имени». Поэтому даже маска из сотен «*» не вешает панель
 * (RegExp на такой маске перебирал варианты бесконечно долго).
 *
 * Пути всегда абсолютные внутри каталога сервера: "/server/rust",
 * "/oxide/data", ... Каталог сервера — корень ("/").
 */

/** Части разобранного сегмента: «?» — один любой символ, «*» — сколько угодно символов. */
const ANY = 1;
const STAR = 2;

/** Какой символ можно написать в скобках буквально: «[*]», «[?]», «[[]». */
const ESCAPABLE = new Set(['*', '?', '[']);

/** Разбирает сегмент шаблона: обычный символ (строка), ANY или STAR. */
function parseSegment(segment) {
  const chars = Array.from(String(segment ?? ''));
  const tokens = [];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === '[' && ESCAPABLE.has(chars[i + 1]) && chars[i + 2] === ']') {
      // «[*]», «[?]», «[[]» — сам символ буквально. Другие скобки, например
      // «[1]» в «Kits[1].json», — обычные символы: ниже они идут как есть.
      tokens.push(chars[i + 1]);
      i += 2;
    } else if (char === '*') {
      // Несколько «*» подряд значат то же, что одна.
      if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
    } else if (char === '?') {
      tokens.push(ANY);
    } else {
      tokens.push(char);
    }
  }
  return tokens;
}

function splitSegments(value) {
  return String(value ?? '')
    .split('/')
    .filter(Boolean);
}

/**
 * Совпадает ли имя с разобранным сегментом. Идём по имени слева направо;
 * при несовпадении возвращаемся только к последней «*» и даём ей «съесть»
 * на один символ больше. Каждая «*» сдвигается не больше длины имени раз,
 * поэтому перебора вариантов, как у RegExp, здесь нет.
 */
function matchTokens(tokens, name) {
  const chars = Array.from(String(name ?? ''));
  let p = 0; // позиция в шаблоне
  let c = 0; // позиция в имени
  let starAt = -1; // где в шаблоне последняя «*»
  let starFrom = 0; // с какого символа имени она сейчас начинается
  while (c < chars.length) {
    const token = tokens[p];
    if (token === STAR) {
      starAt = p;
      starFrom = c;
      p += 1;
    } else if (p < tokens.length && (token === ANY || token === chars[c])) {
      p += 1;
      c += 1;
    } else if (starAt >= 0) {
      p = starAt + 1;
      starFrom += 1;
      c = starFrom;
    } else {
      return false;
    }
  }
  while (tokens[p] === STAR) p += 1;
  return p === tokens.length;
}

/** Готовые разборы сегментов: одни и те же шаблоны проверяются много раз. */
const matcherCache = new Map();

/** Есть ли в пути или сегменте настоящая маска: «*» или «?» не внутри «[*]» и «[?]». */
export function hasGlob(value) {
  return splitSegments(value).some((segment) =>
    parseSegment(segment).some((token) => token === ANY || token === STAR),
  );
}

/**
 * Точное имя для сегмента без масок: «[*].json» → «*.json».
 * Для сегмента с «*» или «?» вне скобок — null.
 */
export function literalName(segment) {
  const tokens = parseSegment(segment);
  if (tokens.some((token) => token === ANY || token === STAR)) return null;
  return tokens.join('');
}

/**
 * Точный путь для цели без масок: каждый сегмент — через literalName.
 * «/oxide/data/[*].json» → «/oxide/data/*.json». Если маска есть — null.
 */
export function literalPath(value) {
  const names = [];
  for (const segment of splitSegments(value)) {
    const name = literalName(segment);
    if (name === null) return null;
    names.push(name);
  }
  return `/${names.join('/')}`;
}

/**
 * Цель на всё содержимое корня каталога сервера: в ней нет ни одной буквы,
 * только «*», «?» и «**». Это /*, /**, а ещё /**\/*, /?*, /*?, /*\/**,
 * /*\/* и т. п. — по смыслу то же самое: снос всей установки, а не вайп.
 */
export function isRootMask(value) {
  const segments = splitSegments(value);
  return (
    segments.length > 0 &&
    segments.every((segment) => parseSegment(segment).every((token) => token === ANY || token === STAR))
  );
}

/**
 * Нормализует путь: ведущий слэш, без "..", без двойных слэшей.
 * Возвращает null, если путь пытается выйти за корень.
 */
export function normalizePath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return null;
  const stack = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    stack.push(segment);
  }
  return `/${stack.join('/')}`;
}

/**
 * Шаблон одного сегмента → проверка имени: segmentMatcher('*.sav').test(name).
 * Имя должно совпасть целиком, а не частью: «*.sav» не берёт «x.sav.bak».
 */
export function segmentMatcher(segment) {
  const key = String(segment ?? '');
  let matcher = matcherCache.get(key);
  if (!matcher) {
    const tokens = parseSegment(key);
    matcher = { test: (name) => matchTokens(tokens, name) };
    if (matcherCache.size >= 500) matcherCache.clear();
    matcherCache.set(key, matcher);
  }
  return matcher;
}

/** Совпадение полного пути с шаблоном (учитывает **). */
export function matchPath(pattern, path) {
  const patternSegments = String(pattern ?? '')
    .split('/')
    .filter(Boolean);
  const pathSegments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  if (!patternSegments.length) return false;

  const memo = new Map();
  const walk = (pi, si) => {
    const key = `${pi}:${si}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (pi === patternSegments.length) {
      result = si === pathSegments.length;
    } else if (patternSegments[pi] === '**') {
      result = walk(pi + 1, si) || (si < pathSegments.length && walk(pi, si + 1));
    } else {
      result =
        si < pathSegments.length &&
        segmentMatcher(patternSegments[pi]).test(pathSegments[si]) &&
        walk(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/** Совпадает ли путь хотя бы с одним шаблоном. */
export function matchAny(patterns, path) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  return patterns.some((pattern) => matchPath(pattern, path));
}

/**
 * Может ли шаблон совпасть с чем-то ВНУТРИ указанного пути.
 *
 * Нужно, чтобы не удалить каталог целиком, если внутри него что-то исключено:
 * цель вида /server/<id> плюс исключение каталога cfg требуют спуститься
 * на уровень ниже и удалять поэлементно.
 *
 * «**» в шаблоне может «съесть» любое число каталогов, поэтому шаблон с «**»
 * может совпасть с чем-то внутри на любой глубине: /oxide/**\/keep.json — и в
 * /oxide/data/Kits, и в /oxide/data/Kits/sub. Считаем так же, как matchPath:
 * путь должен целиком совпасть с началом шаблона, и от шаблона должно
 * остаться ещё хоть что-то.
 */
export function canMatchDescendant(pattern, path) {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(path);
  if (!patternSegments.length || !pathSegments.length) return false;

  const memo = new Map();
  const walk = (pi, si) => {
    const key = `${pi}:${si}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (si === pathSegments.length) {
      // Путь кончился, а шаблон ещё нет — значит, совпасть может что-то внутри.
      result = pi < patternSegments.length;
    } else if (pi === patternSegments.length) {
      result = false;
    } else if (patternSegments[pi] === '**') {
      result = walk(pi + 1, si) || walk(pi, si + 1);
    } else {
      result = segmentMatcher(patternSegments[pi]).test(pathSegments[si]) && walk(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/**
 * Считается ли путь исключённым. Исключение срабатывает и на самого пути,
 * и на любого его предка: шаблон каталога cfg закрывает всё его содержимое.
 */
export function isExcluded(patterns, path) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  const ancestors = [];
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    ancestors.push(current);
  }
  for (const pattern of patterns) {
    const normalized = normalizePath(pattern);
    if (!normalized) continue;
    for (const candidate of ancestors) {
      if (matchPath(normalized, candidate)) return true;
    }
  }
  return false;
}

/** Глубина пути: "/server/rust/x" → 3. */
export function pathDepth(path) {
  return String(path ?? '')
    .split('/')
    .filter(Boolean).length;
}

export function joinPath(base, name) {
  const normalizedBase = base === '/' ? '' : String(base || '').replace(/\/+$/, '');
  return `${normalizedBase}/${name}`;
}

export function baseName(path) {
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '/';
}

export function parentPath(path) {
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  segments.pop();
  return segments.length ? `/${segments.join('/')}` : '/';
}
