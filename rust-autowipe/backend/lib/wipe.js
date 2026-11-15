/**
 * Выполнение одного вайпа: остановка → раскрытие путей → удаление → запуск.
 *
 * Правила безопасности:
 *  - в режиме проверки (dry-run) сервер не останавливается и файлы не удаляются;
 *  - если сервер был остановлен нами, то при любой ошибке после остановки
 *    выполняется попытка поднять его обратно;
 *  - удаление корня каталога сервера запрещено.
 */

import { createPanelClient } from './api.js';
import { deletePath, expandTargets } from './glob-walk.js';
import { decideMapValues, normalizeMapSettings } from './mapgen.js';
import { newId } from './store.js';
import { nowIso, sleep } from './time.js';

const MAX_DELETED_RECORDED = 500;
const MAX_ERRORS = 50;
const MAX_STEPS = 300;
const FAILED_STATUSES = ['error', 'crashed'];

function statusOf(server) {
  return String(server?.status ?? server?.state ?? '').toLowerCase();
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function loadServer(ctx, serverId) {
  const server = await ctx.db.servers.findUnique({ where: { id: serverId } });
  if (!server) throw new Error('Сервер не найден в панели');
  return server;
}

async function readStatus(ctx, serverId) {
  try {
    const server = await ctx.db.servers.findUnique({ where: { id: serverId } });
    return statusOf(server);
  } catch {
    return '';
  }
}

async function waitForStatus(ctx, serverId, { accept, reject = [], timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let status = await readStatus(ctx, serverId);
  for (;;) {
    if (accept.includes(status)) return { ok: true, status };
    if (reject.includes(status)) {
      return { ok: false, status, detail: `сервер перешёл в статус «${status}»` };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        status,
        detail: `таймаут ${Math.round(timeoutMs / 1000)} с (последний статус: ${status || 'неизвестен'})`,
      };
    }
    await sleep(intervalMs);
    status = await readStatus(ctx, serverId);
  }
}

/**
 * @param {object} ctx контекст плагина
 * @param {object} profile профиль вайпа
 * @param {{trigger?: string, dryRun?: boolean}} options
 * @returns {Promise<object>} запись о прогоне
 */
export async function executeProfileRun(ctx, profile, { trigger = 'manual', dryRun = false } = {}) {
  const startedAt = new Date();
  const dry =
    Boolean(dryRun) ||
    Boolean(profile?.options?.dryRun) ||
    ctx.getConfig('dryRun') === true;

  const stopTimeoutMs = num(ctx.getConfig('stopTimeoutSec'), 300) * 1000;
  const startTimeoutMs = num(ctx.getConfig('startTimeoutSec'), 240) * 1000;

  const steps = [];
  const errors = [];
  const warnings = [];
  const deleted = [];
  const skipped = [];
  const options = profile.options || {};

  // Длительность фазы: каждый шаг отдаёт в интерфейс, сколько он занял.
  let lapAt = Date.now();
  const lap = () => {
    const now = Date.now();
    const ms = now - lapAt;
    lapAt = now;
    return ms;
  };

  const addStep = (action, ok, detail, data) => {
    if (steps.length >= MAX_STEPS) return;
    steps.push({
      at: nowIso(),
      action,
      ok: Boolean(ok),
      detail: detail ?? '',
      data: { ms: lap(), ...(data || {}) },
    });
  };

  let server = null;
  let stoppedByUs = false;
  let startAttempted = false;
  const api = createPanelClient(ctx);

  // Сид/размер решаем заранее: для dry-run это «план», для боевого вайпа —
  // значения, которые уйдут в переменные шаблона после остановки сервера.
  const map = normalizeMapSettings(profile.map, { legacy: !profile.map });
  const mapPlan = decideMapValues(map, profile.mapState || {});
  const mapChanging = mapPlan.seed != null || mapPlan.size != null;
  let appliedSeed = null;
  let appliedSize = null;

  try {
    server = await loadServer(ctx, profile.serverId);
    addStep('server', true, `${server.name} · статус «${statusOf(server) || 'неизвестен'}»`, {
      status: statusOf(server) || null,
    });

    if (!server.uuid || !server.nodeId) {
      throw new Error('У сервера нет uuid/nodeId — панель не отдала данные для файловых операций');
    }

    if (mapChanging && !dry && !api.hasKey) {
      throw new Error(
        'Для смены сида/размера нужен API-ключ панели с правом server.startup (настройки плагина)',
      );
    }

    // ── 1. Остановка ──────────────────────────────────────────────────────
    const status = statusOf(server);
    if (dry) {
      addStep('stop', true, 'режим проверки: сервер не останавливается', {
        status,
        dryRun: true,
      });
    } else if (status === 'stopped') {
      addStep('stop', true, 'сервер уже остановлен', { status: 'stopped' });
    } else if (status === 'suspended') {
      throw new Error('Сервер приостановлен (suspended): вайп отменён');
    } else if (status === 'error' || status === 'crashed') {
      addStep('stop', true, `сервер в статусе «${status}» — процесс уже не работает`, {
        status,
      });
    } else {
      if (!options.stopServer) {
        throw new Error(
          `Сервер в статусе «${status}»: остановка выключена в профиле, а удалять файлы на живом сервере нельзя`,
        );
      }
      if (!api.hasKey) {
        throw new Error(
          'Не задан API-ключ панели: без него нельзя остановить и запустить сервер (настройки плагина)',
        );
      }
      await api.power(server.id, 'stop');
      addStep('stop', true, 'команда остановки отправлена в панель', {
        status: 'stopping',
        timeoutSec: Math.round(stopTimeoutMs / 1000),
      });
      stoppedByUs = true;
      const waited = await waitForStatus(ctx, server.id, {
        accept: ['stopped'],
        reject: FAILED_STATUSES,
        timeoutMs: stopTimeoutMs,
      });
      if (!waited.ok) throw new Error(`Сервер не остановился: ${waited.detail}`);
      addStep('stop', true, 'сервер остановлен', { status: waited.status });
    }

    // ── 1.5. Сид и размер карты ───────────────────────────────────────────
    if (!mapChanging) {
      addStep('map', true, 'сид и размер не меняются', { changed: false });
    } else if (dry) {
      appliedSeed = mapPlan.seed;
      appliedSize = mapPlan.size;
      addStep(
        'map',
        true,
        `режим проверки: было бы задано ${map.vars.seed}=${mapPlan.seed ?? '—'}, ${map.vars.size}=${mapPlan.size ?? '—'}`,
        { changed: true, seed: mapPlan.seed, size: mapPlan.size, dryRun: true },
      );
    } else {
      const values = {};
      if (mapPlan.seed != null) values[map.vars.seed] = String(mapPlan.seed);
      if (mapPlan.size != null) values[map.vars.size] = String(mapPlan.size);
      try {
        await api.patchVariables(server.id, values);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Не удалось записать переменные карты (${Object.keys(values).join(', ')}): ${reason}`,
        );
      }
      appliedSeed = mapPlan.seed;
      appliedSize = mapPlan.size;
      addStep(
        'map',
        true,
        Object.entries(values).map(([key, value]) => `${key}=${value}`).join(', '),
        { changed: true, seed: appliedSeed, size: appliedSize },
      );
    }

    // ── 2. Раскрытие путей ────────────────────────────────────────────────
    const expansion = await expandTargets(ctx, server, profile.targets, profile.excludes);
    if (expansion.truncated) {
      warnings.push(
        'Список путей обрезан лимитом (500 путей / 250 запросов): часть файлов могла не попасть в вайп',
      );
    }
    if (!expansion.paths.length) {
      throw new Error(
        'Ни один путь не найден. Проверьте шаблоны: возможно, сервер ещё не создал файлы или неверна маска',
      );
    }
    addStep('expand', true, `найдено путей: ${expansion.paths.length}`, {
      paths: expansion.paths.length,
      truncated: Boolean(expansion.truncated),
    });

    // ── 3. Удаление ───────────────────────────────────────────────────────
    for (const path of expansion.paths) {
      if (errors.length >= MAX_ERRORS) {
        warnings.push(`Удаление остановлено после ${MAX_ERRORS} ошибок`);
        break;
      }
      if (dry) {
        deleted.push(path);
        continue;
      }
      const result = await deletePath(ctx, server, path);
      if (result.ok && result.missing) {
        skipped.push({ path, reason: 'уже отсутствует' });
      } else if (result.ok) {
        deleted.push(path);
      } else {
        errors.push(`${path}: ${result.error}`);
      }
    }
    addStep(
      'delete',
      errors.length === 0,
      dry
        ? `режим проверки: было бы удалено ${deleted.length} путей`
        : `удалено ${deleted.length}, пропущено ${skipped.length}, ошибок ${errors.length}`,
      {
        deleted: deleted.length,
        skipped: skipped.length,
        errors: errors.length,
        dryRun: dry,
      },
    );

    // ── 4. Запуск ─────────────────────────────────────────────────────────
    if (!options.startServer) {
      addStep('start', true, 'запуск выключен в профиле: поднимите сервер вручную', {
        started: false,
      });
    } else if (dry) {
      addStep('start', true, 'режим проверки: сервер не запускается', { dryRun: true });
    } else {
      startAttempted = true;
      await api.power(server.id, 'start');
      addStep('start', true, 'команда запуска отправлена в панель', {
        status: 'starting',
        timeoutSec: Math.round(startTimeoutMs / 1000),
      });
      const waited = await waitForStatus(ctx, server.id, {
        accept: ['running', 'starting'],
        reject: FAILED_STATUSES,
        timeoutMs: startTimeoutMs,
      });
      if (!waited.ok) throw new Error(`Сервер не запустился: ${waited.detail}`);
      stoppedByUs = false;
      addStep('start', true, `статус «${waited.status}»`, { status: waited.status });

      for (const command of options.commandsAfter || []) {
        try {
          await api.command(server.id, command);
          addStep('command', true, command, { command });
        } catch (error) {
          warnings.push(
            `Команда «${command}» не отправлена: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    addStep('error', false, message, { message });
    ctx.logger.warn({ profileId: profile.id, error: message }, 'rust-autowipe: вайп прерван');

    // Если сервер остановили мы — обязательно пытаемся поднять обратно.
    if (!dry && stoppedByUs && !startAttempted && server && options.startServer !== false) {
      try {
        await api.power(server.id, 'start');
        addStep('restore-start', true, 'сервер запущен после ошибки вайпа', { status: 'starting' });
        stoppedByUs = false;
      } catch (restoreError) {
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(`Не удалось запустить сервер после ошибки: ${restoreMessage}`);
        addStep('restore-start', false, restoreMessage, { message: restoreMessage });
      }
    }
  }

  const finishedAt = new Date();
  const run = {
    id: newId('run'),
    profileId: profile.id,
    profileName: profile.name,
    serverId: profile.serverId,
    serverName: profile.serverName || server?.name || '',
    trigger,
    dryRun: dry,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok: errors.length === 0,
    steps,
    errors: errors.slice(0, MAX_ERRORS),
    warnings: warnings.slice(0, MAX_ERRORS),
    deleted: deleted.slice(0, MAX_DELETED_RECORDED),
    skipped: skipped.slice(0, 200),
    deletedCount: deleted.length,
    seed: appliedSeed,
    size: appliedSize,
  };

  try {
    const runs = ctx.collection('runs');
    await runs.insert(run);
    const recent = await runs.find({}, { sort: { startedAt: -1 }, limit: 400 });
    for (const old of recent.slice(200)) {
      await runs.delete({ _id: old._id });
    }
  } catch (error) {
    ctx.logger.error(
      { error: error instanceof Error ? error.message : error },
      'rust-autowipe: не удалось сохранить прогон',
    );
  }

  try {
    const updates = {
      lastRunAt: run.finishedAt,
      lastRunStatus: run.ok ? 'ok' : 'failed',
      lastRunId: run.id,
      lastError: errors[0] || null,
      updatedAt: run.finishedAt,
    };
    // Курсор ротации двигаем только когда значения реально записаны (не dry-run
    // и PATCH прошёл), иначе следующий вайп повторит тот же сид.
    if (!dry && (appliedSeed != null || appliedSize != null)) {
      if (map.seed.mode === 'rotate' && appliedSeed != null) {
        updates.mapState = { seedCursor: mapPlan.nextCursor };
      }
      updates.lastSeed = appliedSeed;
      updates.lastSize = appliedSize;
    }
    await ctx.collection('profiles').update({ id: profile.id }, { $set: updates });
  } catch (error) {
    ctx.logger.warn(
      { error: error instanceof Error ? error.message : error },
      'rust-autowipe: не удалось обновить профиль после прогона',
    );
  }

  try {
    ctx.emit('rust-autowipe:run-completed', {
      runId: run.id,
      profileId: run.profileId,
      serverId: run.serverId,
      ok: run.ok,
      deleted: run.deletedCount,
    });
  } catch {
    /* событие — не критично */
  }

  ctx.logger.info(
    {
      profileId: run.profileId,
      serverId: run.serverId,
      ok: run.ok,
      deleted: run.deletedCount,
      durationMs: run.durationMs,
      dryRun: dry,
    },
    'rust-autowipe: вайп завершён',
  );

  return run;
}
