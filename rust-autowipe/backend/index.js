/**
 * Rust AutoWipe — backend-энтри плагина Catalyst.
 *
 * Плагин привязан к конкретному серверу: все роуты живут под
 * /api/plugins/rust-autowipe/servers/:serverId/…, а вкладка в панели —
 * серверная (frontend: location 'server' + templateFilter по шаблону Rust).
 *
 * Доступ к серверу проверяется отдельно от прав плагина:
 *  - админ панели (admin.write / *);
 *  - владелец сервера (servers.ownerId);
 *  - субпользователь — тот, кто есть в списке доступа сервера в панели
 *    (GET /api/servers/:id/permissions, запрос ключом плагина из настроек)
 *    и у кого там есть server.read. Cookie и ключи пользователя плагин
 *    никуда не пересылает.
 *
 * Права плагина (userPermissions) управляют только изменениями:
 *  - rust-autowipe.manage — создание/правка/удаление профилей и выбор файлов;
 *  - rust-autowipe.run    — ручной запуск вайпа.
 * Админу и владельцу сервера роли не нужны (ответ владельца: вайп запускают
 * админы и владельцы серверов).
 */

import { createPanelClient, resolvePanelBase } from './lib/api.js';
import { expandTargets, listDirectory } from './lib/glob-walk.js';
import { normalizePath, parentPath } from './lib/glob.js';
import { describeMap } from './lib/mapgen.js';
import { PRESETS } from './lib/presets.js';
import { describeSchedule, nextOccurrence, normalizeSchedule } from './lib/schedule.js';
import { buildProfile, publicProfile } from './lib/store.js';
import { serverClock } from './lib/time.js';
import { zonedParts } from './lib/zoned-time.js';
// Весь модуль, а не только executeProfileRun: функций recoverInterruptedRuns
// (договорённость К4) и retryPendingRestores (повтор запуска сервера после
// прерванного вайпа) может не быть в lib/wipe.js — тогда их не зовём.
import * as wipe from './lib/wipe.js';
import {
  sendWipeWarnings,
  formatWarning,
  getWarningState,
  loadWarningState,
  recordWarningState,
} from './lib/warnings.js';

const MANAGE = 'rust-autowipe.manage';
const RUN = 'rust-autowipe.run';
/** То же правило, что у вкладки (templateFilter.namePattern во frontend): имя шаблона, без учёта регистра. */
const RUST_TEMPLATE = /rust/i;

/**
 * Вайпы, которые этот экземпляр плагина ведёт прямо сейчас:
 * serverId → { profileId, trigger, startedAt }. На одном сервере — не больше
 * одного вайпа, даже из разных профилей (ответ владельца №6). Запись
 * снимается только в конце прогона: выключение плагина её не трогает,
 * потому что сам прогон при этом продолжается.
 */
const activeRuns = new Map();
/** Прогоны, которые этот экземпляр уже закончил (их запись в истории могла не дописаться). */
const finishedRunIds = new Set();
/** Запись «running» старше этого срока сервер не держит: зависшая запись не должна закрыть его навсегда. */
const RUNNING_RECORD_TTL_MS = 6 * 60 * 60 * 1000;
let tickBusy = false;
/** Идёт ли сейчас повтор запуска серверов после прерванного вайпа (retryRestores). */
let restoreBusy = false;

/** Занять сервер под вайп. false — на сервере уже идёт вайп этого экземпляра. */
function claimServer(serverId, profileId, trigger) {
  const key = String(serverId);
  if (activeRuns.has(key)) return false;
  activeRuns.set(key, { profileId: String(profileId), trigger, startedAt: new Date().toISOString() });
  return true;
}

function releaseServer(serverId) {
  activeRuns.delete(String(serverId));
}

/**
 * Прогоны со status 'running' в истории этого сервера (договорённость К4).
 * Так новый экземпляр плагина после перезагрузки или обновления видит вайп,
 * который ещё ведёт старый экземпляр в том же процессе панели.
 */
async function runningRecords(ctx, serverId) {
  try {
    const rows = await ctx.collection('runs').find({ serverId: String(serverId), status: 'running' });
    const since = Date.now() - RUNNING_RECORD_TTL_MS;
    return (Array.isArray(rows) ? rows : []).filter(
      (row) => row && !finishedRunIds.has(row.id) && Date.parse(row.startedAt) > since,
    );
  } catch {
    return [];
  }
}

/** Профили этого сервера, которые сейчас выполняются (в памяти и по записям «running»). */
async function runningProfileIds(ctx, serverId) {
  const ids = new Set();
  const own = activeRuns.get(String(serverId));
  if (own) ids.add(own.profileId);
  for (const row of await runningRecords(ctx, serverId)) {
    if (row.profileId) ids.add(String(row.profileId));
  }
  return ids;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function wrap(ctx, handler) {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      ctx.logger.error(
        { url: request?.url, error: message(error) },
        'rust-autowipe: ошибка обработчика',
      );
      return reply.status(500).send({ success: false, error: message(error) });
    }
  };
}

function hasPerm(ctx, request, token) {
  if (typeof ctx.hasPermission !== 'function') return false;
  try {
    return Boolean(ctx.hasPermission(request, token));
  } catch {
    return false;
  }
}

function userIdOf(ctx, request) {
  try {
    return typeof ctx.getUserId === 'function' ? ctx.getUserId(request) : null;
  } catch {
    return null;
  }
}

async function loadServer(ctx, serverId) {
  if (!serverId) return null;
  try {
    return await ctx.db.servers.findUnique({ where: { id: serverId } });
  } catch (error) {
    ctx.logger.warn({ error: message(error) }, 'rust-autowipe: не удалось прочитать сервер');
    return null;
  }
}

/**
 * GET к API панели ключом плагина из настроек. Ответ засчитывается, только
 * если это 200 с JSON { success: true }: переходы (redirect) не выполняются,
 * страница входа с кодом 200 — не ответ панели.
 * @returns {Promise<{ok: true, data: any} | {ok: false, noKey?: true, reason: string}>}
 */
