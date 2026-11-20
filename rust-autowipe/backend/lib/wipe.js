/**
 * Выполнение одного вайпа: остановка → раскрытие путей → смена сида и размера →
 * удаление → запуск.
 *
 * Правила безопасности:
 *  - в режиме проверки (dry-run) сервер не останавливается и файлы не удаляются;
 *  - если раскрытие путей упало, упёрлось в предел или часть найденного
 *    нельзя удалить точно (права 777 — возможно, ссылка; имя, которое панель
 *    изменила бы), ничего не удаляется и карта (сид и размер) не меняется;
 *  - если сервер был остановлен нами, то при любой ошибке после остановки
 *    выполняется попытка поднять его обратно — даже при выключенной галочке
 *    «Запускать сервер после вайпа»: она про запуск после удачного вайпа;
 *  - запись о прогоне появляется в истории в начале вайпа (status: 'running')
 *    и дописывается, когда плагин останавливает сервер, и в конце (не чаще:
 *    каждую запись панель хранит в своём журнале);
 *  - прогон, прерванный падением или перезапуском панели, закрывает
 *    recoverInterruptedRuns, а сервер, который он остановил, поднимает она же
 *    или — если панель ещё не принимала запросы — retryPendingRestores из тика;
 *  - удаление корня каталога сервера запрещено.
 */

import { createPanelClient } from './api.js';
import { isRootMask, normalizePath } from './glob.js';
import { deletePath, expandTargets } from './glob-walk.js';
import { decideMapValues, normalizeMapSettings } from './mapgen.js';
import { newId } from './store.js';
import { nowIso, sleep } from './time.js';

const MAX_DELETED_RECORDED = 500;
const MAX_ERRORS = 50;
const MAX_STEPS = 300;
/** Сколько прогонов хранить в истории каждого сервера. */
const HISTORY_PER_SERVER = 200;
const FAILED_STATUSES = ['error', 'crashed'];
/** Сколько ещё ждать остановки, прежде чем поднимать сервер после ошибки. */
const RESTORE_STOP_WAIT_MS = 60000;
/** Столько удалений подряд без ответа агента — и удаление прекращается. */
const MAX_TIMEOUTS_IN_ROW = 3;
const TIMEOUT_HINTS = /timed out|timeout|таймаут/i;
const INTERRUPTED_REASON =
  'Прогон прерван: панель или плагин перезапустились во время вайпа. Какие файлы успели удалиться и сменился ли сид, в истории не записано';

/**
 * Прогоны, которые идут сейчас в этом процессе панели: id прогона → id сервера.
 * Список хранится в globalThis, а не в модуле: при перезагрузке плагина панель
 * заново импортирует модуль, а прежний прогон ещё работает — его нельзя
 * считать прерванным. При падении процесса список пропадает вместе с ним.
 */
const ACTIVE_RUNS = (globalThis[Symbol.for('rust-autowipe.activeRuns')] ??= new Map());

