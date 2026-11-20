/**
 * Обёртки над файловым туннелем панели (ctx.fileTunnel) и раскрытие
 * glob-шаблонов в конкретные пути внутри каталога сервера.
 */

import {
  canMatchDescendant,
  hasGlob,
  isExcluded,
  isRootMask,
  joinPath,
  literalName,
  literalPath,
  normalizePath,
  parentPath,
  pathDepth,
  segmentMatcher,
} from './glob.js';

/**
 * «Нет такого файла» — только по коду ошибки ОС в конце ответа агента.
 * Агент Catalyst пишет в текст и путь («Failed to read dir <путь>: …»),
 * поэтому искать слова по всему тексту нельзя: папка с «missing» в имени
 * превращала любую ошибку в «папки нет». Ответы агента (file_manager.rs):
 *   list:   «File system error: Failed to read dir <путь>: No such file or directory (os error 2)»;
 *   delete: «IO error: No such file or directory (os error 2)».
 * Всё остальное («Data directory does not exist», «Cannot access path»,
 * таймаут, отказ по ссылке) — настоящая ошибка.
 */
const MISSING_TAIL = 'No such file or directory (os error 2)';
/** «Это файл, а не каталог» — так же, только по коду ошибки ОС в конце. */
const NOT_A_DIRECTORY_TAIL = 'Not a directory (os error 20)';

export const DEFAULT_LIMITS = {
  /** Сколько путей максимум вернёт раскрытие одного профиля. */
  maxMatches: 500,
  /** Ограничение глубины при обходе (защита от /** по всему каталогу). */
  maxDepth: 8,
  /** Сколько запросов list разрешено на один прогон. */
  maxListCalls: 250,
};

export function isMissingError(error) {
  return String(error ?? '').trim().endsWith(MISSING_TAIL);
}

function isNotDirectoryError(error) {
  return String(error ?? '').trim().endsWith(NOT_A_DIRECTORY_TAIL);
}

/**
 * Нет каталога где-то выше по пути: агент отвечает «Cannot access path:
 * <полный путь на ноде>» (file_manager.rs, resolve_beneath). Другие сбои
 * у него — «Cannot access path: <текст ошибки ОС>», путь там не с «/».
 */
function isMissingParentError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /^File system error: Cannot access path: \//.test(message.trim());
}

/**
 * Права, с которыми агент показывает ссылку (symlink). Отдельного признака
 * ссылки в ответе list нет: агент берёт права самой ссылки (lstat), а у
 * ссылки в Linux они всегда 777 (catalyst-agent/src/file_manager.rs, list_dir;
 * file_tunnel.rs, handle_list: mode & 0o7777). Но 777 бывает и у обычного
 * файла или каталога, если так выставили права, — отличить их плагин не может.
 */
const LINK_MODE = 0o777;

/**
 * Почему запись с правами 777 не удаляется. Агент удаляет не саму ссылку,
 * а то, куда она ведёт (file_manager.rs, delete_file): ссылка на /data или
 * на каталог игры снесла бы установку.
 */
const LINK_REASON =
  'возможно, это ссылка (права 777): агент удалил бы не ссылку, а то, куда она ведёт. ' +
  'Не трогаем; если это обычный файл или каталог с правами 777 — удалите вручную или смените права';

/**
 * Имя, которое не передать агенту как есть: панель меняет путь перед
 * отправкой (catalyst-backend/src/lib/path-validation.ts, normalizeRequestPath:
 * «\» → «/», пробелы в конце пути обрезаются). Удалился бы другой файл, или
 * агент ответил бы «нет файла», а файл остался бы.
 */
function nameProblem(name) {
  if (name.includes('\\')) {
    return 'в имени есть «\\»: панель заменяет его на «/», и удалился бы другой путь. Не трогаем — удалите вручную';
  }
  if (name.trimEnd() !== name) {
    return 'имя кончается пробелом: панель обрезает его, и удалился бы другой путь. Не трогаем — удалите вручную';
  }
  return null;
}

function entryShape(dir, raw) {
  // Имя — как его отдал агент, без обрезки: «a.db » и «a.db» — разные файлы.
  const name = String(raw?.name ?? '');
  if (!name || name.includes('/')) return null;
  const isDirectory = Boolean(raw?.isDirectory ?? raw?.is_dir ?? raw?.type === 'directory');
  const mode = Number.isInteger(raw?.mode) ? raw.mode : null;
  return {
    name,
    path: joinPath(dir, name),
    isDirectory,
    size: Number(raw?.size ?? 0) || 0,
    modified: raw?.modified ?? null,
    mode,
    /** Права 777 — так агент показывает ссылку (или обычную запись с такими правами). */
    maybeLink: mode === LINK_MODE,
    /** Почему имя нельзя передать агенту как есть; null — можно. */
    nameProblem: nameProblem(name),
  };
}

