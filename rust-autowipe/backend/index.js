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
 *  - иначе — делегирование в API панели тем же cookie/ключом вызывающего
 *    (это покрывает субпользователей с выданным доступом к серверу).
 *
 * Права плагина (userPermissions) управляют только изменениями:
 *  - rust-autowipe.manage — создание/правка/удаление профилей;
 *  - rust-autowipe.run    — ручной запуск вайпа.
 */

import { createPanelClient, resolvePanelBase } from './lib/api.js';
import { expandTargets, listDirectory } from './lib/glob-walk.js';
import { normalizePath, parentPath } from './lib/glob.js';
import { PRESETS } from './lib/presets.js';
import { describeSchedule, nextOccurrence, normalizeSchedule } from './lib/schedule.js';
import { buildProfile, publicProfile } from './lib/store.js';
import { serverClock } from './lib/time.js';
import { executeProfileRun } from './lib/wipe.js';

const VIEW = 'rust-autowipe.view';
const MANAGE = 'rust-autowipe.manage';
const RUN = 'rust-autowipe.run';

/** Профили, которые выполняются прямо сейчас (в этом процессе). */
const runningProfiles = new Set();
let tickBusy = false;

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
 * Спросить панель, есть ли у вызывающего доступ к серверу, его же
 * учётными данными. Покрывает субпользователей, которым выдан доступ
 * через ServerAccess, — плагину этот список не виден.
 */
async function callerCanAccessViaPanel(ctx, request, serverId) {
  const cookie = request?.headers?.cookie;
  const authorization = request?.headers?.authorization;
  if (!cookie && !authorization) return false;
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  try {
    const base = resolvePanelBase(ctx);
    const response = await fetch(
      `${base}/api/servers/${encodeURIComponent(serverId)}`,
      { headers, signal: AbortSignal.timeout(5000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ok: true, server: object} | {ok: false, status: number, error: string}>}
 */
async function serverAccess(ctx, request, serverId) {
  if (!serverId) return { ok: false, status: 400, error: 'Не указан сервер' };

  const server = await loadServer(ctx, serverId);
  if (!server) return { ok: false, status: 404, error: 'Сервер не найден' };
  if (server.suspendedAt) return { ok: false, status: 403, error: 'Сервер приостановлен' };

  const userId = userIdOf(ctx, request);
  const isAdmin = hasPerm(ctx, request, 'admin.write');
  const isOwner = Boolean(userId && server.ownerId && String(server.ownerId) === String(userId));

  if (isAdmin || isOwner) return { ok: true, server };
  if (await callerCanAccessViaPanel(ctx, request, serverId)) return { ok: true, server };

  return { ok: false, status: 403, error: 'Нет доступа к этому серверу' };
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
      if (token && !hasPerm(ctx, request, token)) {
        return reply.status(403).send({
          success: false,
          code: 'PLUGIN_ROUTE_FORBIDDEN',
          error: `Недостаточно прав: нужен ${token} (выдаётся ролью в панели)`,
        });
      }
      return handler(request, reply, access.server);
    }),
  });
}