function statusOf(server) {
  return String(server?.status ?? server?.state ?? '').toLowerCase();
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Запись в коллекцию с повтором: сбой базы панели бывает кратким. */
async function withRetry(action, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(1000 * attempt);
    }
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Понятная причина, когда раскрытие путей упёрлось в предел. */
function limitMessage(limitHit) {
  const names = { listings: 'запросов списка папок', matches: 'путей', depth: 'глубины вложенности' };
  const detail =
    typeof limitHit?.detail === 'string' || typeof limitHit?.detail === 'number'
      ? ` (${limitHit.detail})`
      : '';
  const what = limitHit?.kind
    ? `предел ${names[limitHit.kind] || limitHit.kind}${detail}`
    : 'предел раскрытия (500 путей или 250 запросов списка папок)';
  return `Раскрытие путей упёрлось в ${what}: вайп отменён до удаления, ничего не удалено. Сузьте маски или разделите профиль на несколько`;
}

/** Сколько путей, которые нельзя удалить точно, назвать в причине отказа. */
const SKIPPED_IN_MESSAGE = 10;

/**
 * Понятная причина, когда часть найденного нельзя удалить точно. Пути с
 * одной и той же причиной идут вместе: причина не повторяется 10 раз.
 */
function skippedMessage(skipped) {
  const groups = new Map();
  for (const item of skipped.slice(0, SKIPPED_IN_MESSAGE)) {
    const reason = String(item?.reason ?? '').trim() || 'причина не указана';
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(item?.path);
  }
  const list = [...groups].map(([reason, paths]) => `${paths.join(', ')} — ${reason}`).join('; ');
  const more =
    skipped.length > SKIPPED_IN_MESSAGE
      ? `; и ещё ${skipped.length - SKIPPED_IN_MESSAGE} (список — в предупреждениях прогона)`
      : '';
  return (
    `Вайп отменён до удаления: ${skipped.length} из найденных путей нельзя удалить точно. ` +
    `Ничего не удалено, сид и размер карты не менялись. ${list}${more}. ` +
    'Что сделать: смените права — 644 для файла, 755 для папки — или уберите эти пути из профиля ' +
    '(например, добавьте их в исключения)'
  );
}

/**
 * Цель на всё содержимое корня (/*, /**, /**\/* …) из старого профиля:
 * сохранение такую цель уже не пропустит, а сохранённая раньше осталась.
 * null — такой цели нет.
 */
function rootTargetProblem(targets) {
  for (const raw of Array.isArray(targets) ? targets : []) {
    const target = normalizePath(raw);
    if (target && isRootMask(target)) {
      return `Цель ${raw} охватывает всё содержимое корня каталога сервера — по ней вайп не идёт, сервер не останавливался. Исправьте профиль: укажите конкретные каталоги (например /server/*)`;
    }
  }
  return null;
}

async function loadServer(ctx, serverId) {
  const server = await ctx.db.servers.findUnique({ where: { id: serverId } });
  if (!server) throw new Error('Сервер не найден в панели');
  return server;
}

async function readServer(ctx, serverId) {
  try {
    return await ctx.db.servers.findUnique({ where: { id: serverId } });
  } catch {
    return null;
  }
}

async function readStatus(ctx, serverId) {
  return statusOf(await readServer(ctx, serverId));
}

async function waitForStatus(ctx, serverId, { accept, reject = [], timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs;
  let status = await readStatus(ctx, serverId);
  for (;;) {
    if (accept.includes(status)) return { ok: true, status };
    if (reject.includes(status)) {
      return { ok: false, status, detail: `сервер перешёл в статус ${status}` };
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
 * @param {{trigger?: string, dryRun?: boolean, slot?: string|null}} options
 *   slot — ISO-время планового запуска, для ручного — null
 * @returns {Promise<object>} запись о прогоне
 */
export async function executeProfileRun(
  ctx,
  profile,
  { trigger = 'manual', dryRun = false, slot = null } = {},
) {
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

  /**
   * Ждать, пока сервер станет running. Только это значит «запущен»: в starting
   * сервер ещё загружается, и команды консоли до него не доходят (ответ
   * владельца №8). stopped, error и crashed после запуска — запуск не удался.
   */
  const waitRunning = () =>
    waitForStatus(ctx, server.id, {
      accept: ['running'],
      reject: [...FAILED_STATUSES, 'stopped'],
      timeoutMs: startTimeoutMs,
    });

  /**
   * Поднять сервер, который остановил плагин, когда вайп не удался.
   * Пока панель ещё останавливает сервер (stopping), запуск она отклонит
   * (409), поэтому сначала ждём stopped.
   */
  const restoreServer = async () => {
    try {
      let status = await readStatus(ctx, server.id);
      if (status === 'stopping') {
        const waited = await waitForStatus(ctx, server.id, {
          accept: ['stopped'],
          reject: FAILED_STATUSES,
          timeoutMs: Math.min(stopTimeoutMs, RESTORE_STOP_WAIT_MS),
        });
        status = waited.status;
      }
      if (status === 'running' || status === 'starting') {
        // Остановка так и не началась (например, панель не получила команду).
        addStep('restore-start', true, `сервер в статусе ${status} — запускать не нужно`, { status });
        stoppedByUs = false;
        return;
      }
      await api.power(server.id, 'start');
      stoppedByUs = false;
      const waited = await waitRunning();
      if (!waited.ok) throw new Error(`сервер не дошёл до running: ${waited.detail}`);
      addStep('restore-start', true, 'сервер запущен после ошибки вайпа', { status: waited.status });
    } catch (restoreError) {
      const restoreMessage =
        restoreError instanceof Error ? restoreError.message : String(restoreError);
      errors.push(`Не удалось запустить сервер после ошибки: ${restoreMessage}`);
      addStep('restore-start', false, restoreMessage, { message: restoreMessage });
    }
  };

  // Сид/размер решаем заранее: для dry-run это «план», для боевого вайпа —
  // значения, которые уйдут в переменные шаблона после остановки сервера
  // и раскрытия путей.
  const map = normalizeMapSettings(profile.map, { legacy: !profile.map });
  const mapPlan = decideMapValues(map, profile.mapState || {});
  const mapChanging = mapPlan.seed != null || mapPlan.size != null;
  let appliedSeed = null;
  let appliedSize = null;

  // ── Запись о прогоне ─────────────────────────────────────────────────
  // Появляется в истории сразу (status: 'running'), дописывается, когда
  // плагин останавливает сервер (stoppedByUs), и в конце: если панель упадёт
  // посреди вайпа, след останется. Чаще не пишем: панель хранит каждый
  // вызов коллекции вместе с данными в своём журнале, и он растёт.
  const runs = ctx.collection('runs');
  const run = {
    id: newId('run'),
    profileId: profile.id,
    profileName: profile.name,
    serverId: profile.serverId,
    serverName: profile.serverName || '',
    slot: slot ?? null,
    trigger,
    dryRun: dry,
    status: 'running',
    startedAt: startedAt.toISOString(),
    stoppedByUs: false,
  };
  // Что уже сделано — для записи в историю.
  const progress = () => ({
    serverName: profile.serverName || server?.name || '',
    stoppedByUs: run.stoppedByUs,
    steps: [...steps],
    errors: errors.slice(0, MAX_ERRORS),
    warnings: warnings.slice(0, MAX_ERRORS),
    deleted: deleted.slice(0, MAX_DELETED_RECORDED),
    skipped: skipped.slice(0, 200),
    deletedCount: deleted.length,
    seed: appliedSeed,
    size: appliedSize,
  });
  /** Дописать запись о прогоне. Сбой — только в журнал: из-за истории вайп не прерывается. */
  const saveRun = async (fields) => {
    try {
      await withRetry(() => runs.update({ id: run.id }, { $set: fields }));
    } catch (error) {
      ctx.logger.warn(
        { runId: run.id, error: errorText(error) },
        'rust-autowipe: не удалось обновить запись о прогоне',
      );
    }
  };

  let recorded = false;
  let recordError = '';
  try {
    await withRetry(() => runs.insert({ ...run, ...progress() }));
    recorded = true;
    ACTIVE_RUNS.set(run.id, run.serverId);
  } catch (error) {
    recordError = errorText(error);
    ctx.logger.error(
      { profileId: profile.id, error: recordError },
      'rust-autowipe: не удалось записать начало прогона',
    );
  }

  try {
    // Без записи в истории вайп не начинаем: если панель упадёт посреди
    // вайпа, не останется следа, и остановленный сервер никто не поднимет.
    if (!recorded) {
      throw new Error(
        `Не удалось записать начало прогона в историю (${recordError}): вайп не начат, сервер не тронут`,
      );
    }

    server = await loadServer(ctx, profile.serverId);
    addStep('server', true, `${server.name} · статус ${statusOf(server) || 'неизвестен'}`, {
      status: statusOf(server) || null,
    });

    // Приостановку проверяем по suspendedAt, как роуты плагина и сама панель:
    // после «В архив» → «Из архива» статус уже не suspended, а приостановка стоит.
    if (server.suspendedAt || statusOf(server) === 'suspended') {
      throw new Error('Сервер приостановлен в панели: вайп отменён');
    }

    if (!server.uuid || !server.nodeId) {
      throw new Error('У сервера нет uuid/nodeId — панель не отдала данные для файловых операций');
    }

    if (mapChanging && !dry && !api.hasKey) {
      throw new Error(
        'Для смены сида/размера нужен API-ключ панели с правом server.startup (настройки плагина)',
      );
    }

    // Цель на весь корень — отказ до остановки: иначе старый профиль с такой
    // целью при каждом запуске останавливал бы сервер только ради отказа.
    const rootProblem = rootTargetProblem(profile.targets);
    if (rootProblem) throw new Error(rootProblem);

    // ── 1. Остановка ──────────────────────────────────────────────────────
    const status = statusOf(server);
    if (dry) {
      addStep('stop', true, 'режим проверки: сервер не останавливается', {
        status,
        dryRun: true,
      });
    } else if (status === 'stopped') {
      addStep('stop', true, 'сервер уже остановлен', { status: 'stopped' });
    } else if (status === 'error' || status === 'crashed') {
      addStep('stop', true, `сервер в статусе ${status} — процесс уже не работает`, {
        status,
      });
    } else {
      if (!options.stopServer) {
        throw new Error(
          `Сервер в статусе ${status}: остановка выключена в профиле, а удалять файлы на живом сервере нельзя`,
        );
      }
      if (!api.hasKey) {
        throw new Error(
          'Не задан API-ключ панели: без него нельзя остановить и запустить сервер (настройки плагина)',
        );
      }
      // Отмечаем до запроса: если ответ панели не дойдёт, сервер всё равно
      // может остановиться — тогда его нужно поднять обратно. Отметка идёт
      // и в историю: после падения панели по ней сервер поднимет
      // recoverInterruptedRuns.
      stoppedByUs = true;
      run.stoppedByUs = true;
      await saveRun(progress());
      try {
        await api.power(server.id, 'stop');
        addStep('stop', true, 'команда остановки отправлена в панель', {
          status: 'stopping',
          timeoutSec: Math.round(stopTimeoutMs / 1000),
        });
      } catch (error) {
        // Панель отказала или недоступна — остановка не началась.
        if (!error?.timedOut) {
          stoppedByUs = false;
          run.stoppedByUs = false;
          throw error;
        }
        // Ответа нет, но команда могла дойти: итог смотрим по статусу сервера.
        addStep('stop', true, `панель не ответила вовремя (${error.message}): ждём остановку по статусу`, {
          status: (await readStatus(ctx, server.id)) || null,
          timeoutSec: Math.round(stopTimeoutMs / 1000),
        });
      }
      const waited = await waitForStatus(ctx, server.id, {
        accept: ['stopped'],
        reject: FAILED_STATUSES,
        timeoutMs: stopTimeoutMs,
      });
      if (!waited.ok) throw new Error(`Сервер не остановился: ${waited.detail}`);
      addStep('stop', true, 'сервер остановлен', { status: waited.status });
    }

    // ── 2. Раскрытие путей ────────────────────────────────────────────────
    // Раскрываем до смены сида и размера: если раскрытие упало или упёрлось
    // в предел, вайп отменяется до удаления, а сервер поднимается с прежней картой.
    const expansion = await expandTargets(ctx, server, profile.targets, profile.excludes);
    const notExact = Array.isArray(expansion.skipped) ? expansion.skipped : [];
    for (const item of notExact) {
      warnings.push(`Пропущен путь ${item.path}: ${item.reason}`);
    }
    if (expansion.truncated) {
      // Неполный список путей — это половина вайпа. Лучше не удалять ничего.
      throw new Error(limitMessage(expansion.limitHit));
    }
    // Часть выбранного нельзя удалить точно (права 777 — возможно, ссылка;
    // имя, которое панель изменила бы). Ответ владельца №3 — «строго
    // выбранные файлы»: лучше не вайпать вовсе, чем вайпнуть наполовину.
    if (notExact.length) throw new Error(skippedMessage(notExact));
    addStep('expand', expansion.paths.length > 0, `найдено путей: ${expansion.paths.length}`, {
      paths: expansion.paths.length,
      truncated: false,
    });

    // ── 3. Сид и размер карты ─────────────────────────────────────────────
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

    // Удалять нечего: сид и размер всё равно сменились (так решил владелец),
    // но прогон — ошибка, и сервер поднимается обратно.
    if (!expansion.paths.length) {
      throw new Error(
        'Ни один путь не найден. Проверьте шаблоны: возможно, сервер ещё не создал файлы или неверна маска',
      );
    }

    // ── 4. Удаление ───────────────────────────────────────────────────────
    let timeoutsInRow = 0;
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
        timeoutsInRow = 0;
      } else if (result.ok) {
        deleted.push(path);
        timeoutsInRow = 0;
      } else {
        errors.push(`${path}: ${result.error}`);
        // Агент не отвечает: панель снимает каждый запрос только через 60 с.
        // Не ждём так все пути — прекращаем удаление, сервер поднимается.
        timeoutsInRow = TIMEOUT_HINTS.test(String(result.error)) ? timeoutsInRow + 1 : 0;
        if (timeoutsInRow >= MAX_TIMEOUTS_IN_ROW) {
          errors.push(
            `Агент не отвечает: ${MAX_TIMEOUTS_IN_ROW} удаления подряд без ответа — удаление остановлено`,
          );
          break;
        }
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

    // ── 5. Запуск ─────────────────────────────────────────────────────────
    if (!options.startServer) {
      if (stoppedByUs && errors.length) {
        // Удаление с ошибками — вайп не удался: сервер, который остановил
        // плагин, поднимаем обратно и при выключенном запуске.
        await restoreServer();
      } else {
        addStep('start', true, 'запуск выключен в профиле: поднимите сервер вручную', {
          started: false,
        });
      }
    } else if (dry) {
      addStep('start', true, 'режим проверки: сервер не запускается', { dryRun: true });
    } else {
      startAttempted = true;
      await api.power(server.id, 'start');
      addStep('start', true, 'команда запуска отправлена в панель', {
        status: 'starting',
        timeoutSec: Math.round(startTimeoutMs / 1000),
      });
      // Команды после запуска уходят только после running (ответ владельца №8).
      const waited = await waitRunning();
      if (!waited.ok) throw new Error(`Сервер не дошёл до running: ${waited.detail}`);
      stoppedByUs = false;
      addStep('start', true, `статус ${waited.status}`, { status: waited.status });

      for (const command of options.commandsAfter || []) {
        try {
          await api.command(server.id, command);
          addStep('command', true, command, { command });
        } catch (error) {
          warnings.push(
            `Команда ${command} не отправлена: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    addStep('error', false, message, { message });
    ctx.logger.warn({ profileId: profile.id, error: message }, 'rust-autowipe: вайп прерван');

    // Если сервер остановили мы — обязательно пытаемся поднять обратно, даже
    // при выключенном запуске в профиле: вайп не удался.
    if (!dry && stoppedByUs && !startAttempted && server) {
      await restoreServer();
    }
  }

  const finishedAt = new Date();
  Object.assign(run, {
    status: errors.length === 0 ? 'ok' : 'failed',
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ok: errors.length === 0,
    ...progress(),
  });

  if (recorded) {
    await saveRun(run);
  } else {
    // Начало прогона записать не удалось — пробуем записать итог ещё раз.
    try {
      await withRetry(() => runs.insert(run));
    } catch (error) {
      ctx.logger.error({ error: errorText(error) }, 'rust-autowipe: не удалось сохранить прогон');
    }
  }
  ACTIVE_RUNS.delete(run.id);

  // История — не больше HISTORY_PER_SERVER прогонов на каждый сервер:
  // прогоны одного сервера не вытесняют историю других (ответ владельца №14).
  // Без serverId фильтр совпал бы со всеми записями — тогда не обрезаем.
  if (run.serverId) {
    try {
      const recent = await runs.find(
        { serverId: run.serverId },
        { sort: { startedAt: -1 }, limit: HISTORY_PER_SERVER * 2 },
      );
      for (const old of recent.slice(HISTORY_PER_SERVER)) {
        await runs.delete({ _id: old._id });
      }
    } catch (error) {
      ctx.logger.error({ error: errorText(error) }, 'rust-autowipe: не удалось обрезать историю прогонов');
    }
  }

  try {
    // Без id фильтр { id: undefined } в хранилище панели совпал бы со всеми
    // профилями всех серверов — такой профиль не обновляем.
    if (typeof profile.id !== 'string' || !profile.id) {
      throw new Error('у профиля нет id — итог прогона в профиль не записан');
    }
    // Итог проверки (dry-run) — в свои поля lastCheck*: проверка не затирает
    // итог настоящего вайпа (например, ночную ошибку).
    // updatedAt не трогаем: это версия профиля для редактора (PUT сверяет её
    // с expectedUpdatedAt), её меняет только правка профиля человеком. Иначе
    // открытый редактор после вайпа получал ложный конфликт «Профиль изменён».
    const updates = dry
      ? {
          lastCheckAt: run.finishedAt,
          lastCheckStatus: run.ok ? 'ok' : 'failed',
          lastCheckId: run.id,
          lastCheckError: errors[0] || null,
        }
      : {
          lastRunAt: run.finishedAt,
          lastRunStatus: run.ok ? 'ok' : 'failed',
          lastRunId: run.id,
          lastError: errors[0] || null,
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
    // С повтором: если эта запись пропадёт, сид уже стоит в переменных
    // сервера, а курсор ротации прежний — следующий вайп повторил бы сид.
    await withRetry(() => ctx.collection('profiles').update({ id: profile.id }, { $set: updates }));
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
      // Для проверки deleted — сколько было бы удалено.
      dryRun: dry,
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

/** Шаг для записи о прерванном прогоне — в том же виде, что и шаги вайпа. */
function recoveryStep(action, ok, detail, data) {
  return { at: nowIso(), action, ok, detail, data: { ms: 0, ...(data || {}) } };
}

/** Сколько после падения панели пробовать поднять сервер, который остановил прерванный вайп. */
const RESTORE_RETRY_MS = 60 * 60000;
/** Сколько попыток запуска всего (первая — при включении плагина). */
const RESTORE_RETRY_ATTEMPTS = 30;

/**
 * Могут ли в истории быть прогоны, которые ждут запуска сервера
 * (restorePending). Пока их нет, retryPendingRestores не читает историю
 * каждую минуту: каждый вызов коллекции панель пишет в свой журнал. После
 * загрузки модуля база читается один раз — пометку мог оставить прежний
 * экземпляр плагина.
 */
let restoresMayBePending = true;
/** retryPendingRestores ещё идёт (прежний тик ждёт ответа панели) — второй вызов ждать не должен. */
let restoreRetryBusy = false;

/** Идёт ли сейчас в этом процессе вайп на этом сервере. */
function serverBusy(serverId) {
  return [...ACTIVE_RUNS.values()].includes(serverId);
}

/**
 * Закрыть прогоны, которые остались в истории со status 'running' после
 * падения или перезапуска панели: пометить их 'interrupted' с причиной.
 * Если такой прогон остановил сервер (stoppedByUs), а сервер так и стоит
 * (stopped), — запустить его и записать это в прогон. Если запуск не удался
 * или панель не ответила (при включении плагинов она ещё не принимает
 * запросы), прогон получает пометку restorePending — запуск повторит
 * retryPendingRestores из тика.
 *
 * Прогоны, которые идут прямо сейчас в этом процессе (например, плагин
 * перезагрузили посреди вайпа), не трогаются. Вызывать при включении
 * плагина, до первого тика планировщика.
 *
 * @returns {Promise<{interrupted: number, started: number}>}
 */
export async function recoverInterruptedRuns(ctx) {
  const result = { interrupted: 0, started: 0 };
  const runs = ctx.collection('runs');
  let stale;
  try {
    stale = await runs.find({ status: 'running' });
  } catch (error) {
    ctx.logger.warn(
      { error: errorText(error) },
      'rust-autowipe: не удалось прочитать незавершённые прогоны',
    );
    return result;
  }

  const busyServers = new Set(ACTIVE_RUNS.values());
  for (const run of stale || []) {
    if (!run || typeof run.id !== 'string' || !run.id || ACTIVE_RUNS.has(run.id)) continue;
    const steps = Array.isArray(run.steps) ? [...run.steps] : [];
    const errors = Array.isArray(run.errors) ? [...run.errors] : [];
    errors.push(INTERRUPTED_REASON);
    steps.push(recoveryStep('error', false, INTERRUPTED_REASON, { message: INTERRUPTED_REASON }));
    let restorePending = null;

    // Сервер остановил прерванный прогон — поднимаем, если он так и стоит.
    if (run.stoppedByUs && !run.dryRun) {
      const server = await readServer(ctx, run.serverId);
      const status = statusOf(server);
      let skip = null;
      if (busyServers.has(run.serverId)) skip = 'на сервере идёт другой вайп — не запускаем';
      else if (server?.suspendedAt) skip = 'сервер приостановлен в панели — не запускаем';
      else if (status !== 'stopped') skip = `сервер в статусе ${status || 'неизвестен'} — запускать не нужно`;
      if (skip) {
        steps.push(recoveryStep('restore-start', true, skip, { status: status || null }));
      } else {
        try {
          await createPanelClient(ctx).power(run.serverId, 'start');
          // Не ждём running: восстановление идёт при включении плагина.
          steps.push(
            recoveryStep('restore-start', true, 'после прерванного вайпа отправлена команда запуска', {
              status: 'starting',
            }),
          );
          result.started += 1;
        } catch (error) {
          // Панель ещё не принимает запросы или агент ноды не подключился:
          // одной попытки при включении плагина мало — повторит тик.
          const message = errorText(error);
          restorePending = { since: nowIso(), attempts: 1, lastError: message };
          steps.push(
            recoveryStep(
              'restore-start',
              false,
              `${message}. Запуск повторится раз в минуту, пока сервер остановлен (не дольше ${RESTORE_RETRY_MS / 60000} мин)`,
              { message },
            ),
          );
        }
      }
    }

    const finishedAt = new Date();
    const startedMs = Date.parse(run.startedAt);
    const patch = {
      status: 'interrupted',
      ok: false,
      finishedAt: finishedAt.toISOString(),
      durationMs: Number.isFinite(startedMs) ? finishedAt.getTime() - startedMs : null,
      steps,
      errors,
      // Сервер ещё надо поднять: время пометки, число попыток, последняя ошибка.
      ...(restorePending ? { restorePending } : {}),
    };
    try {
      await withRetry(() => runs.update({ id: run.id }, { $set: patch }));
      result.interrupted += 1;
      if (restorePending) restoresMayBePending = true;
    } catch (error) {
      ctx.logger.warn(
        { runId: run.id, error: errorText(error) },
        'rust-autowipe: не удалось закрыть прерванный прогон',
      );
      continue;
    }
    await noteInterruptedInProfile(ctx, run, patch.finishedAt);
    ctx.logger.warn(
      { runId: run.id, profileId: run.profileId, serverId: run.serverId },
      'rust-autowipe: прогон закрыт как прерванный',
    );
  }
  return result;
}

/**
 * Повторить запуск серверов, которые остановил прерванный вайп, а поднять
 * при включении плагина не вышло (пометка restorePending в записи прогона).
 * Панель включает плагины до того, как начинает принимать запросы, а агенты
 * ещё не подключены, — поэтому одной попытки мало. Вызывает тик раз в минуту.
 *
 * Запуск пробуется, только пока сервер stopped, не приостановлен и на нём не
 * идёт вайп. Команда принята — шаг в записи прогона, пометка снимается.
 * Сервер уже работает (его запустили вручную) — пометка снимается без
 * попытки. Через 60 минут после пометки или после 30 попыток — отказ: в
 * записи причина, сервер надо запустить вручную.
 *
 * @param {object} ctx контекст плагина
 * @param {Date} [now] время тика
 * @returns {Promise<{started: number, waiting: number, failed: number}>}
 */
export async function retryPendingRestores(ctx, now = new Date()) {
  const result = { started: 0, waiting: 0, failed: 0 };
  if (!restoresMayBePending || restoreRetryBusy) return result;
  restoreRetryBusy = true;
  try {
    let pending;
    try {
      const rows = await ctx.collection('runs').find({ status: 'interrupted' });
      pending = (rows || []).filter((run) => run?.restorePending && typeof run.id === 'string' && run.id);
    } catch (error) {
      ctx.logger.warn(
        { error: errorText(error) },
        'rust-autowipe: не удалось прочитать прогоны, после которых сервер ждёт запуска',
      );
      return result;
    }
    if (!pending.length) {
      restoresMayBePending = false;
      return result;
    }
    const parsed = new Date(now).getTime();
    const nowMs = Number.isFinite(parsed) ? parsed : Date.now();
    for (const run of pending) {
      try {
        const outcome = await retryRestore(ctx, run, nowMs);
        if (outcome in result) result[outcome] += 1;
      } catch (error) {
        // Сбой одной записи не мешает остальным; попробуем на следующем тике.
        ctx.logger.warn(
          { runId: run.id, error: errorText(error) },
          'rust-autowipe: не удалось повторить запуск сервера после прерванного вайпа',
        );
      }
    }
    return result;
  } finally {
    restoreRetryBusy = false;
  }
}

/** Одна попытка для одного прогона: 'started', 'waiting', 'failed' или 'done' (запуск не нужен). */
async function retryRestore(ctx, run, nowMs) {
  const state = run.restorePending || {};
  const attempts = Number(state.attempts) || 0;
  const sinceMs = Date.parse(state.since);
  const server = await readServer(ctx, run.serverId);
  const status = statusOf(server);
  const note = (ok, detail, data) => recoveryStep('restore-start', ok, detail, data);

  // Сервер уже работает: его запустили вручную или он поднялся сам.
  if (status === 'running' || status === 'starting') {
    await closeRestore(ctx, run, note(true, `сервер в статусе ${status} — запускать больше не нужно`, { status }));
    return 'done';
  }
  if (server?.suspendedAt) {
    await closeRestore(ctx, run, note(true, 'сервер приостановлен в панели — не запускаем', { status: status || null }));
    return 'done';
  }
  const giveUp = (tries, lastError) => {
    const minutes = Math.round((nowMs - sinceMs) / 60000);
    const reason =
      `Сервер так и не запущен после прерванного вайпа: попыток ${tries}` +
      `${Number.isFinite(minutes) ? ` за ${minutes} мин` : ''}, статус сервера — ${status || 'неизвестен'}` +
      `${lastError ? `, последняя ошибка: ${lastError}` : ''}. Запустите сервер вручную`;
    ctx.logger.warn(
      { runId: run.id, serverId: run.serverId },
      'rust-autowipe: сервер после прерванного вайпа так и не запущен',
    );
    return closeRestore(ctx, run, note(false, reason, { message: reason }), reason);
  };
  const expired = !Number.isFinite(sinceMs) || nowMs - sinceMs >= RESTORE_RETRY_MS;
  if (expired || attempts >= RESTORE_RETRY_ATTEMPTS) {
    await giveUp(attempts, state.lastError);
    return 'failed';
  }
  // Запускаем только остановленный сервер, на котором не идёт вайп.
  if (status !== 'stopped' || serverBusy(run.serverId)) return 'waiting';

  try {
    await createPanelClient(ctx).power(run.serverId, 'start');
  } catch (error) {
    const lastError = errorText(error);
    if (attempts + 1 >= RESTORE_RETRY_ATTEMPTS) {
      await giveUp(attempts + 1, lastError);
      return 'failed';
    }
    // Записываем только саму пометку: запись прогона целиком не переписываем.
    const next = { ...state, attempts: attempts + 1, lastError };
    await withRetry(() => ctx.collection('runs').update({ id: run.id }, { $set: { restorePending: next } }));
    return 'waiting';
  }
  await closeRestore(
    ctx,
    run,
    note(true, `после прерванного вайпа отправлена команда запуска (попытка ${attempts + 1})`, { status: 'starting' }),
  );
  ctx.logger.info({ runId: run.id, serverId: run.serverId }, 'rust-autowipe: сервер после прерванного вайпа запущен');
  return 'started';
}

/** Снять пометку restorePending: шаг (и причина отказа) — в запись прогона. */
async function closeRestore(ctx, run, step, error = null) {
  const steps = [...(Array.isArray(run.steps) ? run.steps : []), step];
  const errors = [...(Array.isArray(run.errors) ? run.errors : []), ...(error ? [error] : [])];
  await withRetry(() =>
    ctx.collection('runs').update({ id: run.id }, { $set: { steps, errors, restorePending: null } }),
  );
}

/** Итог прерванного прогона — в профиль, если там нет итога новее. */
async function noteInterruptedInProfile(ctx, run, finishedAt) {
  // Пустой id в фильтре совпал бы со всеми профилями.
  if (typeof run.profileId !== 'string' || !run.profileId) return;
  try {
    const profiles = ctx.collection('profiles');
    const profile = await profiles.findOne({ id: run.profileId });
    if (!profile) return;
    // Проверка (dry-run) — в поля lastCheck*, настоящий вайп — в lastRun*.
    const lastAt = run.dryRun ? profile.lastCheckAt : profile.lastRunAt;
    if (lastAt && String(lastAt) > String(run.startedAt)) return;
    const updates = run.dryRun
      ? {
          lastCheckAt: finishedAt,
          lastCheckStatus: 'failed',
          lastCheckId: run.id,
          lastCheckError: INTERRUPTED_REASON,
        }
      : {
          lastRunAt: finishedAt,
          lastRunStatus: 'failed',
          lastRunId: run.id,
          lastError: INTERRUPTED_REASON,
        };
    await withRetry(() => profiles.update({ id: run.profileId }, { $set: updates }));
  } catch (error) {
    ctx.logger.warn(
      { runId: run.id, error: errorText(error) },
      'rust-autowipe: не удалось записать прерванный прогон в профиль',
    );
  }
}