/** Почему запись из листинга нельзя удалять или обходить; null — можно. */
function entryProblem(entry) {
  if (entry?.nameProblem) return entry.nameProblem;
  if (entry?.maybeLink) return LINK_REASON;
  return null;
}

/** Читает каталог. Отсутствующий каталог — пустой список, остальное — ошибка. */
export async function listDirectory(ctx, server, dir) {
  if (!ctx.fileTunnel || typeof ctx.fileTunnel.queueRequest !== 'function') {
    throw new Error('Файловый туннель недоступен: панель не дала плагину доступ к файлам сервера');
  }
  const target = dir === '/' ? '/' : normalizePath(dir);
  if (!target) throw new Error(`Некорректный путь: ${dir}`);

  const response = await ctx.fileTunnel.queueRequest(server.nodeId, 'list', server.uuid, target);
  if (response && response.success === true) {
    const raw = Array.isArray(response.data) ? response.data : [];
    return raw.map((entry) => entryShape(target, entry)).filter(Boolean);
  }
  const error = String(response?.error ?? 'не удалось прочитать каталог');
  if (isMissingError(error)) return [];
  throw new Error(error);
}

/** Удаляет файл или каталог (каталог — рекурсивно, это делает агент). */
export async function deletePath(ctx, server, path) {
  if (!ctx.fileTunnel || typeof ctx.fileTunnel.queueRequest !== 'function') {
    return { ok: false, error: 'Файловый туннель недоступен' };
  }
  const target = normalizePath(path);
  if (!target || target === '/') {
    return { ok: false, error: 'Отказано: удаление корня каталога сервера' };
  }

  try {
    const response = await ctx.fileTunnel.queueRequest(
      server.nodeId,
      'delete',
      server.uuid,
      target,
    );
    if (response && response.success === true) return { ok: true };
    const error = String(response?.error ?? 'удаление не удалось');
    if (isMissingError(error)) return { ok: true, missing: true };
    return { ok: false, error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingError(message)) return { ok: true, missing: true };
    return { ok: false, error: message };
  }
}

/** Кончился предел запросов list: дальше каталоги не читаются. */
class LimitReached extends Error {}

/**
 * Раскрывает список целей профиля в конкретные пути.
 *
 * Если упёрлись в предел (запросы list, число путей, глубина), раскрытие
 * не считает непрочитанный каталог пустым и не отдаёт на удаление каталог,
 * внутри которого не проверено исключённое. В ответе тогда truncated: true
 * и limitHit — какой предел и где. Вайп с таким списком удалять не должен.
 *
 * Похожее на ссылку (права 777) не удаляется и не обходится, а попадает в
 * skipped с причиной. Точные пути (без масок) проверяются по листингу их
 * каталога. Ссылки в середине пути (если ссылка — сам /oxide/data) плагин
 * не проверяет.
 *
 * Цель «X/**» — сам каталог X целиком: X проверяется, как точный путь, а
 * внутрь X раскрытие не спускается (кроме обхода исключений).
 *
 * @param {object} ctx контекст плагина
 * @param {object} server запись сервера (nodeId, uuid)
 * @param {string[]} targets пути и glob-шаблоны
 * @param {string[]} excludes шаблоны-исключения
 * @param {object} limits
 * @returns {Promise<{paths: string[], truncated: boolean, listCalls: number,
 *   limitHit: null | {kind: 'listings' | 'matches' | 'depth', detail: string},
 *   skipped: {path: string, reason: string}[], directories: string[]}>}
 *   directories — какие из paths каталоги (удалятся целиком со всем внутри).
 */
