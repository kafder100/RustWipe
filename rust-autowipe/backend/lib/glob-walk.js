/**
 * Обёртки над файловым туннелем панели (ctx.fileTunnel) и раскрытие
 * glob-шаблонов в конкретные пути внутри каталога сервера.
 */

import {
  canMatchDescendant,
  hasGlob,
  isExcluded,
  joinPath,
  normalizePath,
  pathDepth,
  segmentMatcher,
} from './glob.js';

const MISSING_HINTS =
  /(not found|no such file|does not exist|enoent|missing|не найден)/i;

export const DEFAULT_LIMITS = {
  /** Сколько путей максимум вернёт раскрытие одного профиля. */
  maxMatches: 500,
  /** Ограничение глубины при обходе (защита от /** по всему каталогу). */
  maxDepth: 8,
  /** Сколько запросов list разрешено на один прогон. */
  maxListCalls: 250,
};

export function isMissingError(error) {
  return MISSING_HINTS.test(String(error ?? ''));
}

function entryShape(dir, raw) {
  const name = String(raw?.name ?? '').trim();
  if (!name || name.includes('/')) return null;
  const isDirectory = Boolean(raw?.isDirectory ?? raw?.is_dir ?? raw?.type === 'directory');
  return {
    name,
    path: joinPath(dir, name),
    isDirectory,
    size: Number(raw?.size ?? 0) || 0,
    modified: raw?.modified ?? null,
  };
}

/** Читает каталог. Отсутствующий каталог — пустой список, остальное — ошибка. */
export async function listDirectory(ctx, server, dir) {
  if (!ctx.fileTunnel || typeof ctx.fileTunnel.queueRequest !== 'function') {
    throw new Error('Файловый туннель недоступен: панель не предоставила ctx.fileTunnel');
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

/**
 * Раскрывает список целей профиля в конкретные пути.
 *
 * @param {object} ctx контекст плагина
 * @param {object} server запись сервера (nodeId, uuid)
 * @param {string[]} targets пути и glob-шаблоны
 * @param {string[]} excludes шаблоны-исключения
 * @param {object} limits
 * @returns {Promise<{paths: string[], truncated: boolean, listCalls: number}>}
 */
export async function expandTargets(ctx, server, targets, excludes = [], limits = {}) {
  const config = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const cache = new Map();
  const results = [];
  const seen = new Set();
  let listCalls = 0;
  let truncated = false;

  const list = async (dir) => {
    if (cache.has(dir)) return cache.get(dir);
    if (listCalls >= config.maxListCalls) {
      truncated = true;
      return [];
    }
    listCalls += 1;
    const entries = await listDirectory(ctx, server, dir);
    cache.set(dir, entries);
    return entries;
  };

  const add = (path) => {
    if (results.length >= config.maxMatches) {
      truncated = true;
      return;
    }
    const normalized = normalizePath(path);
    if (!normalized || normalized === '/') return;
    if (isExcluded(excludes, normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  };

  const walk = async (dir, segments, index) => {
    if (results.length >= config.maxMatches) {
      truncated = true;
      return;
    }
    if (index >= segments.length) {
      add(dir);
      return;
    }

    const segment = segments[index];

    if (segment === '**') {
      await walk(dir, segments, index + 1);
      if (pathDepth(dir) >= config.maxDepth) return;
      const entries = await list(dir);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        await walk(entry.path, segments, index);
      }
      return;
    }

    if (!hasGlob(segment)) {
      const next = joinPath(dir, segment);
      if (index === segments.length - 1) add(next);
      else await walk(next, segments, index + 1);
      return;
    }

    const entries = await list(dir);
    const matcher = segmentMatcher(segment);
    for (const entry of entries) {
      if (!matcher.test(entry.name)) continue;
      if (index === segments.length - 1) add(entry.path);
      else if (entry.isDirectory) await walk(entry.path, segments, index + 1);
    }
  };

  const list0 = Array.isArray(targets) ? targets : [];
  for (const raw of list0) {
    const target = normalizePath(raw);
    if (!target || target === '/') continue;
    const segments = target.split('/').filter(Boolean);
    if (!segments.some((segment) => hasGlob(segment) || segment === '**')) {
      add(target);
      continue;
    }
    try {
      await walk('/', segments, 0);
    } catch (error) {
      // Ошибка одного шаблона не должна скрывать остальные: поднимаем наверх,
      // чтобы прогон записал её в шаги и продолжил.
      throw new Error(`Шаблон ${raw}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Если настроены исключения, каталог нельзя удалять целиком, когда внутри
  // него что-то исключено: спускаемся на уровень ниже и удаляем поэлементно.
  let finalPaths = results;
  if (excludes.length) {
    finalPaths = await descendAroundExcludes(results, {
      excludes,
      list,
      limits: config,
      onTruncated: () => {
        truncated = true;
      },
    });
  }

  // Схлопываем вложенные пути: если удаляется /server/rust, отдельные
  // /server/rust/* уже не нужны.
  const collapsed = [];
  for (const path of [...finalPaths].sort((a, b) => a.localeCompare(b))) {
    if (collapsed.some((kept) => path.startsWith(`${kept}/`))) continue;
    collapsed.push(path);
  }

  return { paths: collapsed, truncated, listCalls };
}

const NOT_A_DIRECTORY = /(not a directory|not a dir|is a file|not directory|enotdir)/i;

async function descendAroundExcludes(paths, { excludes, list, limits, onTruncated }) {
  const out = [];
  const seen = new Set();

  const push = (path) => {
    if (out.length >= limits.maxMatches) {
      onTruncated();
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
      if (NOT_A_DIRECTORY.test(message)) return { isDirectory: false, entries: [] };
      if (isMissingError(message)) return { isDirectory: false, entries: [] };
      throw error;
    }
  };

  const visit = async (path, depth) => {
    if (isExcluded(excludes, path)) return;
    const needsDescend = excludes.some((pattern) => canMatchDescendant(pattern, path));
    if (!needsDescend || depth >= limits.maxDepth) {
      push(path);
      return;
    }
    const { isDirectory, entries } = await probe(path);
    if (!isDirectory || !entries.length) {
      push(path);
      return;
    }
    for (const entry of entries) {
      if (isExcluded(excludes, entry.path)) continue;
      await visit(entry.path, depth + 1);
    }
  };

  for (const path of paths) {
    await visit(path, 0);
  }
  return out;
}