async function panelGet(ctx, path) {
  const key = String(ctx.getConfig('apiKey') ?? '').trim();
  if (!key) return { ok: false, noKey: true, reason: 'не задан API-ключ панели' };
  let response;
  try {
    response = await fetch(`${resolvePanelBase(ctx)}${path}`, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    return { ok: false, reason: `панель не ответила: ${message(error)}` };
  }
  if (response.status !== 200) return { ok: false, reason: `панель ответила кодом ${response.status}` };
  let json = null;
  try {
    json = JSON.parse(await response.text());
  } catch {
    json = null;
  }
  if (!json || json.success !== true) return { ok: false, reason: 'ответ не похож на API панели' };
  return { ok: true, data: json.data };
}

/**
 * Субпользователь — тот, чей userId есть в списке доступа сервера
 * (GET /api/servers/:id/permissions). Список читается ключом плагина:
 * ответ панели «сервер виден» сам по себе доступом не считается — его
 * получает и человек с глобальной ролью server.read на чужом сервере.
 */
async function subuserAccess(ctx, serverId, userId) {
  if (!userId) return { ok: false };
  const answer = await panelGet(ctx, `/api/servers/${encodeURIComponent(serverId)}/permissions`);
  if (!answer.ok) {
    return {
      ok: false,
      reason: answer.noKey
        ? 'не задан API-ключ панели, без него плагин не может проверить субпользователя (настройки плагина)'
        : `не удалось прочитать список доступа сервера (${answer.reason})`,
    };
  }
  const rows = Array.isArray(answer.data) ? answer.data : [];
  const row = rows.find((item) => item && String(item.userId) === String(userId));
  if (!row) return { ok: false };
  const permissions = Array.isArray(row.permissions) ? row.permissions : [];
  // Вкладка объявлена с server.read: без него субпользователь сервера не видит.
  if (!permissions.includes('server.read') && !permissions.includes('*')) {
    return { ok: false, reason: 'у субпользователя нет права server.read на этом сервере' };
  }
  return { ok: true };
}

/**
 * Сервер Rust или нет (ответ владельца №16: серверу без шаблона Rust — отказ).
 * Имя шаблона плагин узнаёт только у API панели: в ctx.db.servers есть лишь
 * templateId, таблицы шаблонов у плагина нет. Если спросить не удалось (нет
 * API-ключа, панель не ответила) — ответ «неизвестно», и плагин не мешает:
 * вкладка и так видна только у серверов Rust.
 * @returns {Promise<{rust: true} | {rust: false, error: string} | {rust: null, reason: string}>}
 */
async function rustTemplate(ctx, serverId) {
  const answer = await panelGet(ctx, `/api/servers/${encodeURIComponent(serverId)}`);
  if (!answer.ok) return { rust: null, reason: answer.reason };
  const data = answer.data;
  if (!data || String(data.id) !== String(serverId)) return { rust: null, reason: 'панель вернула не тот сервер' };
  const name = typeof data.template?.name === 'string' ? data.template.name : '';
  if (!name) return { rust: null, reason: 'панель не отдала имя шаблона' };
  if (RUST_TEMPLATE.test(name)) return { rust: true };
  return {
    rust: false,
    error: `Сервер не Rust (шаблон «${name.slice(0, 80)}»): плагин работает только с серверами Rust`,
  };
}

/**
 * @returns {Promise<{ok: true, server: object, isAdmin: boolean, isOwner: boolean}
 *   | {ok: false, status: number, error: string}>}
 */
async function serverAccess(ctx, request, serverId) {
  if (!serverId) return { ok: false, status: 400, error: 'Не указан сервер' };

  const server = await loadServer(ctx, serverId);
  if (!server) return { ok: false, status: 404, error: 'Сервер не найден' };
  if (server.suspendedAt) return { ok: false, status: 403, error: 'Сервер приостановлен' };

  const userId = userIdOf(ctx, request);
  const isAdmin = hasPerm(ctx, request, 'admin.write');
  const isOwner = Boolean(userId && server.ownerId && String(server.ownerId) === String(userId));

  if (!isAdmin && !isOwner) {
    const sub = await subuserAccess(ctx, server.id, userId);
    if (!sub.ok) {
      return {
        ok: false,
        status: 403,
        error: sub.reason ? `Нет доступа к этому серверу: ${sub.reason}` : 'Нет доступа к этому серверу',
      };
    }
  }

  const template = await rustTemplate(ctx, server.id);
  if (template.rust === false) return { ok: false, status: 403, error: template.error };

  return { ok: true, server, isAdmin, isOwner };
}

/**
 * Последняя отправка предупреждения — только этого сервера (договорённость К7):
 * вкладка сервера Б не должна показывать «Чат: ок / ошибка» сервера А.
 */
function warningStateOf(serverId) {
  const state = getWarningState(serverId);
  return state && String(state.serverId) === String(serverId) ? state : null;
}

/**
 * Есть ли право плагина. Админу и владельцу сервера роль не нужна. Но запрос
 * с API-ключом ограничен областью ключа, как и в самой панели: права владельца
 * ключ не расширяют.
 */
function canDo(ctx, request, access, token) {
  if (access?.isAdmin) return true;
  if (access?.isOwner && !request?.user?.apiKeyId) return true;
  return hasPerm(ctx, request, token);
}

/**
 * Регистрирует роут, привязанный к серверу: сначала проверка доступа
 * к серверу, затем (опционально) право плагина на изменение/запуск.
 */
function serverRoute(ctx, method, url, handler, { token } = {}) {
  ctx.registerRoute({
    method,
    url,
    handler: wrap(ctx, async (request, reply) => {
      const access = await serverAccess(ctx, request, String(request.params?.serverId ?? ''));
      if (!access.ok) {
        return reply.status(access.status).send({ success: false, error: access.error });
      }
      if (token && !canDo(ctx, request, access, token)) {
        return reply.status(403).send({
          success: false,
          code: 'PLUGIN_ROUTE_FORBIDDEN',
          error: `Недостаточно прав: нужен ${token} (выдаётся ролью в панели)`,
        });
      }
      return handler(request, reply, access.server, access);
    }),
  });
}

/**
 * Что не так с запросом запуска. Проверочный прогон включается только явным
 * dryRun: true. Всё непонятное («"true"», 1, dry_run, ?dryRun=…) — отказ,
 * а не боевой вайп.
 */
function runRequestProblem(request) {
  if (request.query && Object.keys(request.query).length) {
    return 'Параметры запуска передаются в теле запроса: { "dryRun": true } или { "dryRun": false }';
  }
  const body = request.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return 'Тело запроса запуска — объект JSON: { "dryRun": true } или { "dryRun": false }';
  }
  const unknown = Object.keys(body).filter((key) => key !== 'dryRun');
  if (unknown.length) {
    return `Неизвестное поле в запросе запуска: ${unknown.join(', ')}. Можно только dryRun (true или false)`;
  }
  if ('dryRun' in body && typeof body.dryRun !== 'boolean') return 'dryRun — только true или false';
  return null;
}