export async function expandTargets(ctx, server, targets, excludes = [], limits = {}) {
  const config = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const cache = new Map();
  /** Всё, что видели в листингах: путь → запись (файл или каталог). */
  const known = new Map();
  const results = [];
  const seen = new Set();
  let listCalls = 0;
  let truncated = false;
  let limitHit = null;

  /** Отметить, что упёрлись в предел. Запоминаем первый — с него всё началось. */
  const hitLimit = (kind, detail) => {
    truncated = true;
    if (!limitHit) limitHit = { kind, detail };
  };

  const list = async (dir) => {
    if (cache.has(dir)) return cache.get(dir);
    if (listCalls >= config.maxListCalls) {
      // Каталог не прочитан — считать его пустым нельзя: внутри может лежать
      // исключённое. Дальше не раскрываем.
      // Текст видит админ (история, предпросмотр) — без внутренних слов.
      hitLimit(
        'listings',
        `Кончился предел: ${config.maxListCalls} чтений папок за один прогон. Не прочитан каталог ${dir}`,
      );
      throw new LimitReached();
    }
    listCalls += 1;
    const entries = await listDirectory(ctx, server, dir);
    cache.set(dir, entries);
    for (const entry of entries) known.set(entry.path, entry);
    return entries;
  };

  const tooManyPaths = () => hitLimit('matches', `Больше ${config.maxMatches} путей — остальные не вошли в список`);

  const add = (path) => {
    if (results.length >= config.maxMatches) {
      tooManyPaths();
      return;
    }
    const normalized = normalizePath(path);
    if (!normalized || normalized === '/') return;
    if (isExcluded(excludes, normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  };

  /** Что подошло под цель, но не удаляется: путь → причина. */
  const skippedMap = new Map();
  const skip = (path, reason) => {
    if (isExcluded(excludes, path)) return; // исключённое и так не трогаем
    if (!skippedMap.has(path)) skippedMap.set(path, reason);
  };

  /**
   * Точный путь (без масок): смотрим его запись в листинге родителя, чтобы
   * не удалить ссылку. Записи нет — путь всё равно идёт в список: удаление
   * ответит «уже отсутствует», как раньше.
   */
  const addChecked = async (path) => {
    const normalized = normalizePath(path);
    if (!normalized || normalized === '/' || isExcluded(excludes, normalized)) return;
    let siblings;
    try {
      siblings = await list(parentPath(normalized));
    } catch (error) {
      if (!isMissingParentError(error)) throw error;
      // Нет каталога выше — нет и самого пути, ссылкой он быть не может.
      // Как и раньше, путь идёт в список, удаление ответит ошибкой пути.
      add(normalized);
      return;
    }
    const problem = entryProblem(siblings.find((entry) => entry.path === normalized));
    if (problem) skip(normalized, problem);
    else add(normalized);
  };

  const walk = async (dir, segments, index) => {
    if (results.length >= config.maxMatches) {
      tooManyPaths();
      return;
    }
    if (index >= segments.length) {
      // Каталог из листинга уже проверен. Каталог из точных сегментов
      // (начало цели «/oxide/data/maps/**») проверяем, как точный путь.
      if (known.has(dir)) add(dir);
      else await addChecked(dir);
      return;
    }

    const segment = segments[index];

    if (segment === '**') {
      await walk(dir, segments, index + 1);
      // «**» в конце цели («/oxide/data/**», «**/**» — то же) — это сам
      // каталог целиком, как в 1.5.6: строкой выше он уже проверен на ссылку
      // и попал в список, если его можно удалять, а удалится со всем
      // содержимым. Подпапки не листаем: агент удаляет каталог вместе со
      // ссылками внутри, не заходя по ним, а исключения внутри обходит
      // descendAroundExcludes. Иначе большая папка упиралась в предел
      // чтений, и вайп отменялся.
      if (segments.slice(index + 1).every((rest) => rest === '**')) return;
      // Сам этот каталог оказался ссылкой — внутрь не идём.
      if (entryProblem(known.get(dir))) return;
      if (pathDepth(dir) >= config.maxDepth) {
        // Глубже «**» не идёт. Если там есть каталоги — часть путей могла
        // не попасть в список, и об этом надо сказать, а не молчать.
        // Ссылки не считаем: в них «**» не заходит и без предела.
        const deeper = await list(dir);
        if (deeper.some((entry) => entry.isDirectory && !entryProblem(entry))) {
          hitLimit('depth', `Маска «**» не заходит глубже ${config.maxDepth} уровней: не пройдены каталоги внутри ${dir}`);
        }
        return;
      }
      const entries = await list(dir);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        // В ссылку не заходим: всё, что найдётся «внутри», агент удалил бы там,
        // куда она ведёт.
        const problem = entryProblem(entry);
        if (problem) skip(entry.path, problem);
        else await walk(entry.path, segments, index);
      }
      return;
    }

    if (!hasGlob(segment)) {
      // Сегмент без масок — точное имя («[*]» уже заменено на «*»).
      const next = joinPath(dir, literalName(segment));
      if (index === segments.length - 1) await addChecked(next);
      else await walk(next, segments, index + 1);
      return;
    }

    const entries = await list(dir);
    const matcher = segmentMatcher(segment);
    for (const entry of entries) {
      if (!matcher.test(entry.name)) continue;
      const last = index === segments.length - 1;
      if (!last && !entry.isDirectory) continue;
      const problem = entryProblem(entry);
      if (problem) skip(entry.path, problem);
      else if (last) add(entry.path);
      else await walk(entry.path, segments, index + 1);
    }
  };

  const list0 = Array.isArray(targets) ? targets : [];
  // Цель на всё содержимое корня (/*, /**, /**/*, /?* …) — снос установки.
  // Сохранение такой профиль уже не пропустит, но старые профили могли её
  // сохранить. Проверяем ещё раз, до любого запроса к агенту.
  for (const raw of list0) {
    const target = normalizePath(raw);
    if (target && isRootMask(target)) {
      throw new Error(
        `Цель ${raw} охватывает всё содержимое корня каталога сервера — по ней вайп не идёт. Исправьте профиль: укажите конкретные каталоги (например /server/*)`,
      );
    }
  }
  for (const raw of list0) {
    const target = normalizePath(raw);
    if (!target || target === '/') continue;
    const segments = target.split('/').filter(Boolean);
    const exact = !hasGlob(target);
    try {
      // Цель без масок — точный путь («/oxide/data/[*].json» → файл «*.json»).
      if (exact) await addChecked(literalPath(target));
      else await walk('/', segments, 0);
    } catch (error) {
      // Предел запросов кончился: остальные цели тоже не прочитать.
      if (error instanceof LimitReached) break;
      // Ошибка одного шаблона не должна скрывать остальные: поднимаем наверх,
      // чтобы прогон записал её в шаги и продолжил.
      throw new Error(`${exact ? 'Путь' : 'Шаблон'} ${raw}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Если настроены исключения, каталог нельзя удалять целиком, когда внутри
  // него что-то исключено: спускаемся на уровень ниже и удаляем поэлементно.
  let finalPaths = results;
  if (excludes.length) {
    finalPaths = await descendAroundExcludes(results, {
      excludes,
      list,
      known,
      limits: config,
      hitLimit,
      skip,
    });
  }

  // Схлопываем вложенные пути: если удаляется /server/rust, отдельные
  // /server/rust/* уже не нужны.
  const collapsed = [];
  for (const path of [...finalPaths].sort((a, b) => a.localeCompare(b))) {
    if (collapsed.some((kept) => path.startsWith(`${kept}/`))) continue;
    collapsed.push(path);
  }

  // То, что всё-таки попало в список (например, тот же путь пришёл из другой
  // цели), пропущенным не считаем.
  const skipped = [...skippedMap]
    .filter(([path]) => !collapsed.some((kept) => path === kept || path.startsWith(`${kept}/`)))
    .map(([path, reason]) => ({ path, reason }));

  // Какие пути — каталоги (по листингу): они удалятся целиком, со всем
  // содержимым. Предпросмотр должен об этом сказать.
  const directories = collapsed.filter((path) => known.get(path)?.isDirectory === true);

  return { paths: collapsed, truncated, listCalls, limitHit, skipped, directories };
}

async function descendAroundExcludes(paths, { excludes, list, known, limits, hitLimit, skip }) {
  const out = [];
  const seen = new Set();

  const push = (path) => {
    if (out.length >= limits.maxMatches) {
      hitLimit('matches', `Больше ${limits.maxMatches} путей — остальные не вошли в список`);
      return;
    }
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };

  const probe = async (path) => {
    try {
      return { isDirectory: true, entries: await list(path) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNotDirectoryError(message)) return { isDirectory: false, entries: [] };
      if (isMissingError(message)) return { isDirectory: false, entries: [] };
      throw error;
    }
  };

  const visit = async (path, depth) => {
    if (isExcluded(excludes, path)) return;
    const needsDescend = excludes.some((pattern) => canMatchDescendant(pattern, path));
    // Файл из листинга: внутри него ничего нет, листать его не нужно. Иначе
    // исключение с «**» тратило бы запрос list на каждый файл.
    const isFile = known.get(path)?.isDirectory === false;
    if (!needsDescend || isFile) {
      push(path);
      return;
    }
    if (depth >= limits.maxDepth) {
      // Глубже не проверяем, а внутри может лежать исключённое: такой каталог
      // целиком не удаляем.
      hitLimit(
        'depth',
        `Исключения проверяются не глубже ${limits.maxDepth} уровней: не проверен каталог ${path}`,
      );
      return;
    }
    let probed;
    try {
      probed = await probe(path);
    } catch (error) {
      // Предел запросов кончился: каталог не прочитан — не удаляем его.
      if (error instanceof LimitReached) return;
      throw error;
    }
    const { isDirectory, entries } = probed;
    if (!isDirectory || !entries.length) {
      push(path);
      return;
    }
    for (const entry of entries) {
      if (isExcluded(excludes, entry.path)) continue;
      // Каталог удаляем по частям, значит каждую часть агент удалит отдельно —
      // ссылку среди них не трогаем (целый каталог агент удалил бы вместе с
      // ссылками внутри, не заходя по ним).
      const problem = entryProblem(entry);
      if (problem) skip(entry.path, problem);
      else await visit(entry.path, depth + 1);
    }
  };

  for (const path of paths) {
    await visit(path, 0);
  }
  return out;
}
