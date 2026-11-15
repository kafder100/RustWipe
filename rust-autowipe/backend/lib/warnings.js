/**
 * Предупреждения в чате сервера перед плановым вайпом.
 *
 * Планировщик тикает раз в минуту, поэтому предупреждение отправляется один раз
 * на каждую «минуту до вайпа»: 5, 4, 3, 2, 1. Отправленные отметки хранятся в
 * профиле по ключу ближайшего запуска (nextRunAt), чтобы панель не дублировала
 * сообщения и не повторяла их после перезапуска.
 */

import { createPanelClient } from './api.js';

const STORE_KEY = 'warnedRuns';
const MAX_TRACKED_RUNS = 5;
const STATE_KEY = 'wipeWarningState';

/** Последняя попытка отправки — чтобы показать её в интерфейсе, а не только в логе. */
let lastState = null;

export function getWarningState() {
  return lastState;
}

export async function loadWarningState(ctx) {
  try {
    const stored = await ctx.getStorage(STATE_KEY);
    if (stored && typeof stored === 'object') lastState = stored;
  } catch {
    /* хранилище может быть недоступно — не критично */
  }
  return lastState;
}

async function rememberState(ctx, state) {
  lastState = state;
  try {
    await ctx.setStorage(STATE_KEY, state);
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
