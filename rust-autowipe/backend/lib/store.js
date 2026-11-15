/**
 * Валидация и нормализация профилей вайпа.
 */

import { normalizePath } from './glob.js';
import { normalizeSchedule } from './schedule.js';

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function toBool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeList(value, { maxItems = 40, maxLength = 400 } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = normalizePath(item);
    if (!normalized || normalized === '/') continue;
    if (normalized.length > maxLength) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeCommands(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const command = item.trim();
    if (!command) continue;
    out.push(command.slice(0, 200));
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * @param {object} ctx контекст плагина
 * @param {object} input тело запроса
 * @param {object|null} existing текущий профиль (для PUT)
 */
export async function buildProfile(ctx, input, existing = null) {
  const errors = [];
  const source = input && typeof input === 'object' ? input : {};
  const base = existing || {};

  const name = String(source.name ?? base.name ?? '').trim();
  if (!name) errors.push('Укажите название профиля');
  if (name.length > 120) errors.push('Название профиля длиннее 120 символов');

  const serverId = String(source.serverId ?? base.serverId ?? '').trim();
  let server = null;
  if (!serverId) {
    errors.push('Выберите сервер');
  } else {
    try {
      server = await ctx.db.servers.findUnique({ where: { id: serverId } });
    } catch (error) {
      errors.push(
        `Не удалось прочитать сервер: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!server) errors.push('Сервер не найден');
  }

  const targets = normalizeList(source.targets ?? base.targets);
  if (!targets.length) {
    errors.push('Добавьте хотя бы один путь или шаблон для удаления');
  }
  // Удаление всего содержимого корня каталога сервера — это не вайп, а снос
  // установки (вместе со startup-скриптами). Такое надо делать осознанно и
  // вручную, а не профилем по расписанию.
  for (const target of targets) {
    if (target === '/*' || target === '/**') {
      errors.push(
        'Нельзя удалять всё содержимое корня каталога сервера: укажите конкретные каталоги (например /server/*)',
      );
    }
  }

  const excludes = normalizeList(source.excludes ?? base.excludes);

  const schedule = normalizeSchedule(source.schedule ?? base.schedule);
  const options = {
    stopServer: toBool(source?.options?.stopServer ?? base?.options?.stopServer, true),
    startServer: toBool(source?.options?.startServer ?? base?.options?.startServer, true),
    dryRun: toBool(source?.options?.dryRun ?? base?.options?.dryRun, false),
    commandsAfter: normalizeCommands(
      source?.options?.commandsAfter ?? base?.options?.commandsAfter,
    ),
  };

  const enabled = toBool(source.enabled ?? base.enabled, true);
  const now = new Date().toISOString();

  const profile = {
    id: base.id || newId('wipe'),
    name,
    serverId,
    serverName: server?.name ?? base.serverName ?? '',
    serverUuid: server?.uuid ?? base.serverUuid ?? '',
    nodeId: server?.nodeId ?? base.nodeId ?? '',
    enabled,
    schedule,
    targets,
    excludes,
    options,
    createdAt: base.createdAt || now,
    updatedAt: now,
  };

  if (base.nextRunAt !== undefined) profile.nextRunAt = base.nextRunAt;
  if (base.lastRunAt !== undefined) profile.lastRunAt = base.lastRunAt;
  if (base.lastRunStatus !== undefined) profile.lastRunStatus = base.lastRunStatus;
  if (base.lastRunId !== undefined) profile.lastRunId = base.lastRunId;
  if (base.lastError !== undefined) profile.lastError = base.lastError;

  return { errors, profile, server };
}

/** Краткая карточка профиля для UI. */
export function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    serverId: profile.serverId,
    serverName: profile.serverName,
    enabled: profile.enabled !== false,
    schedule: profile.schedule,
    targets: profile.targets || [],
    excludes: profile.excludes || [],
    options: profile.options || {},
    nextRunAt: profile.nextRunAt || null,
    lastRunAt: profile.lastRunAt || null,
    lastRunStatus: profile.lastRunStatus || null,
    lastRunId: profile.lastRunId || null,
    lastError: profile.lastError || null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}
