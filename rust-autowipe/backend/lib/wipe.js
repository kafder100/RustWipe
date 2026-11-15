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

  const addStep = (action, ok, detail) => {
    if (steps.length >= MAX_STEPS) return;
    steps.push({ at: nowIso(), action, ok: Boolean(ok), detail: detail ?? '' });
  };

  let server = null;
  let stoppedByUs = false;
  let startAttempted = false;
  const api = createPanelClient(ctx);

  try {
    server = await loadServer(ctx, profile.serverId);
    addStep('server', true, `${server.name} · статус «${statusOf(server) || 'неизвестен'}»`);

    if (!server.uuid || !server.nodeId) {
      throw new Error('У сервера нет uuid/nodeId — панель не отдала данные для файловых операций');
    }

    // ── 1. Остановка ──────────────────────────────────────────────────────
    const status = statusOf(server);
    if (dry) {
      addStep('stop', true, 'режим проверки: сервер не останавливается');
    } else if (status === 'stopped') {
      addStep('stop', true, 'сервер уже остановлен');
    } else if (status === 'suspended') {
      throw new Error('Сервер приостановлен (suspended): вайп отменён');
    } else if (status === 'error' || status === 'crashed') {
      addStep('stop', true, `сервер в статусе «${status}» — процесс уже не работает`);
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
      addStep('stop', true, 'команда остановки отправлена в панель');
      stoppedByUs = true;
      const waited = await waitForStatus(ctx, server.id, {
        accept: ['stopped'],
        reject: FAILED_STATUSES,
        timeoutMs: stopTimeoutMs,
      });
      if (!waited.ok) throw new Error(`Сервер не остановился: ${waited.detail}`);
      addStep('stop', true, 'сервер остановлен');
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
    addStep('expand', true, `найдено путей: ${expansion.paths.length}`);

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
    );

    // ── 4. Запуск ─────────────────────────────────────────────────────────
    if (!options.startServer) {
      addStep('start', true, 'запуск выключен в профиле: поднимите сервер вручную');
    } else if (dry) {
      addStep('start', true, 'режим проверки: сервер не запускается');
    } else {
      startAttempted = true;
      await api.power(server.id, 'start');
      addStep('start', true, 'команда запуска отправлена в панель');
      const waited = await waitForStatus(ctx, server.id, {
        accept: ['running', 'starting'],
        reject: FAILED_STATUSES,
        timeoutMs: startTimeoutMs,
      });
      if (!waited.ok) throw new Error(`Сервер не запустился: ${waited.detail}`);
      stoppedByUs = false;
      addStep('start', true, `статус «${waited.status}»`);

      for (const command of options.commandsAfter || []) {
        try {
          await api.command(server.id, command);
          addStep('command', true, command);
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
    addStep('error', false, message);
    ctx.logger.warn({ profileId: profile.id, error: message }, 'rust-autowipe: вайп прерван');

    // Если сервер остановили мы — обязательно пытаемся поднять обратно.
    if (!dry && stoppedByUs && !startAttempted && server && options.startServer !== false) {
      try {
        await api.power(server.id, 'start');
        addStep('restore-start', true, 'сервер запущен после ошибки вайпа');
        stoppedByUs = false;
      } catch (restoreError) {
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError);
        errors.push(`Не удалось запустить сервер после ошибки: ${restoreMessage}`);
        addStep('restore-start', false, restoreMessage);
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
    await ctx.collection('profiles').update(
      { id: profile.id },
      {
        $set: {
          lastRunAt: run.finishedAt,
          lastRunStatus: run.ok ? 'ok' : 'failed',
          lastRunId: run.id,
          lastError: errors[0] || null,
          updatedAt: run.finishedAt,
        },
      },
    );
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
