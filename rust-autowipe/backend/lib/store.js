/**
 * Валидация и нормализация профилей вайпа.
 */

import { isRootMask, literalName, normalizePath } from './glob.js';
import { normalizeMapSettings, validateMapInput } from './mapgen.js';
import { normalizeSchedule, validateScheduleInput } from './schedule.js';

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function toBool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export const MAX_LIST_ITEMS = 40;
export const MAX_PATH_LENGTH = 400;
export const MAX_COMMANDS = 10;
export const MAX_COMMAND_LENGTH = 200;

/** Короткий показ строки в тексте ошибки. */
function shortText(value) {
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * Список путей (цели или исключения) → { items, errors }.
 * Неверный путь не выбрасывается молча, а называется в ошибке: пропавшее
 * исключение — это удалённый файл, пропавшая цель — неудалённый.
 * Пустые строки и повторы убираются без ошибки — от них ничего не зависит.
 */
function normalizeList(value, { label, maxItems = MAX_LIST_ITEMS, maxLength = MAX_PATH_LENGTH }) {
  const errors = [];
  if (value === undefined || value === null) return { items: [], errors };
  if (!Array.isArray(value)) return { items: [], errors: [`${label}: нужен список путей`] };
  const items = [];
  const seen = new Set();
  value.forEach((item, index) => {
    const where = `${label} №${index + 1}`;
    if (typeof item !== 'string') {
      errors.push(`${where}: путь должен быть строкой`);
      return;
    }
    if (!item.trim()) return;
    const normalized = normalizePath(item);
    const escapesRoot =
      !normalized ||
      normalized
        .split('/')
        .filter(Boolean)
        .some((segment) => ['.', '..'].includes(literalName(segment)));
    if (escapesRoot) {
      errors.push(`${where} (${shortText(item)}): «..» и «.» в пути нельзя — путь указал бы не туда`);
      return;
    }
    if (normalized === '/') {
      errors.push(`${where}: «/» — это весь каталог сервера, так нельзя. Укажите конкретный каталог или файл`);
      return;
    }
    if (normalized.length > maxLength) {
      errors.push(`${where}: путь длиннее ${maxLength} символов`);
      return;
    }
    if (seen.has(normalized)) return;
    seen.add(normalized);
    items.push(normalized);
  });
  if (items.length > maxItems) {
    errors.push(`${label}: не больше ${maxItems} путей, а их ${items.length} — уберите лишние`);
  }
  return { items: items.slice(0, maxItems), errors };
}

/** Команды после запуска → { items, errors }. Лишние и длинные — ошибка, а не обрезка. */
function normalizeCommands(value) {
  const errors = [];
  if (value === undefined || value === null) return { items: [], errors };
  if (!Array.isArray(value)) return { items: [], errors: ['Команды после запуска: нужен список команд'] };
  const items = [];
  value.forEach((item, index) => {
    const where = `Команда №${index + 1}`;
    if (typeof item !== 'string') {
      errors.push(`${where}: должна быть строкой`);
      return;
    }
    const command = item.trim();
    if (!command) return;
    if (command.length > MAX_COMMAND_LENGTH) {
      errors.push(`${where} (${shortText(command)}): длиннее ${MAX_COMMAND_LENGTH} символов`);
      return;
    }
    items.push(command);
  });
  if (items.length > MAX_COMMANDS) {
    errors.push(`Команд после запуска не больше ${MAX_COMMANDS}, а их ${items.length} — уберите лишние`);
  }
  return { items: items.slice(0, MAX_COMMANDS), errors };
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

  const targetList = normalizeList(source.targets ?? base.targets, { label: 'Цель' });
  errors.push(...targetList.errors);
  const targets = targetList.items;
  if (!targets.length && !targetList.errors.length) {
    errors.push('Добавьте хотя бы один путь или шаблон для удаления');
  }
  // Удаление всего содержимого корня каталога сервера — это не вайп, а снос
  // установки (вместе со startup-скриптами). Такое надо делать осознанно и
  // вручную, а не профилем по расписанию. Запрещены не только /* и /**,
  // но и любая цель без единой буквы: /**/*, /?*, /*/** значат то же самое.
  for (const target of targets) {
    if (isRootMask(target)) {
      errors.push(
        `Цель ${target}: нельзя удалять всё содержимое корня каталога сервера — укажите конкретные каталоги (например /server/*)`,
      );
    }
  }

  const excludeList = normalizeList(source.excludes ?? base.excludes, { label: 'Исключение' });
  errors.push(...excludeList.errors);
  const excludes = excludeList.items;

  // Карта: у профилей, созданных до 1.2.0, поля map нет — сохраняем прежнее
  // поведение («не трогать сид/размер»), чтобы обновление не меняло карту.
  const legacyMap = !source.map && !base.map;
  const rawMap = source.map ?? base.map;
  errors.push(...validateMapInput(rawMap));
  const map = normalizeMapSettings(rawMap, { legacy: legacyMap });

  // Пояс с опечаткой нельзя молча заменить поясом панели: вайп сдвинется.
  const rawSchedule = source.schedule ?? base.schedule;
  errors.push(...validateScheduleInput(rawSchedule));
  const schedule = normalizeSchedule(rawSchedule);
  const commandList = normalizeCommands(source?.options?.commandsAfter ?? base?.options?.commandsAfter);
  errors.push(...commandList.errors);
  const options = {
    stopServer: toBool(source?.options?.stopServer ?? base?.options?.stopServer, true),
    startServer: toBool(source?.options?.startServer ?? base?.options?.startServer, true),
    dryRun: toBool(source?.options?.dryRun ?? base?.options?.dryRun, false),
    // Предупреждения в чате: у профилей до 1.4.0 поля нет — включаем по умолчанию.
    warnChat: toBool(source?.options?.warnChat ?? base?.options?.warnChat, true),
    commandsAfter: commandList.items,
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
    map,
    createdAt: base.createdAt || now,
    updatedAt: now,
  };

  if (base.mapState !== undefined) profile.mapState = base.mapState;
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
    // У профиля до 1.2.0 поля map нет: вайп карту не трогает — так и показываем,
    // иначе редактор отправил бы обратно «случайный сид и размер 3000».
    map: profile.map || normalizeMapSettings(null, { legacy: true }),
    nextRunAt: profile.nextRunAt || null,
    lastRunAt: profile.lastRunAt || null,
    lastRunStatus: profile.lastRunStatus || null,
    lastRunId: profile.lastRunId || null,
    lastError: profile.lastError || null,
    lastSeed: profile.lastSeed ?? null,
    lastSize: profile.lastSize ?? null,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null,
  };
}
