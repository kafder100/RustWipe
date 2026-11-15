/**
 * Разбор путей и glob-шаблонов для вайпа.
 *
 * Поддерживается:
 *   *   — любое количество символов внутри сегмента
 *   ?   — один символ внутри сегмента
 *   **  — ноль или более сегментов (только в matchPath, не в раскрытии)
 *
 * Пути всегда абсолютные внутри каталога сервера: "/server/rust",
 * "/oxide/data", ... Каталог сервера — корень ("/").
 */

const REGEXP_SPECIALS = /[.+^${}()|[\]\\]/g;

function escapeRegExp(value) {
  return value.replace(REGEXP_SPECIALS, '\\$&');
}

export function hasGlob(value) {
  return /[*?]/.test(String(value ?? ''));
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

/** Шаблон одного сегмента → RegExp. */
export function segmentMatcher(segment) {
  let pattern = '';
  for (const char of String(segment)) {
    if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += escapeRegExp(char);
  }
  return new RegExp(`^${pattern}$`);
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
 */
export function canMatchDescendant(pattern, path) {
  const patternSegments = String(pattern ?? '')
    .split('/')
    .filter(Boolean);
  const pathSegments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  if (!patternSegments.length || !pathSegments.length) return false;
  if (pathSegments.length >= patternSegments.length) return false;
  for (let i = 0; i < pathSegments.length; i += 1) {
    const segment = patternSegments[i];
    if (segment === '**') return true;
    if (!segmentMatcher(segment).test(pathSegments[i])) return false;
  }
  return true;
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