/**
 * Флаги профиля — только true или false (строки 'true' и 'false' тоже понятны).
 * Иначе «1» или «yes» в options.dryRun молча превращались в false, и
 * проверочный профиль становился боевым.
 */
function flagProblems(body) {
  const problems = [];
  const check = (value, label) => {
    if (value === undefined || value === true || value === false || value === 'true' || value === 'false') return;
    problems.push(`Поле ${label} — только true или false`);
  };
  check(body?.enabled, 'enabled');
  for (const key of ['stopServer', 'startServer', 'dryRun', 'warnChat']) {
    check(body?.options?.[key], `options.${key}`);
  }
  return problems;
}

async function collectProfiles(ctx, serverId) {
  const profiles = await ctx.collection('profiles').find({ serverId });
  const running = await runningProfileIds(ctx, serverId);
  const now = new Date();
  return profiles
    .map((profile) => {
      const next = profile.nextRunAt ? new Date(profile.nextRunAt) : null;
      return {
        ...publicProfile(profile),
        scheduleText: describeSchedule(profile.schedule),
        mapText: describeMap(profile.map),
        overdue: Boolean(next && !Number.isNaN(next.getTime()) && next.getTime() < now.getTime()),
        running: running.has(String(profile.id)),
        // Пропущенный плановый вайп и причина — видны во вкладке, а не только в журнале панели.
        lastSkippedAt: profile.lastSkippedAt || null,
        lastSkipReason: profile.lastSkipReason || null,
        // Догон после простоя: плановый срок, который пройдёт после отсчёта в чате (nextRunAt).
        catchUpOf: profile.catchUpOf || null,
        // Итог последней проверки (dry-run) — отдельно от итога настоящего вайпа (договорённости К4, К5).
        lastCheckAt: profile.lastCheckAt || null,
        lastCheckStatus: profile.lastCheckStatus || null,
        lastCheckId: profile.lastCheckId || null,
        lastCheckError: profile.lastCheckError || null,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Профиль по id, но только если он принадлежит этому серверу. */
async function profileOfServer(ctx, serverId, profileId) {
  const profile = await ctx.collection('profiles').findOne({ id: profileId });
  if (!profile) return null;
  if (String(profile.serverId) !== String(serverId)) return null;
  return profile;
}

// ── Расписание: срок, серия и окно догона ──────────────────────────────────

/** Окно догона из настроек (catchUpMinutes): число от 0; мусор — 120, как по умолчанию. */
function catchUpWindow(ctx) {
  const value = Number(ctx.getConfig('catchUpMinutes') ?? 120);
  return Number.isFinite(value) && value >= 0 ? value : 120;
}

const hasAnchorDate = (schedule) => /^\d{4}-\d{2}-\d{2}$/.test(String(schedule?.anchorDate ?? ''));

/** Дата момента в поясе профиля (пусто — пояс панели): «2026-11-02». */
function dayInZone(date, timeZone) {
  const pad = (value) => String(value).padStart(2, '0');
  if (timeZone) {
    const parts = zonedParts(date, timeZone);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Расписание для расчёта следующего срока. У «каждые N дней» без даты-якоря
 * якорем становится дата планового запуска (ответ владельца №10: плагин
 * запоминает первую дату и считает от неё) — иначе отсчёт шёл бы от «сегодня»
 * и серия сдвигалась бы после каждого догона и каждой правки.
 */
function anchoredSchedule(rawSchedule, slot) {
  const schedule = normalizeSchedule(rawSchedule);
  if (schedule.kind === 'interval' && !hasAnchorDate(rawSchedule) && slot) {
    schedule.anchorDate = dayInZone(slot, schedule.timeZone);
  }
  return schedule;
}

/**
 * Следующий срок после планового (договорённость К6): по серии от самого
 * срока, а не от «сейчас»; сроки, которые уже прошли, пропускаются.
 */
function nextSlotAfter(schedule, slot, now) {
  const next = nextOccurrence(schedule, slot, schedule.timeZone);
  return next.getTime() > now.getTime() ? next : nextOccurrence(schedule, now, schedule.timeZone);
}

/** Дату-якорь, которую плагин вычислил сам, надо сохранить в профиле. */
function anchorUpdate(profile, schedule) {
  if (schedule.kind !== 'interval' || hasAnchorDate(profile.schedule) || !schedule.anchorDate) return {};
  return { schedule: { ...(profile.schedule || {}), anchorDate: schedule.anchorDate } };
}

/** Поля расписания, от которых зависит время вайпа (дата-якорь сравнивается отдельно). */
function scheduleKey(schedule) {
  const s = normalizeSchedule(schedule);
  return JSON.stringify([s.kind, s.time, s.timeZone, s.weekday, s.nth, s.day, s.intervalDays]);
}

/**
 * Изменилось ли расписание при правке. Дата-якорь меняется, только если её
 * прислали явно и она другая: вкладка шлёт anchorDate: null, и это не значит
 * «начать отсчёт заново».
 */
function sameSchedule(before, after, sent) {
  if (scheduleKey(before) !== scheduleKey(after)) return false;
  if (normalizeSchedule(after).kind !== 'interval') return true;
  const was = hasAnchorDate(before) ? before.anchorDate : null;
  const wanted = hasAnchorDate(sent) ? sent.anchorDate : was;
  return was === wanted;
}

/**
 * nextRunAt после правки (договорённость К6). Расписание не менялось — срок
 * остаётся прежним: «Выключить», «Включить» и переименование отсчёт не
 * сбрасывают (ответ владельца №10). Новый срок считается, если расписание
 * изменили, срока нет или профиль включили после того, как его срок прошёл
 * (иначе включение сразу запустило бы догон).
 */
function nextRunAfterEdit(existing, profile, sentSchedule) {
  const now = new Date();
  const schedule = profile.schedule;
  const stored = existing.nextRunAt ? new Date(existing.nextRunAt) : null;
  const valid = Boolean(stored && !Number.isNaN(stored.getTime()));
  if (sameSchedule(existing.schedule, schedule, sentSchedule)) {
    if (schedule.kind === 'interval') {
      // Во время отсчёта догона nextRunAt — время после отсчёта, а плановый
      // срок лежит в catchUpOf (как в тике): точка отсчёта — его дата.
      const planned =
        existing.catchUpOf && !Number.isNaN(Date.parse(existing.catchUpOf)) ? new Date(existing.catchUpOf) : valid ? stored : null;
      if (hasAnchorDate(existing.schedule)) schedule.anchorDate = existing.schedule.anchorDate;
      else if (planned) schedule.anchorDate = dayInZone(planned, schedule.timeZone);
    }
    const reEnabled = existing.enabled === false && profile.enabled !== false;
    if (valid && (stored.getTime() > now.getTime() || !reEnabled)) return stored.toISOString();
  }
  return nextOccurrence(schedule, now, schedule.timeZone).toISOString();
}

/**
 * Ручной вайп прошёл, а плановое время уже наступило или наступило во время
 * прогона, — плановый вайп пропускается (ответ владельца №6): время
 * переносится на следующий срок. После проверки (dry-run) и после ручного
 * прогона, который упал, ничего не удалив, плановый вайп остаётся.
 */
async function skipSlotCoveredByManualRun(ctx, profile, run) {
  if (!run || run.dryRun) return;
  if (!run.ok && !(Number(run.deletedCount) > 0)) return;
  const fresh = await ctx.collection('profiles').findOne({ id: profile.id });
  // Во время отсчёта догона настоящий срок — catchUpOf, а nextRunAt — время после отсчёта.
  const planned = fresh?.catchUpOf || fresh?.nextRunAt;
  const slot = planned ? new Date(planned) : null;
  if (!slot || Number.isNaN(slot.getTime())) return;
  const finished = new Date(run.finishedAt || Date.now());
  if (slot.getTime() > finished.getTime()) return;
  const schedule = anchoredSchedule(fresh.schedule, slot);
  const next = nextSlotAfter(schedule, slot, new Date());
  // Служебная запись: updatedAt (версию для редактора) меняет только правка человеком.
  await ctx.collection('profiles').update(
    { id: profile.id },
    {
      $set: {
        nextRunAt: next.toISOString(),
        ...anchorUpdate(fresh, schedule),
        ...(fresh.catchUpOf ? { catchUpOf: null } : {}),
      },
    },
  );
  ctx.logger.info(
    { profileId: profile.id, slot: slot.toISOString(), next: next.toISOString() },
    'rust-autowipe: плановый вайп пропущен — его срок пришёлся на ручной вайп',
  );
}

/**
 * Вайп на уже занятом сервере (claimServer сделан). Сервер освобождается
 * только в конце прогона. Возвращает промис конца прогона.
 */
function startRun(ctx, profile, { trigger, slot = null }) {
  return Promise.resolve()
    .then(() => wipe.executeProfileRun(ctx, profile, { trigger, slot }))
    .then(async (run) => {
      if (run?.id) finishedRunIds.add(run.id);
      if (trigger === 'manual') await skipSlotCoveredByManualRun(ctx, profile, run);
      return run;
    })
    .catch((error) => {
      ctx.logger.error(
        { profileId: profile.id, trigger, error: message(error) },
        'rust-autowipe: вайп завершился ошибкой',
      );
      return null;
    })
    .finally(() => releaseServer(profile.serverId));
}

async function runProfileNow(ctx, profile, reply) {
  const busy = () => {
    const own = activeRuns.get(String(profile.serverId));
    return reply.status(409).send({
      success: false,
      code: 'SERVER_BUSY',
      error:
        own && own.profileId !== String(profile.id)
          ? 'На этом сервере уже идёт вайп другого профиля — дождитесь окончания'
          : 'Этот профиль уже выполняется — дождитесь окончания',
    });
  };
  if (!claimServer(profile.serverId, profile.id, 'manual')) return busy();
  // Вайп мог начать прежний экземпляр плагина (до перезагрузки) — он виден по истории.
  if ((await runningRecords(ctx, profile.serverId)).length) {
    releaseServer(profile.serverId);
    return reply.status(409).send({
      success: false,
      code: 'SERVER_BUSY',
      error: 'На этом сервере уже идёт вайп — дождитесь окончания',
    });
  }
  // Намеренно не ждём: роут живёт под 30-секундным гейтом панели.
  void startRun(ctx, profile, { trigger: 'manual' });

  return {
    success: true,
    started: true,
    dryRun: Boolean(profile?.options?.dryRun) || ctx.getConfig('dryRun') === true,
    message: 'Вайп запущен в фоне. Следите за историей прогонов.',
  };
}

function registerRoutes(ctx) {
  // Пресеты путей одинаковы для всех серверов — глобальный справочник.
  ctx.registerRoute({
    method: 'GET',
    url: '/presets',
    handler: wrap(ctx, async () => ({ success: true, data: PRESETS })),
  });

  // ── Тест предупреждения в чате ─────────────────────────────────────────
  // Отправляет одно сообщение тем же путём, что и планировщик, чтобы админ мог
  // проверить доставку не дожидаясь окна вайпа (и увидеть причину 403/404).
  serverRoute(
    ctx,
    'POST',
    '/servers/:serverId/warn-test',
    async (request, reply, server) => {
      const client = createPanelClient(ctx);
      if (!client.hasKey) {
        return reply
          .status(400)
          .send({ success: false, error: 'Не задан API-ключ панели (настройки плагина)' });
      }
      const minutes = Number(ctx.getConfig('wipeWarningMinutes') ?? 5);
      const template = String(
        ctx.getConfig('wipeWarningText') ?? 'Вайп сервера через {minutes} мин',
      );
      const text = formatWarning(template, Number.isFinite(minutes) && minutes > 0 ? minutes : 5);
      // Тест помечается явно: иначе игроки (и вы) принимают его за реальный отсчёт.
      const line = `[тест] ${text}`;
      try {
        await client.command(server.id, `say ${line}`);
      } catch (error) {
        const reason = message(error);
        await recordWarningState(ctx, {
          at: new Date().toISOString(),
          ok: false,
          error: reason,
          serverId: server.id,
          minutes,
          test: true,
        });
        return reply.status(502).send({ success: false, error: reason });
      }
      const sentAt = new Date().toISOString();
      await recordWarningState(ctx, {
        at: sentAt,
        ok: true,
        text: line,
        serverId: server.id,
        minutes,
        test: true,
      });
      return { success: true, data: { text: line, sentAt } };
    },
    { token: RUN },
  );

  // ── Статус вкладки ──────────────────────────────────────────────────────
  serverRoute(
    ctx,
    'GET',
    '/servers/:serverId/status',
    async (request, _reply, server, access) => {
      const profiles = await ctx.collection('profiles').count({ serverId: server.id }).catch(() => 0);
      return {
        success: true,
        data: {
          server: {
            id: server.id,
            name: server.name,
            uuid: server.uuid,
            nodeId: server.nodeId,
            status: server.status,
            suspended: Boolean(server.suspendedAt),
          },
          version: ctx.manifest.version,
          clock: serverClock(),
          hasApiKey: Boolean(String(ctx.getConfig('apiKey') ?? '').trim()),
          dryRun: ctx.getConfig('dryRun') === true,
          schedulerEnabled: ctx.getConfig('schedulerEnabled') !== false,
          catchUpMinutes: catchUpWindow(ctx),
          stopTimeoutSec: Number(ctx.getConfig('stopTimeoutSec') ?? 300),
          startTimeoutSec: Number(ctx.getConfig('startTimeoutSec') ?? 240),
          wipeWarning: {
            enabled: ctx.getConfig('wipeWarningEnabled') !== false,
            minutes: Number(ctx.getConfig('wipeWarningMinutes') ?? 5),
            text: String(ctx.getConfig('wipeWarningText') ?? 'Вайп сервера через {minutes} мин'),
            state: warningStateOf(server.id),
          },
          running: [...(await runningProfileIds(ctx, server.id))],
          profilesCount: profiles,
          permissions: {
            canManage: canDo(ctx, request, access, MANAGE),
            canRun: canDo(ctx, request, access, RUN),
          },
        },
      };
    },
  );

  // ── Диагностика API-ключа (только для тех, кто может менять) ────────────
  serverRoute(
    ctx,
    'POST',
    '/servers/:serverId/panel-check',
    async () => {
      const client = createPanelClient(ctx);
      if (!client.hasKey) {
        return { success: true, data: { ok: false, error: 'API-ключ не задан' } };
      }
      try {
        await client.ping();
        return { success: true, data: { ok: true, base: client.base } };
      } catch (error) {
        return { success: true, data: { ok: false, base: client.base, error: message(error) } };
      }
    },
    { token: MANAGE },
  );

  // ── Переменные шаблона: какие из них сид/размер ─────────────────────────
  serverRoute(
    ctx,
    'GET',
    '/servers/:serverId/map-variables',
    async (_request, reply, server) => {
      const client = createPanelClient(ctx);
      if (!client.hasKey) {
        return reply.status(400).send({
          success: false,
          error: 'Не задан API-ключ панели: он нужен, чтобы прочитать переменные шаблона',
        });
      }
      try {
        const response = await client.getVariables(server.id);
        const list = Array.isArray(response)
          ? response
          : Array.isArray(response?.data)
            ? response.data
            : [];
        // Значения — только у сида и размера (ответ владельца №18). У остальных
        // переменных одни имена: среди них бывают пароли (например, RCON).
        const isMapVariable = (name) => /SEED|SIZE/i.test(name);
        const variables = list
          .filter((item) => item && typeof item.name === 'string' && item.name)
          .map((item) =>
            isMapVariable(item.name)
              ? {
                  name: item.name,
                  value: String(item.value ?? ''),
                  default: String(item.default ?? ''),
                  input: item.input ?? 'text',
                  rules: Array.isArray(item.rules) ? item.rules : [],
                }
              : { name: item.name },
          );
        const detect = (pattern) => variables.find((item) => pattern.test(item.name))?.name ?? null;
        return {
          success: true,
          data: {
            variables,
            detected: { seed: detect(/SEED/i), size: detect(/SIZE/i) },
          },
        };
      } catch (error) {
        return reply.status(502).send({
          success: false,
          error: `Не удалось прочитать переменные: ${message(error)}`,
        });
      }
    },
    { token: MANAGE },
  );

  // ── Файловый пикер ──────────────────────────────────────────────────────
  // Пикер нужен только в редакторе профиля, поэтому и право то же — manage:
  // плагин листает каталоги своими правами туннеля, а не правами человека.
  serverRoute(
    ctx,
    'GET',
    '/servers/:serverId/files',
    async (request, reply, server) => {
      const raw = String(request.query?.path ?? '/');
      const path = raw === '/' ? '/' : normalizePath(raw);
      if (!path) {
        return reply.status(400).send({ success: false, error: 'Некорректный путь' });
      }
      const entries = await listDirectory(ctx, server, path);
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return {
        success: true,
        data: {
          path,
          parent: path === '/' ? null : parentPath(path),
          breadcrumbs: path
            .split('/')
            .filter(Boolean)
            .map((segment, index, all) => ({
              name: segment,
              path: `/${all.slice(0, index + 1).join('/')}`,
            })),
          entries,
        },
      };
    },
    { token: MANAGE },
  );

  // ── Профили вайпа этого сервера ────────────────────────────────────────
  serverRoute(ctx, 'GET', '/servers/:serverId/profiles', async (_request, _reply, server) => ({
    success: true,
    data: await collectProfiles(ctx, server.id),
  }));

  serverRoute(
    ctx,
    'POST',
    '/servers/:serverId/profiles',
    async (request, reply, server) => {
      const flags = flagProblems(request.body);
      if (flags.length) {
        return reply.status(400).send({ success: false, error: flags.join('; '), errors: flags });
      }
      const body = { ...(request.body || {}), serverId: server.id };
      const { errors, profile } = await buildProfile(ctx, body);
      if (errors.length) {
        return reply.status(400).send({ success: false, error: errors.join('; '), errors });
      }
      profile.serverId = server.id;
      profile.nextRunAt = nextOccurrence(profile.schedule, new Date(), profile.schedule.timeZone).toISOString();
      await ctx.collection('profiles').insert(profile);
      ctx.logger.info(
        { id: profile.id, serverId: server.id },
        'rust-autowipe: профиль создан',
      );
      return { success: true, data: publicProfile(profile) };
    },
    { token: MANAGE },
  );

  serverRoute(
    ctx,
    'PUT',
    '/servers/:serverId/profiles/:profileId',
    async (request, reply, server) => {
      const id = String(request.params?.profileId ?? '');
      const existing = await profileOfServer(ctx, server.id, id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден у этого сервера' });
      }
      // Во время прогона профиль не меняется (как и не удаляется): иначе конец
      // прогона и правка спорят, чьё расписание и чьи пути верные.
      if ((await runningProfileIds(ctx, server.id)).has(id)) {
        return reply.status(409).send({
          success: false,
          code: 'PROFILE_RUNNING',
          error: 'Профиль выполняется — дождитесь окончания вайпа и сохраните ещё раз',
        });
      }
      // Версия, которую видел редактор (договорённость К5): вкладка, открытая
      // раньше, не должна молча вернуть пути, убранные в другом месте.
      // updatedAt меняют только создание и правка профиля: служебные записи
      // (срок, пропуск, отсчёт догона, точка отсчёта, итог прогона) его не трогают.
      const expected = request.body?.expectedUpdatedAt;
      if (expected !== undefined && String(expected ?? '') !== String(existing.updatedAt ?? '')) {
        return reply.status(409).send({
          success: false,
          code: 'PROFILE_CHANGED',
          error: 'Профиль изменён в другом месте. Обновите вкладку.',
        });
      }
      const flags = flagProblems(request.body);
      if (flags.length) {
        return reply.status(400).send({ success: false, error: flags.join('; '), errors: flags });
      }
      const body = { ...(request.body || {}), serverId: server.id };
      const { errors, profile } = await buildProfile(ctx, body, existing);
      if (errors.length) {
        return reply.status(400).send({ success: false, error: errors.join('; '), errors });
      }
      profile.serverId = server.id;
      profile.nextRunAt = nextRunAfterEdit(existing, profile, request.body?.schedule);
      // Новый срок — и догон с отсчётом (catchUpOf) больше не нужен.
      if (existing.catchUpOf && profile.nextRunAt !== existing.nextRunAt) profile.catchUpOf = null;
      await ctx.collection('profiles').update({ id }, { $set: profile });
      ctx.logger.info({ id, serverId: server.id }, 'rust-autowipe: профиль обновлён');
      return { success: true, data: publicProfile(profile) };
    },
    { token: MANAGE },
  );

  serverRoute(
    ctx,
    'DELETE',
    '/servers/:serverId/profiles/:profileId',
    async (request, reply, server) => {
      const id = String(request.params?.profileId ?? '');
      if ((await runningProfileIds(ctx, server.id)).has(id)) {
        return reply.status(409).send({
          success: false,
          code: 'PROFILE_RUNNING',
          error: 'Профиль выполняется — дождитесь окончания',
        });
      }
      const existing = await profileOfServer(ctx, server.id, id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден у этого сервера' });
      }
      const removed = await ctx.collection('profiles').delete({ id });
      ctx.logger.info({ id, serverId: server.id, removed }, 'rust-autowipe: профиль удалён');
      return { success: true, data: { removed } };
    },
    { token: MANAGE },
  );

  serverRoute(
    ctx,
    'POST',
    '/servers/:serverId/profiles/:profileId/run',
    async (request, reply, server) => {
      const problem = runRequestProblem(request);
      if (problem) return reply.status(400).send({ success: false, code: 'BAD_RUN_REQUEST', error: problem });
      const id = String(request.params?.profileId ?? '');
      const profile = await profileOfServer(ctx, server.id, id);
      if (!profile) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден у этого сервера' });
      }
      if (request.body?.dryRun === true) {
        return runProfileNow(
          ctx,
          { ...profile, options: { ...(profile.options || {}), dryRun: true } },
          reply,
        );
      }
      return runProfileNow(ctx, profile, reply);
    },
    { token: RUN },
  );

  serverRoute(
    ctx,
    'POST',
    '/servers/:serverId/profiles/:profileId/preview',
    async (request, reply, server) => {
      const id = String(request.params?.profileId ?? '');
      const profile = await profileOfServer(ctx, server.id, id);
      if (!profile) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден у этого сервера' });
      }
      const expansion = await expandTargets(ctx, server, profile.targets, profile.excludes);
      return {
        success: true,
        data: {
          paths: expansion.paths,
          count: expansion.paths.length,
          truncated: expansion.truncated,
          // Договорённость К2: какие из путей — каталоги (удалятся целиком, со всем
          // содержимым), что пропущено и почему, какой предел сработал.
          directories: Array.isArray(expansion.directories) ? expansion.directories : [],
          skipped: Array.isArray(expansion.skipped) ? expansion.skipped : [],
          limitHit: expansion.limitHit ?? null,
          excluded: profile.excludes || [],
          server: { id: server.id, name: server.name, status: server.status },
        },
      };
    },
  );

  // ── История прогонов этого сервера ─────────────────────────────────────
  serverRoute(
    ctx,
    'GET',
    '/servers/:serverId/runs',
    async (request, _reply, server) => {
      const limit = Math.min(200, Math.max(1, Number(request.query?.limit) || 50));
      const profileId = request.query?.profileId ? String(request.query.profileId) : null;
      const filter = profileId
        ? { serverId: server.id, profileId }
        : { serverId: server.id };
      const runs = await ctx.collection('runs').find(filter, {
        sort: { startedAt: -1 },
        limit,
      });
      return { success: true, data: runs };
    },
  );
}

/**
 * За сколько минут игроки получат отсчёт в чате перед вайпом этого профиля.
 * 0 — отсчёта не будет: предупреждения выключены, это проверка (dry-run) или
 * нет API-ключа (без него команды в консоль не уходят).
 */
function countdownMinutes(ctx, profile) {
  if (ctx.getConfig('wipeWarningEnabled') === false) return 0;
  if (ctx.getConfig('dryRun') === true || profile?.options?.dryRun) return 0;
  if (profile?.options?.warnChat === false) return 0;
  if (!String(ctx.getConfig('apiKey') ?? '').trim()) return 0;
  const lead = Number(ctx.getConfig('wipeWarningMinutes') ?? 5);
  return Number.isFinite(lead) && lead > 0 ? Math.ceil(lead) : 0;
}

/**
 * Занять плановый срок: записать следующий запуск до начала вайпа.
 * false — записать не удалось (или профиль уже удалён), вайп не начинать.
 * Записи тика служебные и updatedAt не трогают: иначе сохранение из
 * редактора, открытого до тика, получало бы ложный 409 PROFILE_CHANGED.
 */
async function occupySlot(ctx, profile, next, extra = {}) {
  try {
    const count = await ctx.collection('profiles').update(
      { id: profile.id },
      { $set: { nextRunAt: next.toISOString(), ...extra } },
    );
    return count !== 0;
  } catch (error) {
    ctx.logger.warn(
      { profileId: profile.id, error: message(error) },
      'rust-autowipe: не удалось занять срок вайпа — попробуем на следующем тике',
    );
    return false;
  }
}

/**
 * Профиль, срок которого наступил: пропуск, ожидание или вайп в фоне.
 * Возвращает { done } — промис конца вайпа — или null, если вайп в этом тике
 * не начат. Промис завёрнут в объект: иначе async-функция дождалась бы его сама.
 */
async function startDueProfile(ctx, snapshot, now, catchUpMinutes) {
  // На сервере уже идёт вайп (ручной или другого профиля) — срок не трогаем,
  // вайп пройдёт на следующем тике, когда сервер освободится.
  if (!claimServer(snapshot.serverId, snapshot.id, 'schedule')) return null;
  let run = null;
  try {
    // Профиль перечитывается: снимок взят в начале тика, а за это время профиль
    // могли выключить, удалить или изменить (например, включить проверку).
    const profile = await ctx.collection('profiles').findOne({ id: snapshot.id });
    if (!profile || profile.enabled === false || String(profile.serverId) !== String(snapshot.serverId)) return null;
    const slot = profile.nextRunAt ? new Date(profile.nextRunAt) : null;
    if (!slot || Number.isNaN(slot.getTime()) || slot.getTime() > now.getTime()) return null;
    if ((await runningRecords(ctx, profile.serverId)).length) return null;

    // Опоздание — целыми минутами: тик в назначенную минуту (05:00:00.040)
    // опоздавшим не считается, поэтому и при catchUpMinutes: 0 вайп идёт.
    const lateMinutes = Math.floor((now.getTime() - slot.getTime()) / 60000);
    // Догон с отсчётом (ниже): nextRunAt — время после отсчёта, а серия идёт
    // от настоящего планового срока, он сохранён в catchUpOf.
    const plannedSlot = profile.catchUpOf && !Number.isNaN(Date.parse(profile.catchUpOf)) ? new Date(profile.catchUpOf) : slot;
    const doneWithCatchUp = profile.catchUpOf ? { catchUpOf: null } : {};
    const schedule = anchoredSchedule(profile.schedule, plannedSlot);
    const nextAfter = nextSlotAfter(schedule, plannedSlot, now);
    const skip = async (reason) => {
      await ctx.collection('profiles').update(
        { id: profile.id },
        {
          $set: {
            nextRunAt: nextAfter.toISOString(),
            lastSkippedAt: now.toISOString(),
            lastSkipReason: reason,
            ...anchorUpdate(profile, schedule),
            ...doneWithCatchUp,
          },
        },
      );
      ctx.logger.warn(
        { profileId: profile.id, serverId: profile.serverId, reason, next: nextAfter.toISOString() },
        'rust-autowipe: плановый вайп пропущен, время перенесено',
      );
    };

    if (lateMinutes > catchUpMinutes) {
      await skip(
        `Плановый вайп пропущен: срок прошёл ${lateMinutes} мин назад, а догонять можно не дольше ${catchUpMinutes} мин (настройка catchUpMinutes)`,
      );
      return null;
    }

    // Только Rust: профиль мог появиться через API на сервере с другим шаблоном.
    const template = await rustTemplate(ctx, profile.serverId);
    if (template.rust === false) {
      await skip(template.error);
      return null;
    }

    // Догон после простоя панели: отсчёта в чате не было, а на сервере играют.
    // Сначала обычный отсчёт («Вайп через 5…1 мин»), потом вайп — один раз.
    const lead = countdownMinutes(ctx, profile);
    if (lead && lateMinutes >= 1 && !profile.catchUpOf) {
      const at = new Date(Math.floor(now.getTime() / 60000) * 60000 + lead * 60000);
      await ctx.collection('profiles').update(
        { id: profile.id },
        { $set: { nextRunAt: at.toISOString(), catchUpOf: slot.toISOString() } },
      );
      snapshot.nextRunAt = at.toISOString(); // отсчёт начнётся уже в этом тике
      ctx.logger.info(
        { profileId: profile.id, slot: slot.toISOString(), at: at.toISOString() },
        'rust-autowipe: догон пропущенного вайпа — сначала отсчёт в чате',
      );
      return null;
    }

    // Срок занимается до вайпа: если панель упадёт или плагин перезагрузят
    // посреди прогона, этот же срок второй раз не пройдёт. Не записалось —
    // вайпа в этом тике нет, попробуем через минуту.
    if (!(await occupySlot(ctx, profile, nextAfter, { ...anchorUpdate(profile, schedule), ...doneWithCatchUp }))) return null;
    run = startRun(ctx, profile, { trigger: 'schedule', slot: plannedSlot.toISOString() });
    return { done: run };
  } finally {
    if (!run) releaseServer(snapshot.serverId);
  }
}

/** Испорченные записи, о которых уже сказано в журнале (чтобы не писать каждую минуту). */
const reportedBroken = new Set();

/**
 * Запись профиля пригодна для тика: есть id и serverId строкой. Запись без id
 * (ручная правка базы, сбой импорта) пропускается: фильтр { id: undefined } в
 * панели совпадает со всеми документами — её срок, отметки предупреждений и
 * итоги прогона записались бы во все профили всех серверов.
 */
function usableProfile(ctx, profile) {
  if (!profile) return false;
  if (typeof profile.id === 'string' && profile.id && typeof profile.serverId === 'string' && profile.serverId) return true;
  const key = String(profile._id ?? JSON.stringify(profile).slice(0, 120));
  if (!reportedBroken.has(key)) {
    reportedBroken.add(key);
    ctx.logger.warn(
      { docId: profile._id ?? null, id: profile.id ?? null, serverId: profile.serverId ?? null },
      'rust-autowipe: запись профиля без id или serverId пропущена планировщиком',
    );
  }
  return false;
}

/**
 * Сервер, который остановил прерванный вайп, при включении плагина часто не
 * поднять: панель ещё не принимает запросы. Запуск повторяет
 * wipe.retryPendingRestores (если она есть), а тик зовёт её раз в минуту —
 * в фоне: зависший запрос к панели не держит ни вайпы, ни предупреждения.
 * Пока прежний вызов не закончился, новый не начинается: сервер не получит
 * две команды запуска. Возвращает промис вызова или null, если вызова нет.
 */
function retryRestores(ctx) {
  if (typeof wipe.retryPendingRestores !== 'function' || restoreBusy) return null;
  restoreBusy = true;
  return Promise.resolve()
    .then(() => wipe.retryPendingRestores(ctx, new Date()))
    .catch((error) => {
      ctx.logger.warn(
        { error: message(error) },
        'rust-autowipe: не удалось повторить запуск сервера после прерванного вайпа — попробуем на следующем тике',
      );
    })
    .finally(() => {
      restoreBusy = false;
    });
}

async function runTick(ctx) {
  if (tickBusy) return;
  tickBusy = true;
  // Вайпы тик запускает в фоне и не ждёт: иначе долгий вайп одного сервера
  // съедал предупреждения и сдвигал вайпы остальных серверов.
  const started = [];
  try {
    // Выключатель в настройках действует сразу: ни вайпов, ни предупреждений.
    if (ctx.getConfig('schedulerEnabled') === false) return;
    const profiles = (await ctx.collection('profiles').find()).filter((profile) => usableProfile(ctx, profile));
    const now = new Date();
    const catchUpMinutes = catchUpWindow(ctx);

    for (const profile of profiles) {
      if (!profile || profile.enabled === false) continue;

      const storedNext = profile.nextRunAt ? new Date(profile.nextRunAt) : null;
      if (!storedNext || Number.isNaN(storedNext.getTime())) {
        const fresh = normalizeSchedule(profile.schedule);
        const computed = nextOccurrence(fresh, now, fresh.timeZone);
        await ctx.collection('profiles').update(
          { id: profile.id },
          { $set: { nextRunAt: computed.toISOString() } },
        );
        continue;
      }

      if (storedNext.getTime() > now.getTime()) continue;

      try {
        const due = await startDueProfile(ctx, profile, now, catchUpMinutes);
        if (due) started.push(due.done);
      } catch (error) {
        ctx.logger.warn(
          { profileId: profile.id, error: message(error) },
          'rust-autowipe: не удалось обработать плановый срок — попробуем на следующем тике',
        );
      }
    }

    // Предупреждения в чат — после разбора сроков: так догон с отсчётом (выше)
    // начинает отсчёт в этом же тике. Вайпы идут в фоне и рассылку не держат.
    // Отсчёт — только перед настоящим вайпом (ответ владельца №15): не при
    // глобальном dryRun и не у профиля в режиме проверки.
    const warnable = ctx.getConfig('dryRun') === true ? [] : profiles.filter((profile) => !profile?.options?.dryRun);
    try {
      await sendWipeWarnings(ctx, warnable, now);
    } catch (error) {
      ctx.logger.warn(
        { error: message(error) },
        'rust-autowipe: не удалось разослать предупреждения в чат',
      );
    }
  } catch (error) {
    ctx.logger.error({ error: message(error) }, 'rust-autowipe: ошибка планировщика');
  } finally {
    tickBusy = false;
    // Повтор запуска после прерванного вайпа — после разбора сроков: вайпы
    // этого тика уже записаны как идущие, и их серверы повтор не тронет.
    // Идёт и при выключенном планировщике: это не вайп, а подъём сервера,
    // который остановил сам плагин.
    const restore = retryRestores(ctx);
    if (restore) started.push(restore);
  }
  // Промис тика заканчивается вместе с его вайпами, но следующий тик уже не
  // заблокирован: задача панели вызывает его каждую минуту, не дожидаясь этого.
  await Promise.allSettled(started);
}

const plugin = {
  async onLoad(ctx) {
    registerRoutes(ctx);
    ctx.logger.info('rust-autowipe: маршруты зарегистрированы (server-scoped)');
  },

  async onEnable(ctx) {
    // Прогоны, оборванные падением или перезапуском панели (договорённость К4):
    // отметить прерванными и поднять сервер, если его остановил плагин. До первого тика.
    if (typeof wipe.recoverInterruptedRuns === 'function') {
      try {
        await wipe.recoverInterruptedRuns(ctx);
      } catch (error) {
        ctx.logger.warn({ error: message(error) }, 'rust-autowipe: не удалось разобрать прерванные прогоны');
      }
    }
    await loadWarningState(ctx);
    // Задача ставится всегда, а выключатель schedulerEnabled тик читает сам при
    // каждом запуске: панель при сохранении настроек плагин не перезапускает.
    ctx.scheduleTask('* * * * *', () => runTick(ctx));
    if (ctx.getConfig('schedulerEnabled') === false) {
      ctx.logger.warn('rust-autowipe: планировщик выключен в настройках плагина — плановых вайпов нет, пока его не включат');
    } else {
      ctx.logger.info('rust-autowipe: планировщик активен (проверка раз в минуту)');
    }
    // Догоняем пропущенное сразу после включения/старта панели.
    void runTick(ctx);
  },

  // Идущий вайп при выключении или перезагрузке плагина не прерывается (панель
  // его не отменяет), поэтому признак «на сервере идёт вайп» здесь не снимается:
  // его снимет сам прогон, когда закончится.
  async onDisable() {},

  async onUnload() {},
};

export default plugin;
export { runTick, serverAccess };
