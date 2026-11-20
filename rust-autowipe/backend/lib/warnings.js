/**
 * Предупреждения в чате сервера перед плановым вайпом.
 *
 * Планировщик тикает раз в минуту, поэтому предупреждение отправляется один раз
 * на каждую «минуту до вайпа»: 5, 4, 3, 2, 1. Отправленные отметки хранятся в
 * профиле по ключу ближайшего запуска (nextRunAt), чтобы панель не дублировала
 * сообщения и не повторяла их после перезапуска.
 *
 * Перед проверочным прогоном (dry-run профиля или глобальный dryRun) отсчёт не
 * отправляется: вайпа не будет, а игроки бы его ждали.
 */

import { createPanelClient } from './api.js';

const STORE_KEY = 'warnedRuns';
const MAX_TRACKED_RUNS = 5;
// Последняя попытка отправки — по каждому серверу: { [serverId]: состояние }.
const STATE_KEY = 'wipeWarningStateByServer';
// До этой версии здесь хранилось одно состояние на весь плагин. Его читаем
// (для его сервера), но не трогаем: при откате старая версия читает его как раньше.
const LEGACY_STATE_KEY = 'wipeWarningState';
// Записей не больше, чем серверов на большой панели; самые старые уходят.
const MAX_SERVER_STATES = 500;

/** Последняя попытка отправки по серверам — чтобы показать её во вкладке сервера. */
const states = new Map();
/** Чтение хранилища: из какого контекста и промис, который его ждёт. */
let loading = null;

/** Ключ сервера; без сервера — пустая строка (так записывают только тесты). */
function serverKey(serverId) {
  return serverId === undefined || serverId === null ? '' : String(serverId);
}

/** Последняя попытка отправки на этом сервере или null. Чужие серверы не видны. */
export function getWarningState(serverId) {
  return states.get(serverKey(serverId)) ?? null;
}

/** Прочитать состояние из хранилища. Свежее состояние в памяти главнее. */
export function loadWarningState(ctx) {
  loading = { ctx, promise: readStates(ctx) };
  return loading.promise;
}

async function readStates(ctx) {
  let stored = null;
  try {
    stored = await ctx.getStorage(STATE_KEY);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      const legacy = await ctx.getStorage(LEGACY_STATE_KEY);
      stored = legacy && typeof legacy === 'object' && legacy.serverId ? { [legacy.serverId]: legacy } : null;
    }
  } catch {
    /* хранилище может быть недоступно — не критично */
  }
  for (const [serverId, state] of Object.entries(stored || {})) {
    if (state && typeof state === 'object' && !states.has(serverId)) states.set(serverId, state);
  }
  return Object.fromEntries(states);
}

async function rememberState(ctx, state) {
  // Без загрузки запись затёрла бы в хранилище состояние других серверов.
  if (loading?.ctx !== ctx) loadWarningState(ctx);
  await loading.promise;
  const key = serverKey(state?.serverId);
  states.delete(key);
  states.set(key, state);
  while (states.size > MAX_SERVER_STATES) states.delete(states.keys().next().value);
  try {
    await ctx.setStorage(STATE_KEY, Object.fromEntries(states));
  } catch {
    /* без сохранения состояние проживёт до перезапуска панели */
  }
}

/** Записать состояние отправки извне модуля (например, из тестового роута). */
export async function recordWarningState(ctx, state) {
  await rememberState(ctx, state);
}

/**
 * Сколько минут осталось до запуска, если мы попали в окно предупреждения.
 * Возвращает null вне окна и после начала вайпа.
 */
export function warningPlan(nowMs, runAtMs, leadMinutes) {
  const deltaMs = runAtMs - nowMs;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  const lead = Number(leadMinutes);
  if (!Number.isFinite(lead) || lead <= 0) return null;
  if (deltaMs > lead * 60000) return null;
  const minutesLeft = Math.ceil(deltaMs / 60000);
  return minutesLeft > 0 ? minutesLeft : null;
}

/** Подставляет {minutes} в текст предупреждения. */
export function formatWarning(template, minutesLeft) {
  return String(template ?? '').replace(/\{minutes\}/g, String(minutesLeft));
}

async function rememberSent(ctx, profile, runAt, minutesLeft) {
  const warned = Array.isArray(profile[STORE_KEY]) ? profile[STORE_KEY] : [];
  const existing = warned.find((item) => item && item.runAt === runAt);
  const sentMinutes = Array.isArray(existing?.minutes) ? existing.minutes : [];
  const nextWarned = [
    ...warned.filter((item) => item && item.runAt !== runAt),
    { runAt, minutes: [...sentMinutes, minutesLeft].sort((a, b) => b - a) },
  ].slice(-MAX_TRACKED_RUNS);
  profile[STORE_KEY] = nextWarned;
  try {
    await ctx.collection('profiles').update({ id: profile.id }, { $set: { [STORE_KEY]: nextWarned } });
  } catch {
    /* отметка не критична: в худшем случае в чат уйдёт повтор */
  }
}

/**
 * Проходит по профилям и отправляет предупреждения, которым пришло время.
 * @returns {Promise<number>} сколько сообщений отправлено
 */
export async function sendWipeWarnings(ctx, profiles, now = new Date()) {
  if (ctx.getConfig('wipeWarningEnabled') === false) return 0;
  // Глобальный режим проверки: каждый прогон — dry-run, вайпа не будет.
  if (ctx.getConfig('dryRun') === true) return 0;

  const leadMinutes = Number(ctx.getConfig('wipeWarningMinutes') ?? 5);
  if (!Number.isFinite(leadMinutes) || leadMinutes <= 0) return 0;

  const template = String(
    ctx.getConfig('wipeWarningText') ?? 'Вайп сервера через {minutes} мин',
  );

  const api = createPanelClient(ctx);
  if (!api.hasKey) return 0;

  let sent = 0;
  for (const profile of profiles) {
    if (!profile || profile.enabled === false) continue;
    if (profile?.options?.warnChat === false) continue;
    // Проверочный прогон профиля ничего не удаляет — отсчёт ввёл бы игроков в заблуждение.
    if (profile?.options?.dryRun) continue;
    if (!profile.serverId) continue;

    const runAt = profile.nextRunAt ? new Date(profile.nextRunAt) : null;
    if (!runAt || Number.isNaN(runAt.getTime())) continue;

    const minutesLeft = warningPlan(now.getTime(), runAt.getTime(), leadMinutes);
    if (!minutesLeft) continue;

    const runAtKey = runAt.toISOString();
    const warned = Array.isArray(profile[STORE_KEY]) ? profile[STORE_KEY] : [];
    const record = warned.find((item) => item && item.runAt === runAtKey);
    if (Array.isArray(record?.minutes) && record.minutes.includes(minutesLeft)) continue;

    const text = formatWarning(template, minutesLeft);
    try {
      await api.command(profile.serverId, `say ${text}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        { profileId: profile.id, error: reason },
        'rust-autowipe: не удалось отправить предупреждение в чат',
      );
      await rememberState(ctx, {
        at: new Date().toISOString(),
        ok: false,
        error: reason,
        profileId: profile.id,
        serverId: profile.serverId,
        minutes: minutesLeft,
      });
      continue;
    }

    sent += 1;
    await rememberState(ctx, {
      at: new Date().toISOString(),
      ok: true,
      text,
      profileId: profile.id,
      serverId: profile.serverId,
      minutes: minutesLeft,
    });
    await rememberSent(ctx, profile, runAtKey, minutesLeft);
  }

  return sent;
}
