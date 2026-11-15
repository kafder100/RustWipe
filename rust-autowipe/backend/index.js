/**
 * Rust AutoWipe — backend-энтри плагина Catalyst.
 *
 * Возможности:
 *  - профили вайпа: сервер + расписание + список путей/шаблонов;
 *  - планировщик: ctx.scheduleTask('* * * * *'), состояние в коллекциях;
 *  - ручной запуск и предпросмотр («что будет удалено»);
 *  - история прогонов.
 *
 * Роуты монтируются под /api/plugins/rust-autowipe/…
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

/**
 * Регистрирует роут с двумя уровнями проверки:
 *  - config.requiredPermissions — хост проверяет права вызывающего до нашего кода;
 *  - preHandler — та же проверка через ctx.requirePermission (мягкий отказ 403).
 */
function register(ctx, method, url, handler, { permission } = {}) {
  const options = {
    method,
    url,
    handler: wrap(ctx, handler),
  };
  if (permission) {
    options.config = { requiredPermissions: [permission] };
    if (typeof ctx.requirePermission === 'function') {
      options.preHandler = ctx.requirePermission(permission);
    }
  }
  ctx.registerRoute(options);
}

async function loadServerOrNull(ctx, serverId) {
  if (!serverId) return null;
  try {
    return await ctx.db.servers.findUnique({ where: { id: serverId } });
  } catch (error) {
    ctx.logger.warn({ error: message(error) }, 'rust-autowipe: не удалось прочитать сервер');
    return null;
  }
}

async function collectProfiles(ctx) {
  const profiles = await ctx.collection('profiles').find();
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
  register(
    ctx,
    'GET',
    '/status',
    async (request) => {
      const canManage =
        typeof ctx.hasPermission === 'function' ? ctx.hasPermission(request, MANAGE) : false;
      const canRun =
        typeof ctx.hasPermission === 'function' ? ctx.hasPermission(request, RUN) : false;
      return {
        success: true,
        data: {
          version: ctx.manifest.version,
          clock: serverClock(),
          panelUrl: resolvePanelBase(ctx),
          hasApiKey: Boolean(String(ctx.getConfig('apiKey') ?? '').trim()),
          dryRun: ctx.getConfig('dryRun') === true,
          schedulerEnabled: ctx.getConfig('schedulerEnabled') !== false,
          catchUpMinutes: Number(ctx.getConfig('catchUpMinutes') ?? 120),
          stopTimeoutSec: Number(ctx.getConfig('stopTimeoutSec') ?? 300),
          startTimeoutSec: Number(ctx.getConfig('startTimeoutSec') ?? 240),
          running: [...runningProfiles],
          permissions: { canManage, canRun },
        },
      };
    },
    { permission: VIEW },
  );

  register(
    ctx,
    'POST',
    '/panel-check',
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
    { permission: VIEW },
  );

  register(
    ctx,
    'GET',
    '/servers',
    async () => {
      const servers = await ctx.db.servers.findMany({
        select: { id: true, name: true, uuid: true, nodeId: true, status: true },
        orderBy: { name: 'asc' },
      });
      return {
        success: true,
        data: servers.map((server) => ({
          id: server.id,
          name: server.name,
          uuid: server.uuid,
          nodeId: server.nodeId,
          status: server.status,
        })),
      };
    },
    { permission: VIEW },
  );

  register(
    ctx,
    'GET',
    '/files',
    async (request, reply) => {
      const server = await loadServerOrNull(ctx, String(request.query?.serverId ?? ''));
      if (!server) {
        return reply.status(404).send({ success: false, error: 'Сервер не найден' });
      }
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
    { permission: VIEW },
  );

  register(
    ctx,
    'GET',
    '/presets',
    async () => ({ success: true, data: PRESETS }),
    { permission: VIEW },
  );

  register(
    ctx,
    'GET',
    '/profiles',
    async () => ({ success: true, data: await collectProfiles(ctx) }),
    { permission: VIEW },
  );

  register(
    ctx,
    'POST',
    '/profiles',
    async (request, reply) => {
      const { errors, profile } = await buildProfile(ctx, request.body);
      if (errors.length) {
        return reply.status(400).send({ success: false, error: errors.join('; '), errors });
      }
      profile.nextRunAt = nextOccurrence(profile.schedule, new Date()).toISOString();
      await ctx.collection('profiles').insert(profile);
      ctx.logger.info(
        { id: profile.id, serverId: profile.serverId },
        'rust-autowipe: профиль создан',
      );
      return { success: true, data: publicProfile(profile) };
    },
    { permission: MANAGE },
  );

  register(
    ctx,
    'PUT',
    '/profiles/:id',
    async (request, reply) => {
      const id = String(request.params?.id ?? '');
      const existing = await ctx.collection('profiles').findOne({ id });
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден' });
      }
      const { errors, profile } = await buildProfile(ctx, request.body, existing);
      if (errors.length) {
        return reply.status(400).send({ success: false, error: errors.join('; '), errors });
      }
      profile.nextRunAt = nextOccurrence(profile.schedule, new Date()).toISOString();
      await ctx.collection('profiles').update({ id }, { $set: profile });
      ctx.logger.info({ id }, 'rust-autowipe: профиль обновлён');
      return { success: true, data: publicProfile(profile) };
    },
    { permission: MANAGE },
  );

  register(
    ctx,
    'DELETE',
    '/profiles/:id',
    async (request, reply) => {
      const id = String(request.params?.id ?? '');
      if (runningProfiles.has(id)) {
        return reply.status(409).send({
          success: false,
          error: 'Профиль выполняется — дождитесь окончания',
        });
      }
      const removed = await ctx.collection('profiles').delete({ id });
      ctx.logger.info({ id, removed }, 'rust-autowipe: профиль удалён');
      return { success: true, data: { removed } };
    },
    { permission: MANAGE },
  );

  register(
    ctx,
    'POST',
    '/profiles/:id/run',
    async (request, reply) => {
      const id = String(request.params?.id ?? '');
      const profile = await ctx.collection('profiles').findOne({ id });
      if (!profile) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден' });
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
    { permission: RUN },
  );

  register(
    ctx,
    'POST',
    '/profiles/:id/preview',
    async (request, reply) => {
      const id = String(request.params?.id ?? '');
      const profile = await ctx.collection('profiles').findOne({ id });
      if (!profile) {
        return reply.status(404).send({ success: false, error: 'Профиль не найден' });
      }
      const server = await loadServerOrNull(ctx, profile.serverId);
      if (!server) {
        return reply.status(404).send({ success: false, error: 'Сервер профиля не найден' });
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
    { permission: VIEW },
  );

  register(
    ctx,
    'GET',
    '/runs',
    async (request) => {
      const limit = Math.min(200, Math.max(1, Number(request.query?.limit) || 50));
      const profileId = request.query?.profileId ? String(request.query.profileId) : null;
      const runs = await ctx.collection('runs').find(
        profileId ? { profileId } : {},
        { sort: { startedAt: -1 }, limit },
      );
      return { success: true, data: runs };
    },
    { permission: VIEW },
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
    ctx.logger.info('rust-autowipe: маршруты зарегистрированы');
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
export { runTick };