async function collectProfiles(ctx, serverId) {
  const profiles = await ctx.collection('profiles').find({ serverId });
  const now = new Date();
  return profiles
    .map((profile) => {
      const next = profile.nextRunAt ? new Date(profile.nextRunAt) : null;
      return {
        ...publicProfile(profile),
        scheduleText: describeSchedule(profile.schedule),
        overdue: Boolean(next && !Number.isNaN(next.getTime()) && next.getTime() < now.getTime()),
        running: runningProfiles.has(profile.id),
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

function runProfileNow(ctx, profile, reply) {
  if (runningProfiles.has(profile.id)) {
    return reply.status(409).send({
      success: false,
      error: 'Этот профиль уже выполняется — дождитесь окончания',
    });
  }
  runningProfiles.add(profile.id);
  // Намеренно не ждём: роут живёт под 30-секундным гейтом панели.
  void Promise.resolve()
    .then(() => executeProfileRun(ctx, profile, { trigger: 'manual' }))
    .catch((error) => {
      ctx.logger.error(
        { profileId: profile.id, error: message(error) },
        'rust-autowipe: ручной запуск упал',
      );
    })
    .finally(() => {
      runningProfiles.delete(profile.id);
    });

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

  // ── Статус вкладки ──────────────────────────────────────────────────────
  serverRoute(
    ctx,
    'GET',
    '/servers/:serverId/status',
    async (request, _reply, server) => {
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
          catchUpMinutes: Number(ctx.getConfig('catchUpMinutes') ?? 120),
          stopTimeoutSec: Number(ctx.getConfig('stopTimeoutSec') ?? 300),
          startTimeoutSec: Number(ctx.getConfig('startTimeoutSec') ?? 240),
          running: [...runningProfiles],
          profilesCount: profiles,
          permissions: {
            canManage: hasPerm(ctx, request, MANAGE),
            canRun: hasPerm(ctx, request, RUN),
            canView: hasPerm(ctx, request, VIEW),
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

  // ── Файловый пикер ──────────────────────────────────────────────────────
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
      const body = { ...(request.body || {}), serverId: server.id };
      const { errors, profile } = await buildProfile(ctx, body);
      if (errors.length) {
        return reply.status(400).send({ success: false, error: errors.join('; '), errors });
      }
      profile.serverId = server.id;
      profile.nextRunAt = nextOccurrence(profile.schedule, new Date()).toISOString();
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
      const body = { ...(request.body || {}), serverId: server.id };
      const { errors, profile } = await buildProfile(ctx, body, existing);
      if (errors.length) {
        return reply.status(400).send({ success: false, error: errors.join('; '), errors });
      }
      profile.serverId = server.id;
      profile.nextRunAt = nextOccurrence(profile.schedule, new Date()).toISOString();
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
      if (runningProfiles.has(id)) {
        return reply.status(409).send({
          success: false,
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

async function runTick(ctx) {
  if (tickBusy) return;
  tickBusy = true;
  try {
    const profiles = await ctx.collection('profiles').find();
    const now = new Date();
    const catchUpMinutes = Number(ctx.getConfig('catchUpMinutes') ?? 120);

    for (const profile of profiles) {
      if (!profile || profile.enabled === false) continue;
      if (runningProfiles.has(profile.id)) continue;

      const storedNext = profile.nextRunAt ? new Date(profile.nextRunAt) : null;
      if (!storedNext || Number.isNaN(storedNext.getTime())) {
        const computed = nextOccurrence(normalizeSchedule(profile.schedule), now);
        await ctx.collection('profiles').update(
          { id: profile.id },
          { $set: { nextRunAt: computed.toISOString(), updatedAt: now.toISOString() } },
        );
        continue;
      }

      if (storedNext.getTime() > now.getTime()) continue;

      const lateMinutes = (now.getTime() - storedNext.getTime()) / 60000;
      const schedule = normalizeSchedule(profile.schedule);
      const nextAfter = nextOccurrence(schedule, now);

      if (lateMinutes > catchUpMinutes) {
        await ctx.collection('profiles').update(
          { id: profile.id },
          {
            $set: {
              nextRunAt: nextAfter.toISOString(),
              lastSkippedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          },
        );
        ctx.logger.warn(
          { profileId: profile.id, lateMinutes: Math.round(lateMinutes), catchUpMinutes },
          'rust-autowipe: пропуск по окну catch-up, время перенесено',
        );
        continue;
      }

      runningProfiles.add(profile.id);
      try {
        await executeProfileRun(ctx, profile, { trigger: 'schedule' });
      } catch (error) {
        ctx.logger.error(
          { profileId: profile.id, error: message(error) },
          'rust-autowipe: плановый вайп завершился ошибкой',
        );
      } finally {
        runningProfiles.delete(profile.id);
        try {
          await ctx.collection('profiles').update(
            { id: profile.id },
            {
              $set: {
                nextRunAt: nextOccurrence(schedule, new Date()).toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
          );
        } catch (error) {
          ctx.logger.warn(
            { profileId: profile.id, error: message(error) },
            'rust-autowipe: не удалось пересчитать nextRunAt',
          );
        }
      }
    }
  } catch (error) {
    ctx.logger.error({ error: message(error) }, 'rust-autowipe: ошибка планировщика');
  } finally {
    tickBusy = false;
  }
}

const plugin = {
  async onLoad(ctx) {
    registerRoutes(ctx);
    ctx.logger.info('rust-autowipe: маршруты зарегистрированы (server-scoped)');
  },

  async onEnable(ctx) {
    if (ctx.getConfig('schedulerEnabled') === false) {
      ctx.logger.warn('rust-autowipe: планировщик выключен в настройках плагина');
      return;
    }
    ctx.scheduleTask('* * * * *', () => runTick(ctx));
    ctx.logger.info('rust-autowipe: планировщик активен (проверка раз в минуту)');
    // Догоняем пропущенное сразу после включения/старта панели.
    void runTick(ctx);
  },

  async onDisable() {
    runningProfiles.clear();
  },

  async onUnload() {
    runningProfiles.clear();
  },
};

export default plugin;
export { runTick, serverAccess };
