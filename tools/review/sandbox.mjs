/**
 * Песочница для проверки backend плагина RustWipe без настоящей панели Catalyst
 * (правила ревью, разделы 4.3 и 5).
 *
 * Плагин живёт внутри панели: файлы трогает через файловый туннель агента
 * (ctx.fileTunnel), сервер останавливает и запускает через REST API панели
 * (fetch), состояние хранит в коллекциях панели. Здесь всё это подменено:
 *   - «диск» сервера — дерево в памяти, по-настоящему ничего не удаляется;
 *   - настоящая сеть закрыта сторожем: fetch отвечает только подмена панели;
 *   - часы поддельные: ожидания плагина (остановка до 300 с, запуск до 240 с,
 *     опросы и паузы) проходят в виртуальном времени мгновенно.
 *
 * Поведение подмен списано с исходников Catalyst v1.89.2 — ссылки на файлы и
 * строки стоят у каждой части. Где точной копии нет, это сказано прямо.
 *
 * Быстрый старт — файл tools/review/<имя>.test.mjs:
 *
 *   import assert from 'node:assert/strict';
 *   import { createSandbox, test } from './sandbox.mjs';
 *
 *   test('вайп удаляет только карту', async () => {
 *     const sb = createSandbox();
 *     await sb.load();
 *     const before = sb.tree.snapshot();
 *     const profile = await sb.addProfile({ targets: ['/server/rust/proceduralmap.*.map'] });
 *     const run = await sb.wipe(profile);
 *     assert.equal(run.ok, true);
 *     assert.deepEqual(sb.tree.diff(before).removed, ['/server/rust/proceduralmap.3000.12345.270.map']);
 *   });
 *
 * Запуск одного файла: node tools/review/<имя>.test.mjs
 * Запуск всех: node tools/review/run.mjs [--only <подстрока>] [--tz UTC,Europe/Moscow]
 *
 * Части модуля (у каждой функции — свой комментарий):
 *   1. createTree, rustServerTree, diff — дерево файлов в памяти и эмуляция агента;
 *   2. createTunnel — подмена ctx.fileTunnel (list, delete) с режимами сбоев;
 *   3. createPanel — ctx.db.servers и подмена fetch для REST API панели;
 *   4. createClock — поддельные Date, таймеры и AbortSignal.timeout;
 *   5. makeContext, makeProfile — контекст плагина, как его даёт панель;
 *   6. loadPlugin, callRoute — загрузка плагина и вызов роутов от имени людей;
 *   7. runNode, runWithTz — дочерний процесс node с нужным TZ;
 *   8. test — мини-фреймворк тестов со сторожем зависаний;
 *   + createSandbox — всё вместе одной строкой; createJournal — общий журнал;
 *     withTempDir — временная папка для настоящих файлов (с уборкой).
 *
 * Правило: одна песочница — один тест. Создавайте её внутри test(): тогда
 * глобальные подмены (Date, таймеры, fetch) снимаются сами после теста.
 *
 * Порядок событий смотрите в общем журнале: sb.journal.lines(['fetch', 'server', 'tunnel'])
 * или сравнивайте seq записей (sb.journal.entries) — номер сквозной для всех подмен.
 *
 * Чего здесь нет (известные пределы):
 *   - ответ «Server not found» по туннелю — выдуманный режим: агент v1.89.2 так
 *     не отвечает (эта строка есть только в REST панели); настоящий агент для
 *     незнакомого uuid создаёт пустой корень на «/» и отвечает «нет файла» на остальное;
 *   - junction в Linux-агенте не бывает; здесь это каталог-«точка монтирования»
 *     (как bind mount): агент не считает его ссылкой и проходит сквозь него;
 *   - права в панели — по глобальным ролям пользователя и ServerAccess; гранты
 *     ролей на сервер или ноду и доступ через ноду (node.server_manage) не эмулируются;
 *   - лимиты частоты запросов панели (30 в минуту на питание, лимиты туннеля
 *     на ноду) и ограничение размера файлов не эмулируются;
 *   - операции туннеля, кроме list и delete, отвечают «не эмулируется» —
 *     плагин их не вызывает;
 *   - performance.now, process.hrtime и node:timers/promises часами не подделываются;
 *   - часы считают, что код ждёт только поддельных таймеров и быстрых промисов;
 *     настоящий ввод-вывод внутри runUntil не ломает расчёт, но время его не ждёт.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ════════════════════════════════════════════════════════════════════════════
// 0. Настоящие глобальные функции и сторож сети
// ════════════════════════════════════════════════════════════════════════════

/** Снимок настоящих глобальных функций до любых подмен. */
const REAL = Object.freeze({
  Date: globalThis.Date,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  fetch: globalThis.fetch,
  abortSignalTimeout: AbortSignal.timeout,
});

const FAKE_FETCH = Symbol('песочница: подменённый fetch');

/**
 * Сторож сети. Ставится при импорте модуля: любой fetch мимо подмены панели
 * падает как сетевая ошибка, а не уходит в настоящую сеть (на этой машине
 * работают чужие серверы — их трогать нельзя).
 */
function guardFetch(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  const url = String(input?.url ?? input);
  const error = new TypeError('fetch failed');
  error.cause = new Error(
    `песочница: настоящая сеть закрыта (${method} ${url}). Подключите подмену панели: createPanel(...).install() или createSandbox()`,
  );
  return Promise.reject(error);
}
guardFetch[FAKE_FETCH] = 'сторож';
globalThis.fetch = guardFetch;

/** Настоящий fetch процесса (до сторожа). Нужен только в исключительных случаях. */
export const realFetch = REAL.fetch;

/** Вернуть настоящий fetch вместо сторожа. Сеть откроется — используйте с осторожностью. */
export function restoreRealFetch() {
  globalThis.fetch = REAL.fetch;
}

/** Корень плагина и backend относительно этого файла (tools/review → корень репозитория). */
const PLUGIN_DIR_URL = new URL('../../rust-autowipe/', import.meta.url);
const BACKEND_DIR_URL = new URL('backend/', PLUGIN_DIR_URL);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NOW = '2026-11-19T00:00:00.000Z';
const DEFAULT_MTIME = '2026-11-01T00:00:00.000Z';
/** Каталог данных агента по умолчанию: catalyst-agent/src/config.rs:421-422. */
const DEFAULT_DATA_DIR = '/var/lib/catalyst';
const DEFAULT_SERVER_UUID = 'c0ffee00-0000-4000-8000-00000000a001';
const DEFAULT_NODE_ID = 'node1';
const DEFAULT_PANEL_BASE = 'https://panel.test';
const DEFAULT_API_KEY = 'catalyst_sandbox_key';
/** Имя cookie сессии: catalyst-backend/src/lib/auth-session-cache.ts:48. */
const SESSION_COOKIE_NAME = 'better-auth.session_token';

// ════════════════════════════════════════════════════════════════════════════
// Общие помощники
// ════════════════════════════════════════════════════════════════════════════

function toMs(value) {
  if (value instanceof REAL.Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = REAL.Date.parse(String(value));
  if (Number.isNaN(ms)) throw new Error(`песочница: не понимаю время «${value}»`);
  return ms;
}

function isoOf(ms) {
  return new REAL.Date(ms).toISOString();
}

/** Копия через JSON — так данные проходят через Json-поле Prisma (Date → строка, undefined пропадает). */
function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Безопасная копия для журнала: ошибки превращаются в текст, циклы не ломают запись. */
function safeClone(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => (item instanceof Error ? { error: item.message } : item)),
    );
  } catch {
    return String(value);
  }
}

function short(value, limit = 160) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Совпадение значения с образцом: строка — точно, RegExp, функция или массив образцов. */
function matchValue(pattern, value) {
  if (pattern === undefined || pattern === null) return true;
  if (typeof pattern === 'function') return Boolean(pattern(value));
  if (pattern instanceof RegExp) return pattern.test(String(value));
  if (Array.isArray(pattern)) return pattern.some((item) => matchValue(item, value));
  return pattern === value;
}

function makeError(message, extra) {
  return Object.assign(new Error(message), extra || {});
}

// ════════════════════════════════════════════════════════════════════════════
// Права и пути — копии правил Catalyst
// ════════════════════════════════════════════════════════════════════════════

/** catalyst-backend/src/lib/permission-vocabulary.ts:16-22. */
const READ_PERMISSIONS = new Set([
  'admin.read', 'apikey.read',
  'server.read', 'backup.read', 'file.read', 'console.read',
  'database.read', 'alert.read', 'node.read', 'location.read',
  'template.read', 'user.read', 'role.read',
  'node.view_stats', 'backup.download', 'diagnostics.download',
]);

/** catalyst-backend/src/lib/permission-vocabulary.ts:32-45. */
const LEGACY_ALIASES = {
  'apikey.manage': ['apikey.read', 'apikey.write'],
  'server.update': ['server.startup', 'server.resources', 'server.network', 'server.storage'],
  'node.update': ['node.server_manage', 'node.agent_control'],
  'server.suspend': ['server.archive'],
  'server.transfer': ['server.migrate'],
  'server.create': ['server.clone'],
  'server.stop': ['server.kill'],
};

/** catalyst-backend/src/lib/permissions-catalog.ts:309-322. */
const ALL_SERVER_PERMISSIONS = [
  'server.read', 'server.start', 'server.stop', 'server.kill',
  'server.install', 'server.reinstall', 'server.rebuild', 'server.update',
  'server.startup', 'server.resources',
  'server.network', 'server.storage', 'server.archive', 'server.migrate',
  'server.transfer', 'server.delete', 'server.schedule', 'server.clone',
  'console.read', 'console.write',
  'file.read', 'file.write',
  'backup.read', 'backup.create', 'backup.restore', 'backup.delete', 'backup.download',
  'backup.pin',
  'database.read', 'database.create', 'database.rotate', 'database.delete',
  'alert.read', 'alert.create', 'alert.update', 'alert.delete',
  'mods.manage', 'plugins.manage',
];

/**
 * Есть ли у набора прав нужное право — как hasGrant в Catalyst
 * (catalyst-backend/src/lib/permissions.ts:153-160): «*» даёт всё,
 * admin.write — всё, кроме «*», admin.read — права чтения, плюс старые
 * «составные» права (server.stop покрывает server.kill и т. п.).
 */
export function hasGrant(granted, required) {
  const list = Array.isArray(granted) ? granted : [];
  if (list.includes('*')) return true;
  if (list.includes(required)) return true;
  if (list.some((permission) => (LEGACY_ALIASES[permission] || []).includes(required))) return true;
  if (required !== '*' && list.includes('admin.write')) return true;
  if (list.includes('admin.read') && READ_PERMISSIONS.has(required)) return true;
  return false;
}

/** Решение о доступе к серверу: catalyst-backend/src/lib/server-access.ts:35-88 (без грантов на ноду). */
function decideServerAccess({ isOwner, hasExplicitServerAccess, rolePermissions, requiredPermission }) {
  if (isOwner) return 'owner';
  if (hasExplicitServerAccess) return 'server_access';
  if (rolePermissions.includes('*') || rolePermissions.includes('admin.write')) return 'admin';
  if (requiredPermission && rolePermissions.includes('admin.read') && READ_PERMISSIONS.has(requiredPermission)) {
    return 'admin_read';
  }
  if (requiredPermission && hasGrant(rolePermissions, requiredPermission)) return 'role_permission';
  return null;
}

/**
 * Нормализация пути, которую backend панели делает перед отправкой агенту:
 * catalyst-backend/src/lib/path-validation.ts:103-124. «..» не выходит выше
 * корня, обратный слэш — разделитель, байт NUL — ошибка «Invalid path».
 */
export function normalizeRequestPath(value) {
  if (!value) return '/';
  const cleaned = String(value).replace(/\\/g, '/').trim();
  if (!cleaned || cleaned === '.') return '/';
  const resolved = [];
  for (const part of cleaned.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
      continue;
    }
    if (part.includes('\0')) throw new Error('Invalid path');
    resolved.push(part);
  }
  return resolved.length === 0 ? '/' : `/${resolved.join('/')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Журнал: общий порядок всех вызовов песочницы
// ════════════════════════════════════════════════════════════════════════════

/**
 * Общий журнал песочницы. Каждая запись: { seq, kind, at, ... }, где seq —
 * сквозной номер (по нему видно порядок «остановка → удаление → запуск»),
 * at — виртуальное время в мс. Виды записей: tunnel, fetch, server, db,
 * storage, log, event, task, route, config.
 *   journal.of('tunnel') — записи одного вида;
 *   journal.lines(['fetch', 'tunnel']) — читаемые строки;
 *   journal.print() — вывести всё.
 */
export function createJournal() {
  const entries = [];
  const listeners = new Set();
  let seq = 0;
  const notify = (entry) => {
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        /* слушатель не должен ломать журнал */
      }
    }
  };
  return {
    entries,
    push(kind, data = {}) {
      const entry = { seq: ++seq, kind, ...data };
      if (entry.at === undefined) entry.at = Date.now();
      entries.push(entry);
      notify(entry);
      return entry;
    },
    update(entry, patch) {
      Object.assign(entry, patch);
      notify(entry);
      return entry;
    },
    of(kind) {
      return entries.filter((entry) => entry.kind === kind);
    },
    lines(kinds) {
      const only = kinds ? new Set([].concat(kinds)) : null;
      return entries.filter((entry) => !only || only.has(entry.kind)).map(formatEntry);
    },
    print(kinds) {
      for (const line of this.lines(kinds)) process.stdout.write(`${line}\n`);
    },
    onPush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function formatEntry(entry) {
  const time = Number.isFinite(entry.at) ? isoOf(entry.at).slice(11, 23) : '??:??:??.???';
  const head = `#${entry.seq} ${time}`;
  switch (entry.kind) {
    case 'tunnel': {
      const tail =
        entry.outcome === 'ok'
          ? `ok${entry.count !== undefined ? ` (${entry.count})` : ''}`
          : entry.outcome === 'error' || entry.outcome === 'throw'
            ? `${entry.outcome === 'throw' ? 'исключение' : 'ошибка'}: ${entry.error}`
            : entry.outcome;
      return `${head} tunnel ${entry.op} ${entry.path} → ${tail}`;
    }
    case 'fetch': {
      const marks = `${entry.cookie ? ' [cookie]' : ''}${entry.authorization ? ' [authorization]' : ''}`;
      const result = entry.status !== undefined ? entry.status : entry.outcome;
      return `${head} fetch ${entry.method} ${entry.url}${marks} → ${result}${entry.error ? ` ${entry.error}` : ''}`;
    }
    case 'server':
      return `${head} server ${entry.id}: ${entry.from} → ${entry.to} (${entry.cause})`;
    case 'db':
      return `${head} db ${entry.table}.${entry.op}${entry.filter ? ` ${short(entry.filter, 80)}` : ''}${
        entry.count !== undefined ? ` → ${entry.count}` : ''
      }${entry.failed ? ` СБОЙ: ${entry.error}` : ''}`;
    case 'storage':
      return `${head} storage ${entry.op} ${entry.key}${entry.failed ? ` СБОЙ: ${entry.error}` : ''}`;
    case 'log':
      return `${head} log ${entry.level}: ${entry.msg}${entry.data !== undefined ? ` ${short(entry.data)}` : ''}`;
    case 'event':
      return `${head} event ${entry.event} ${short(entry.data)}`;
    case 'task':
      return `${head} task ${entry.op} «${entry.cron}»${entry.error ? ` ошибка: ${entry.error}` : ''}`;
    case 'route':
      return `${head} route ${entry.method} ${entry.url} (${entry.user ?? 'аноним'}) → ${entry.status ?? 'ждёт'}`;
    case 'config':
      return `${head} config ${entry.key} = ${short(entry.value)}`;
    default:
      return `${head} ${entry.kind} ${short(entry)}`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Часы: поддельные Date, таймеры и AbortSignal.timeout
// ════════════════════════════════════════════════════════════════════════════

let activeClock = null;

/**
 * Поддельные часы. После clock.install():
 *   - new Date() без аргументов и Date.now() дают виртуальное «сейчас»;
 *     new Date(x) с аргументами, Date.UTC, Date.parse — настоящие;
 *   - setTimeout/setInterval/clearTimeout/clearInterval и AbortSignal.timeout
 *     работают в виртуальном времени (сами по себе не срабатывают);
 *   - setImmediate, process.nextTick, промисы — настоящие.
 * Время двигают так:
 *   await clock.runUntil(promise) — крутить таймеры, пока промис не завершится
 *     (ожидание 300 с проходит мгновенно); несколько runUntil одновременно —
 *     можно, двигатель у часов один;
 *   await clock.until(() => условие) — крутить, пока условие не станет истинным;
 *   await clock.advance(ms) — сдвинуть время на ms, срабатывают все таймеры по пути;
 *   await clock.runAll() — выполнить все таймеры, пока они не кончатся;
 *   clock.setNow(дата) — переставить «сейчас» без срабатывания таймеров.
 * clock.restore() возвращает настоящие функции (тест делает это сам).
 * Не подделываются: performance.now, process.hrtime, node:timers/promises.
 */
export function createClock({ now = DEFAULT_NOW } = {}) {
  let nowMs = toMs(now);
  const timers = new Map();
  let idCounter = 0;
  let seqCounter = 0;
  let installed = false;
  let saved = null;
  let testSignal = null;
  const targets = new Set();
  const conditions = new Set();
  let driving = false;
  let wake = null;

  const poke = () => {
    const resolve = wake;
    wake = null;
    if (resolve) resolve();
  };

  class FakeTimeout {
    constructor(id) {
      this.id = id;
      this.refed = true;
    }
    ref() {
      this.refed = true;
      return this;
    }
    unref() {
      this.refed = false;
      return this;
    }
    hasRef() {
      return this.refed;
    }
    refresh() {
      const timer = timers.get(this.id);
      if (timer) {
        timer.at = nowMs + timer.delay;
        timer.seq = ++seqCounter;
      }
      return this;
    }
    close() {
      timers.delete(this.id);
      return this;
    }
    [Symbol.toPrimitive]() {
      return this.id;
    }
  }

  function addTimer(fn, delay, args, repeat) {
    if (typeof fn !== 'function') {
      throw new TypeError('The "callback" argument must be of type function');
    }
    // Как в Node: не число, меньше 1 или больше 2^31-1 — значит 1 мс.
    let ms = Number(delay);
    if (!(ms >= 1 && ms <= 2147483647)) ms = 1;
    const id = ++idCounter;
    const handle = new FakeTimeout(id);
    timers.set(id, { id, at: nowMs + ms, delay: ms, seq: ++seqCounter, fn, args, repeat, handle });
    poke();
    return handle;
  }

  function clearTimer(handle) {
    if (handle === null || handle === undefined) return;
    const id = typeof handle === 'object' ? handle.id : Number(handle);
    timers.delete(id);
  }

  function earliest(limit = Infinity) {
    let best = null;
    for (const timer of timers.values()) {
      if (timer.at > limit) continue;
      if (!best || timer.at < best.at || (timer.at === best.at && timer.seq < best.seq)) best = timer;
    }
    return best;
  }

  function fire(timer) {
    if (timer.at > nowMs) nowMs = timer.at;
    if (timer.repeat) {
      timer.at = nowMs + timer.delay;
      timer.seq = ++seqCounter;
    } else {
      timers.delete(timer.id);
    }
    try {
      timer.fn(...timer.args);
    } catch (error) {
      // Исключение в таймере в Node — необработанное исключение процесса.
      process.nextTick(() => {
        throw error;
      });
    }
  }

  async function settle() {
    // Два оборота настоящего setImmediate: успевают все промисы и ответы подмен.
    await new Promise((resolve) => REAL.setImmediate(resolve));
    await new Promise((resolve) => REAL.setImmediate(resolve));
  }

  /** Проверить условия until(); вернуть, сколько из них решилось. */
  function checkConditions() {
    let settled = 0;
    for (const condition of [...conditions]) {
      let value;
      try {
        value = condition.predicate();
      } catch (error) {
        conditions.delete(condition);
        condition.reject(error);
        settled += 1;
        continue;
      }
      if (value) {
        conditions.delete(condition);
        condition.resolve(value);
        settled += 1;
      }
    }
    return settled;
  }

  function failTarget(target, error) {
    if (target.done) return;
    target.done = true;
    targets.delete(target);
    target.reject(error);
  }

  async function drive() {
    if (driving) {
      poke();
      return;
    }
    driving = true;
    try {
      while (targets.size) {
        await settle();
        // Условие решилось — сначала дать его ожидающим завершиться, таймер не трогать.
        if (checkConditions()) continue;
        if (!targets.size) break;
        if (testSignal?.aborted) {
          for (const target of [...targets]) {
            failTarget(target, new Error('часы остановлены: тест прерван сторожем'));
          }
          break;
        }
        const next = earliest();
        if (!next) {
          // Таймеров нет: ждём, пока что-то случится (новый таймер, запись
          // журнала, завершение промиса). Если не случится ничего, цикл
          // событий опустеет — тест будет помечен «тест не завершился».
          await new Promise((resolve) => {
            wake = resolve;
          });
          continue;
        }
        for (const target of [...targets]) {
          target.steps += 1;
          if (next.at - target.startAt > target.maxVirtualMs) {
            failTarget(
              target,
              new Error(
                `часы: за ${Math.round(target.maxVirtualMs / 1000)} с виртуального времени ожидание не закончилось (следующий таймер через ${Math.round(next.at - nowMs)} мс)`,
              ),
            );
          } else if (target.steps > target.maxSteps) {
            failTarget(target, new Error(`часы: сработало больше ${target.maxSteps} таймеров — похоже на бесконечный цикл`));
          }
        }
        if (!targets.size) break;
        fire(next);
      }
    } finally {
      driving = false;
    }
  }

  const fakeNow = () => Math.floor(nowMs);
  const FakeDate = new Proxy(REAL.Date, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [fakeNow()], newTarget === FakeDate ? target : newTarget);
    },
    apply() {
      return new REAL.Date(fakeNow()).toString();
    },
    get(target, prop) {
      if (prop === 'now') return fakeNow;
      return Reflect.get(target, prop, target);
    },
  });

  const fakeSetTimeout = (fn, delay, ...args) => addTimer(fn, delay, args, false);
  const fakeSetInterval = (fn, delay, ...args) => addTimer(fn, delay, args, true);
  const fakeAbortSignalTimeout = (ms) => {
    const controller = new AbortController();
    addTimer(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      ms,
      [],
      false,
    ).unref();
    return controller.signal;
  };

  const clock = {
    /** Виртуальное «сейчас», мс. */
    now: () => fakeNow(),
    /** Переставить «сейчас» (можно и назад); таймеры не срабатывают. */
    setNow(value) {
      nowMs = toMs(value);
      poke();
    },
    /** Поддельный setTimeout — работает и без install(). */
    setTimeout: fakeSetTimeout,
    clearTimeout: clearTimer,
    setInterval: fakeSetInterval,
    clearInterval: clearTimer,
    /** Сколько таймеров ждёт срабатывания. */
    pending: () => timers.size,
    /** Ближайшие таймеры: [{ inMs, repeat }]. */
    timers: () =>
      [...timers.values()]
        .sort((a, b) => a.at - b.at || a.seq - b.seq)
        .map((timer) => ({ inMs: timer.at - nowMs, repeat: Boolean(timer.repeat) })),
    /** Разбудить двигатель часов (зовёт журнал при каждой записи). */
    poke,
    get installed() {
      return installed;
    },
    /** Поставить подмену глобальных Date, таймеров и AbortSignal.timeout. */
    install() {
      if (installed) return clock;
      if (activeClock && activeClock !== clock) {
        throw new Error('песочница: другие поддельные часы уже установлены — сначала restore()');
      }
      saved = {
        Date: globalThis.Date,
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
        abortSignalTimeout: AbortSignal.timeout,
      };
      globalThis.Date = FakeDate;
      globalThis.setTimeout = fakeSetTimeout;
      globalThis.clearTimeout = clearTimer;
      globalThis.setInterval = fakeSetInterval;
      globalThis.clearInterval = clearTimer;
      AbortSignal.timeout = fakeAbortSignalTimeout;
      installed = true;
      activeClock = clock;
      testSignal = currentTestSignal();
      onTestCleanup(() => clock.restore());
      return clock;
    },
    /** Вернуть настоящие Date и таймеры. */
    restore() {
      if (!installed) return;
      globalThis.Date = saved.Date;
      globalThis.setTimeout = saved.setTimeout;
      globalThis.clearTimeout = saved.clearTimeout;
      globalThis.setInterval = saved.setInterval;
      globalThis.clearInterval = saved.clearInterval;
      AbortSignal.timeout = saved.abortSignalTimeout;
      installed = false;
      if (activeClock === clock) activeClock = null;
    },
    /**
     * Крутить таймеры, пока promise не завершится. Возвращает его результат.
     * maxVirtualMs — предел виртуального времени (по умолчанию 30 суток),
     * maxSteps — предел числа сработавших таймеров (защита от бесконечного опроса).
     */
    runUntil(promiseLike, { maxVirtualMs = 30 * DAY_MS, maxSteps = 200000 } = {}) {
      let promise;
      try {
        promise = Promise.resolve(typeof promiseLike === 'function' ? promiseLike() : promiseLike);
      } catch (error) {
        promise = Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        const target = { startAt: nowMs, maxVirtualMs, maxSteps, steps: 0, resolve, reject, done: false };
        targets.add(target);
        promise.then(
          (value) => {
            if (target.done) return;
            target.done = true;
            targets.delete(target);
            resolve(value);
            poke();
          },
          (error) => {
            if (target.done) return;
            target.done = true;
            targets.delete(target);
            reject(error);
            poke();
          },
        );
        void drive();
      });
    },
    /** Крутить таймеры, пока predicate() не вернёт истину (проверяется после каждого шага и записи журнала). */
    until(predicate, options) {
      let condition;
      const promise = new Promise((resolve, reject) => {
        condition = { predicate, resolve, reject };
      });
      conditions.add(condition);
      checkConditions();
      return clock.runUntil(promise, options).finally(() => conditions.delete(condition));
    },
    /** Сдвинуть время на ms; все таймеры по пути срабатывают по порядку. */
    async advance(ms) {
      const goal = nowMs + Math.max(0, Number(ms) || 0);
      for (;;) {
        await settle();
        checkConditions();
        const next = earliest(goal);
        if (!next) break;
        fire(next);
      }
      if (nowMs < goal) nowMs = goal;
      await settle();
      checkConditions();
    },
    /** Выполнить все таймеры, пока не кончатся. Возвращает, сколько сработало. */
    async runAll({ maxSteps = 100000 } = {}) {
      for (let step = 0; ; step += 1) {
        await settle();
        checkConditions();
        const next = earliest();
        if (!next) return step;
        if (step >= maxSteps) throw new Error(`часы: runAll — больше ${maxSteps} таймеров, похоже на setInterval без конца`);
        fire(next);
      }
    },
    /** Дать отработать промисам без сдвига времени. */
    settle,
    /** Строки для диагностики зависаний. */
    describe() {
      const next = earliest();
      return [
        `часы: сейчас ${isoOf(nowMs)}, ждут таймеров: ${timers.size}${next ? `, ближайший через ${Math.round(next.at - nowMs)} мс` : ''}`,
      ];
    },
  };
  return clock;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Дерево файлов в памяти и эмуляция агента
// ════════════════════════════════════════════════════════════════════════════

/** Тексты ошибок ввода-вывода Rust (std::io::Error для Linux). */
const ERRNO_TEXT = {
  ENOENT: 'No such file or directory (os error 2)',
  ENOTDIR: 'Not a directory (os error 20)',
  EISDIR: 'Is a directory (os error 21)',
  EBUSY: 'Device or resource busy (os error 16)',
  ELOOP: 'Too many levels of symbolic links (os error 40)',
};

/** Префиксы ошибок агента: catalyst-agent/src/errors.rs:5-46 (thiserror Display). */
const AGENT_ERROR_PREFIX = {
  FileSystemError: 'File system error: ',
  PermissionDenied: 'Permission denied: ',
  IoError: 'IO error: ',
  InvalidRequest: 'Invalid request: ',
};

class AgentError extends Error {
  constructor(kind, detail) {
    super(`${AGENT_ERROR_PREFIX[kind]}${detail}`);
    this.name = 'AgentError';
    this.kind = kind;
  }
}

function errnoError(code) {
  return makeError(ERRNO_TEXT[code], { errno: code });
}

function hostParts(value) {
  return String(value)
    .split('/')
    .filter((part) => part !== '' && part !== '.');
}

function hostJoin(parts) {
  return `/${parts.join('/')}`;
}

function normalizeHostPath(value) {
  const normalized = path.posix.normalize(`/${String(value)}`);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function withinParts(baseParts, parts) {
  return parts.length >= baseParts.length && baseParts.every((part, index) => parts[index] === part);
}

function toSeconds(value) {
  return Math.floor(toMs(value) / 1000);
}

/** Время изменения в формате агента: chrono to_rfc3339 (catalyst-agent/src/file_tunnel.rs:975-983). */
function rfc3339(seconds) {
  if (!seconds) return '';
  return new REAL.Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

class SandboxTree {
  constructor(spec = {}) {
    this.uuid = String(spec.uuid ?? DEFAULT_SERVER_UUID);
    this.dataDir = normalizeHostPath(spec.dataDir ?? DEFAULT_DATA_DIR);
    this.root = `${this.dataDir}/${this.uuid}`;
    this.defaultMtime = toSeconds(spec.mtime ?? DEFAULT_MTIME);
    this.hostRoot = { kind: 'dir', children: new Map(), mode: 0o755, mtime: this.defaultMtime };
    this.mkdirp(this.root);
    for (const [key, value] of Object.entries(spec.files ?? {})) this.add(key, value);
    for (const [key, value] of Object.entries(spec.host ?? {})) this.addHost(key, value);
  }

  /** Путь на «хосте» для пути внутри сервера: '/oxide' → '<каталог данных>/<uuid>/oxide'. */
  hostPath(serverPath) {
    const parts = hostParts(serverPath);
    return parts.length ? `${this.root}/${parts.join('/')}` : this.root;
  }

  /** Добавить файл, каталог (ключ с «/» на конце) или ссылку внутри сервера. */
  add(serverPath, spec) {
    const isDirKey = String(serverPath).endsWith('/');
    this.placeNode(this.hostPath(serverPath), spec, isDirKey);
    return this;
  }

  /** То же для абсолютного пути на «хосте» (вне каталога сервера). */
  addHost(hostPathValue, spec) {
    const isDirKey = String(hostPathValue).endsWith('/');
    this.placeNode(normalizeHostPath(hostPathValue), spec, isDirKey);
    return this;
  }

  mkdirp(hostPathValue) {
    let node = this.hostRoot;
    for (const part of hostParts(hostPathValue)) {
      let child = node.children.get(part);
      if (!child) {
        child = { kind: 'dir', children: new Map(), mode: 0o755, mtime: this.defaultMtime };
        node.children.set(part, child);
      }
      if (child.kind !== 'dir') {
        throw new Error(`песочница: на пути ${hostPathValue} уже есть ${child.kind}, нужен каталог`);
      }
      node = child;
    }
    return node;
  }

  placeNode(hostPathValue, spec, isDirKey) {
    const parts = hostParts(hostPathValue);
    if (!parts.length) throw new Error('песочница: нельзя заменить корень');
    const name = parts[parts.length - 1];
    const parentPath = hostJoin(parts.slice(0, -1));
    const parent = this.mkdirp(parentPath);
    const node = this.nodeFromSpec(spec, isDirKey, parentPath);
    const existing = parent.children.get(name);
    if (existing && existing.kind === 'dir' && node.kind === 'dir') return;
    parent.children.set(name, node);
  }

  nodeFromSpec(spec, isDirKey, parentPath) {
    const mtime = spec && typeof spec === 'object' && spec.mtime != null ? toSeconds(spec.mtime) : this.defaultMtime;
    if (isDirKey || (spec && typeof spec === 'object' && spec.dir === true)) {
      return { kind: 'dir', children: new Map(), mode: spec?.mode ?? 0o755, mtime };
    }
    if (typeof spec === 'string') return { kind: 'file', content: spec, size: Buffer.byteLength(spec), mode: 0o644, mtime };
    if (typeof spec === 'number') return { kind: 'file', content: null, size: spec, mode: 0o644, mtime };
    if (spec === null || spec === undefined) return { kind: 'file', content: '', size: 0, mode: 0o644, mtime };
    if (spec.link !== undefined) return { kind: 'symlink', target: String(spec.link), mode: 0o777, mtime };
    if (spec.junction !== undefined) {
      return { kind: 'junction', target: this.junctionTarget(String(spec.junction), parentPath), mode: 0o755, mtime };
    }
    const content = spec.content !== undefined ? String(spec.content) : null;
    return {
      kind: 'file',
      content,
      size: spec.size ?? (content !== null ? Buffer.byteLength(content) : 0),
      mode: spec.mode ?? 0o644,
      mtime,
    };
  }

  /** Цель junction: '/data/…' — внутри сервера (как видит контейнер), другой абсолютный путь — на хосте. */
  junctionTarget(target, parentPath) {
    if (target === '/data' || target.startsWith('/data/')) return normalizeHostPath(this.root + target.slice(5));
    if (target.startsWith('/')) return normalizeHostPath(target);
    return normalizeHostPath(`${parentPath}/${target}`);
  }

  /**
   * Разрешение пути «как ядро Linux»: символьные ссылки в середине пути
   * всегда раскрываются, последняя — если followFinal; junction ведёт себя
   * как точка монтирования (bind mount): прозрачен, «..» возвращает к его
   * родителю. Возвращает { node, entry, parent, name, path } или { error }.
   */
  osResolve(hostPathValue, { followFinal = true } = {}, depth = 0) {
    if (depth > 40) return { error: 'ELOOP' };
    const queue = hostParts(hostPathValue);
    const stack = [{ name: '', node: this.hostRoot, parent: null, entry: this.hostRoot }];
    let hops = 0;
    while (queue.length) {
      const name = queue.shift();
      const top = stack[stack.length - 1];
      if (top.node.kind !== 'dir') return { error: 'ENOTDIR' };
      if (name === '..') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const child = top.node.children.get(name);
      if (!child) return { error: 'ENOENT' };
      const isFinal = queue.length === 0;
      if (child.kind === 'symlink' && (!isFinal || followFinal)) {
        hops += 1;
        if (hops > 40) return { error: 'ELOOP' };
        if (child.target.startsWith('/')) stack.length = 1;
        queue.unshift(...hostParts(child.target));
        continue;
      }
      if (child.kind === 'junction') {
        const target = this.osResolve(child.target, { followFinal: true }, depth + 1);
        if (target.error) return target;
        if (target.node.kind !== 'dir') return { error: 'ENOTDIR' };
        stack.push({ name, node: target.node, parent: top.node, entry: child });
        continue;
      }
      stack.push({ name, node: child, parent: top.node, entry: child });
    }
    const top = stack[stack.length - 1];
    return {
      node: top.node,
      entry: top.entry,
      parent: top.parent,
      name: top.name,
      path: hostJoin(stack.slice(1).map((item) => item.name)),
    };
  }

  /** Корень сервера на ноде с проверкой uuid: file_manager.rs:207-222 и 998-1010. */
  agentJail(uuid) {
    const id = String(uuid ?? '');
    if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('\0') || !id.trim()) {
      throw new AgentError('InvalidRequest', 'Invalid server id');
    }
    const data = this.osResolve(this.dataDir);
    if (data.error) throw new AgentError('FileSystemError', `Data directory does not exist: "${this.dataDir}"`);
    return `${this.dataDir}/${id}`;
  }

  /**
   * resolve_beneath агента (catalyst-agent/src/file_manager.rs:269-380) в трёх режимах:
   *  agent    — как настоящий агент: ссылка внутри сервера раскрывается (и последняя
   *             тоже!), абсолютная цель '/data/…' переносится в корень сервера, любая
   *             другая абсолютная цель и выход «..» за корень — отказ, больше 40
   *             переходов — отказ; junction агент ссылкой не считает (как bind mount);
   *  follow   — наивно: следовать любым ссылкам без проверки границы;
   *  nofollow — не следовать: ссылка в середине пути — ошибка, последняя — сама ссылка.
   */
  agentResolve(jail, requested, linkMode) {
    const jailParts = hostParts(jail);
    let cur = [...jailParts];
    const queue = hostParts(requested);
    let hops = 0;
    let finalLink = null;
    while (queue.length) {
      const comp = queue.shift();
      if (comp === '..') {
        cur.pop();
        if (linkMode !== 'follow' && !withinParts(jailParts, cur)) {
          throw new AgentError('PermissionDenied', 'Access denied: path outside data directory');
        }
        continue;
      }
      const cand = [...cur, comp];
      const candPath = hostJoin(cand);
      const st = this.osResolve(candPath, { followFinal: false });
      if (!st.error && st.entry.kind === 'symlink' && linkMode !== 'nofollow') {
        hops += 1;
        if (hops > 40) throw new AgentError('PermissionDenied', 'Access denied: symbolic link loop');
        const target = st.entry.target;
        let expanded;
        if (target.startsWith('/')) {
          if (target === '/data' || target.startsWith('/data/')) {
            cur = [...jailParts];
            expanded = hostParts(target.slice(5));
          } else if (linkMode === 'follow') {
            cur = [];
            expanded = hostParts(target);
          } else {
            throw new AgentError(
              'PermissionDenied',
              `Access denied: symbolic link leaves the server directory: ${candPath}`,
            );
          }
        } else {
          cur = cand.slice(0, -1);
          expanded = hostParts(target);
        }
        queue.unshift(...expanded);
        continue;
      }
      if (!st.error && linkMode === 'nofollow' && (st.entry.kind === 'symlink' || st.entry.kind === 'junction')) {
        if (queue.length) throw new AgentError('FileSystemError', `Cannot access path: ${ERRNO_TEXT.ELOOP}`);
        finalLink = st.entry;
        cur = cand;
        continue;
      }
      if (st.error === 'ENOENT') {
        if (queue.length) throw new AgentError('FileSystemError', `Cannot access path: ${candPath}`);
        cur = cand;
      } else if (st.error) {
        throw new AgentError('FileSystemError', `Cannot access path: ${ERRNO_TEXT[st.error]}`);
      } else {
        cur = cand;
      }
      if (linkMode !== 'follow' && !withinParts(jailParts, cur)) {
        throw new AgentError('PermissionDenied', 'Access denied: path outside data directory');
      }
    }
    return { path: hostJoin(cur), finalLink };
  }

  /**
   * Операция list агента: file_manager.rs:1163-1259 и file_tunnel.rs:326-349.
   * Возвращает массив записей { name, size, isDirectory, type, modified, mode }.
   */
  agentList(uuid, requestPath, linkMode = 'agent') {
    const jail = this.agentJail(uuid);
    const { path: full, finalLink } = this.agentResolve(jail, requestPath, linkMode);
    if (requestPath === '/' || requestPath === '' || requestPath === '.') {
      // Агент сам создаёт корень сервера перед листингом (file_manager.rs:1171-1186).
      const parts = hostParts(full);
      const parent = this.osResolve(hostJoin(parts.slice(0, -1)));
      if (!parent.error && parent.node.kind === 'dir' && !parent.node.children.has(parts[parts.length - 1])) {
        parent.node.children.set(parts[parts.length - 1], {
          kind: 'dir',
          children: new Map(),
          mode: 0o755,
          mtime: toSeconds(Date.now()),
        });
      }
    }
    if (finalLink) {
      throw new AgentError('FileSystemError', `Failed to read dir ${requestPath}: ${ERRNO_TEXT.ENOTDIR}`);
    }
    const st = this.osResolve(full, { followFinal: true });
    if (st.error) throw new AgentError('FileSystemError', `Failed to read dir ${requestPath}: ${ERRNO_TEXT[st.error]}`);
    if (st.node.kind !== 'dir') {
      throw new AgentError('FileSystemError', `Failed to read dir ${requestPath}: ${ERRNO_TEXT.ENOTDIR}`);
    }
    const entries = [];
    for (const [name, child] of st.node.children) {
      const childPath = `${st.path === '/' ? '' : st.path}/${name}`;
      let isDir = false;
      let mode = child.mode;
      let mtime = child.mtime;
      if (child.kind === 'dir') {
        isDir = true;
      } else if (child.kind === 'junction') {
        const target = this.osResolve(child.target, { followFinal: true });
        if (target.error) continue; // нечитаемую запись агент пропускает (file_manager.rs:1202-1214)
        if (linkMode === 'nofollow') {
          isDir = false;
        } else {
          isDir = target.node.kind === 'dir';
          mode = target.node.mode;
          mtime = target.node.mtime;
        }
      } else if (child.kind === 'symlink') {
        // Ссылка на каталог показывается каталогом, если цель читается на хосте
        // (fs::metadata идёт по ссылке куда угодно — file_manager.rs:1218-1227).
        if (linkMode !== 'nofollow') {
          const target = this.osResolve(childPath, { followFinal: true });
          isDir = !target.error && target.node.kind === 'dir';
        }
      }
      const size = isDir ? 0 : child.kind === 'file' ? child.size : child.kind === 'symlink' ? Buffer.byteLength(child.target) : 0;
      entries.push({ name, isDir, size, mtime, mode });
    }
    // Каталоги вперёд, затем имя без учёта регистра (file_manager.rs:1247-1251).
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return compareBytes(a.name.toLowerCase(), b.name.toLowerCase());
    });
    return entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      isDirectory: entry.isDir,
      type: entry.isDir ? 'directory' : 'file',
      modified: rfc3339(entry.mtime),
      mode: entry.mode & 0o7777,
    }));
  }

  /**
   * Операция delete агента: file_manager.rs:1123-1142 и file_tunnel.rs:558-567.
   * Путь раскрывается по ссылкам (в режиме agent — и последняя ссылка тоже,
   * то есть удаляется цель, а ссылка остаётся); каталог стирается целиком
   * (remove_dir_all: вложенные symlink удаляются как ссылки, а в junction
   * агент заходит как в каталог — стирает содержимое цели, затем получает
   * EBUSY на точке монтирования и останавливается).
   */
  agentDelete(uuid, requestPath, linkMode = 'agent') {
    const jail = this.agentJail(uuid);
    const { path: full } = this.agentResolve(jail, requestPath, linkMode);
    const st = this.osResolve(full, { followFinal: false });
    if (st.error) throw new AgentError('IoError', ERRNO_TEXT[st.error]);
    const entryKind = st.entry.kind;
    const isDir =
      st.node.kind === 'dir' && entryKind !== 'symlink' && !(linkMode === 'nofollow' && entryKind === 'junction');
    if (isDir) {
      try {
        this.removeDirAll(st, linkMode);
      } catch (error) {
        if (error.errno) throw new AgentError('FileSystemError', `Failed to delete: ${ERRNO_TEXT[error.errno]}`);
        throw error;
      }
      return;
    }
    if (!st.parent) throw new AgentError('FileSystemError', `Failed to delete file: ${ERRNO_TEXT.EISDIR}`);
    st.parent.children.delete(st.name);
  }

  removeDirAll(st, linkMode) {
    this.removeChildren(st.node, st.path, linkMode, new Set());
    if (st.entry.kind === 'junction' && linkMode !== 'follow') throw errnoError('EBUSY');
    if (!st.parent) throw errnoError('EBUSY');
    st.parent.children.delete(st.name);
  }

  removeChildren(dirNode, dirPath, linkMode, visited) {
    if (visited.has(dirNode)) return;
    visited.add(dirNode);
    for (const [name, child] of [...dirNode.children]) {
      const childPath = `${dirPath === '/' ? '' : dirPath}/${name}`;
      if (child.kind === 'dir') {
        this.removeChildren(child, childPath, linkMode, visited);
        dirNode.children.delete(name);
        continue;
      }
      if (child.kind === 'junction') {
        if (linkMode === 'nofollow') {
          dirNode.children.delete(name);
          continue;
        }
        const target = this.osResolve(child.target, { followFinal: true });
        if (!target.error && target.node.kind === 'dir') {
          this.removeChildren(target.node, target.path, linkMode, visited);
        }
        if (linkMode === 'follow') {
          dirNode.children.delete(name);
          continue;
        }
        throw errnoError('EBUSY');
      }
      if (child.kind === 'symlink' && linkMode === 'follow') {
        // Наивное удаление «со следованием» стирает и цель ссылки.
        const target = this.osResolve(childPath, { followFinal: true });
        if (!target.error && target.parent) {
          if (target.node.kind === 'dir') this.removeChildren(target.node, target.path, linkMode, visited);
          target.parent.children.delete(target.name);
        }
      }
      dirNode.children.delete(name);
    }
  }

  label(parts) {
    const hostPathValue = hostJoin(parts);
    if (hostPathValue === this.root) return '';
    if (hostPathValue.startsWith(`${this.root}/`)) return hostPathValue.slice(this.root.length);
    if (this.root.startsWith(`${hostPathValue}/`)) return null;
    return `host:${hostPathValue}`;
  }

  displayTarget(hostPathValue) {
    const label = this.label(hostParts(hostPathValue));
    return label === null ? `host:${hostPathValue}` : label || '/';
  }

  /**
   * Снимок дерева: отсортированный список строк. Внутри сервера — '/путь',
   * каталоги с «/» на конце ('/' — сам корень сервера), ссылки — '/путь -> цель',
   * junction — '/путь => цель'; всё вне сервера — с приставкой 'host:'.
   */
  snapshot() {
    const out = [];
    const walk = (node, parts) => {
      for (const [name, child] of node.children) {
        const childParts = [...parts, name];
        const label = this.label(childParts);
        if (label === null) {
          if (child.kind === 'dir') walk(child, childParts);
          continue;
        }
        if (child.kind === 'dir') {
          out.push(`${label}/`);
          walk(child, childParts);
        } else if (child.kind === 'symlink') {
          out.push(`${label} -> ${child.target}`);
        } else if (child.kind === 'junction') {
          out.push(`${label} => ${this.displayTarget(child.target)}`);
        } else {
          out.push(label);
        }
      }
    };
    walk(this.hostRoot, []);
    return out.sort();
  }

  /** Разница между снимком before и текущим состоянием (или снимком after). */
  diff(before, after = this.snapshot()) {
    return diff(before, after);
  }

  /** Есть ли запись по пути внутри сервера (ссылки не раскрываются). */
  exists(serverPath) {
    return !this.osResolve(this.hostPath(serverPath), { followFinal: false }).error;
  }

  /** Есть ли запись по абсолютному пути на хосте. */
  hostExists(hostPathValue) {
    return !this.osResolve(hostPathValue, { followFinal: false }).error;
  }

  /** Содержимое файла (по ссылкам — как ядро) или null. */
  read(serverPath) {
    const st = this.osResolve(this.hostPath(serverPath), { followFinal: true });
    return !st.error && st.node.kind === 'file' ? st.node.content : null;
  }

  /** Удалить запись при подготовке теста (не через агента). */
  remove(serverPath) {
    const st = this.osResolve(this.hostPath(serverPath), { followFinal: false });
    if (!st.error && st.parent) st.parent.children.delete(st.name);
    return this;
  }
}

/**
 * Дерево файлов в памяти: «диск» ноды с каталогом сервера и тем, что вокруг.
 *   createTree({
 *     uuid,       // uuid сервера, корень — '<каталог данных>/<uuid>'
 *     dataDir,    // каталог данных агента, по умолчанию '/var/lib/catalyst'
 *     files: {    // пути внутри сервера
 *       '/server/rust/sv.db': 'текст' | 1234 (размер) | { size, content, mode, mtime },
 *       '/oxide/data/': null,                          // каталог
 *       '/l': { link: 'цель' },                        // symlink (цель — как в readlink)
 *       '/j': { junction: '/srv/shared' },             // junction (как bind mount)
 *     },
 *     host: { '/srv/backup/world.sav': '…' },         // абсолютные пути вне сервера
 *   })
 * Цель ссылки: относительная — от каталога ссылки; '/data/…' — путь внутри
 * сервера так, как его видит контейнер; иной абсолютный — путь на хосте.
 * Имена могут содержать «..», «*», «?», разный регистр — регистр различается.
 * Методы: snapshot(), diff(before), exists(path), hostExists(path), read(path),
 * add(path, spec), addHost(path, spec), remove(path), hostPath(path).
 * Файлы второго сервера на той же ноде: addHost('<dataDir>/<uuid2>/server/rust/x', …).
 * uuid дерева должен совпадать с uuid сервера в панели (createSandbox делает это сам).
 */
export function createTree(spec = {}) {
  return new SandboxTree(spec);
}

/** Что удалено, что добавлено, что осталось: diff(before, after) → { removed, added, kept }. */
export function diff(before, after) {
  const was = new Set(before);
  const now = new Set(after);
  return {
    removed: [...was].filter((item) => !now.has(item)).sort(),
    added: [...now].filter((item) => !was.has(item)).sort(),
    kept: [...was].filter((item) => now.has(item)).sort(),
  };
}

/**
 * Готовое искусственное «дерево сервера Rust» (правила, раздел 5): карта и
 * сохранения (в том числе .sav.N, -wal, -shm), чертежи игроков, конфиги,
 * Oxide и Carbon, RustDedicated_Data и стартовые скрипты, имена с «..», «*»,
 * «?» и разным регистром, ссылки наружу (symlink на каталог вне сервера,
 * относительная ссылка с выходом за корень, junction наружу) и ссылка на
 * файл внутри сервера. Вне сервера: /srv/backup, /srv/shared и каталог
 * соседнего сервера. Возвращает описание для createTree — его можно дополнить.
 * withDataLink: true добавит '/oxide/data/maps -> /data/server/rust' —
 * абсолютную ссылку, которую агент переносит внутрь сервера.
 */
export function rustServerTree({ uuid = DEFAULT_SERVER_UUID, dataDir = DEFAULT_DATA_DIR, withDataLink = false } = {}) {
  const files = {
    '/RustDedicated': { size: 52428800, mode: 0o755 },
    '/RustDedicated_Data/Managed/Assembly-CSharp.dll': 4194304,
    '/RustDedicated_Data/globalgamemanagers': 102400,
    '/start.sh': { content: '#!/bin/sh\n./RustDedicated -batchmode\n', mode: 0o755 },
    '/runds.sh': { content: '#!/bin/sh\nexec ./start.sh\n', mode: 0o755 },
    '/steamapps/appmanifest_258550.acf': 'appmanifest',
    '/server/rust/proceduralmap.3000.12345.270.map': 8388608,
    '/server/rust/proceduralmap.3000.12345.270.sav': 2097152,
    '/server/rust/proceduralmap.3000.12345.270.sav.1': 2097152,
    '/server/rust/proceduralmap.3000.12345.270.sav.2': 2097152,
    '/server/rust/player.blueprints.270.db': 65536,
    '/server/rust/player.blueprints.270.db-wal': 4096,
    '/server/rust/player.blueprints.270.db-shm': 32768,
    '/server/rust/Player.Blueprints.270.DB': 1024,
    '/server/rust/player.deaths.270.db': 16384,
    '/server/rust/player.identities.270.db': 16384,
    '/server/rust/player.states.270.db': 16384,
    '/server/rust/player.tokens.db': 4096,
    '/server/rust/sv.files.270.db': 131072,
    '/server/rust/cfg/server.cfg': 'server.hostname "Rust #1"\n',
    '/server/rust/cfg/users.cfg': 'ownerid 76561198000000000\n',
    '/server/rust/cfg/bans.cfg': '',
    '/oxide/plugins/Kits.cs': '// plugin',
    '/oxide/config/Kits.json': '{}',
    '/oxide/data/Kits.json': '{"kits":[]}',
    '/oxide/data/kits.json': '{"lower":true}',
    '/oxide/data/Kits/keep.json': '{"keep":true}',
    '/oxide/data/Kits/players.json': '{}',
    '/oxide/data/evil..json': '{}',
    '/oxide/data/..hidden': '{}',
    '/oxide/data/star*.json': '{}',
    '/oxide/data/what?.json': '{}',
    '/oxide/data/backup': { link: '/srv/backup' },
    '/oxide/data/up': { link: '../../../other-server' },
    '/oxide/data/cfg-link.json': { link: '../../server/rust/cfg/server.cfg' },
    '/oxide/data/shared': { junction: '/srv/shared' },
    '/oxide/logs/oxide_2026-11-19.txt': 'log',
    '/carbon/data/Kits.json': '{}',
  };
  if (withDataLink) files['/oxide/data/maps'] = { link: '/data/server/rust' };
  return {
    uuid,
    dataDir,
    files,
    host: {
      '/srv/backup/world.sav': 'резервная копия мира',
      '/srv/backup/notes.txt': 'не трогать',
      '/srv/shared/global.json': '{"shared":true}',
      [`${dataDir}/other-server/server/rust/sv.files.270.db`]: 'соседний сервер',
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Подмена файлового туннеля (ctx.fileTunnel)
// ════════════════════════════════════════════════════════════════════════════

/** Операции, которые знает агент: catalyst-agent/src/file_tunnel.rs:299-311. */
const AGENT_OPERATIONS = new Set([
  'list', 'download', 'upload', 'write', 'create', 'delete', 'rename',
  'permissions', 'compress', 'decompress', 'archive-contents', 'install-url',
]);
/** Предел ожидания ответа агента в панели: catalyst-backend/src/services/file-tunnel.ts:52. */
const PANEL_TUNNEL_TIMEOUT_MS = 60000;

function virtualSleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * Подмена файлового туннеля с тем же интерфейсом, что вызывает плагин:
 *   queueRequest(nodeId, operation, serverUuid, path, data?, uploadData?)
 *     → { requestId, success, data, error, contentType }
 * Цепочка как в Catalyst: путь нормализует backend (path-validation.ts:103-124),
 * ответ собирает агент (file_tunnel.rs:326-349 для list, 558-567 для delete),
 * поля ответа передаются как есть (routes/file-tunnel.ts:132-138).
 * Агент эмулирует дерево tree (createTree); ноды кроме nodeId/nodes «не
 * подключены» — как в панели, запрос снимается через 60 с с ошибкой
 * «Agent file operation timed out» (services/file-tunnel.ts:277-286).
 *
 * Режимы (правила проверяются от последнего добавленного; times — сколько раз):
 *   tunnel.fail({ op, path, error, times })            — ответ success:false с текстом;
 *   tunnel.serverNotFound({ op: 'all' | [...], path })  — ответ 'Server not found'
 *                                                         (такого ответа у агента нет — см. ниже);
 *   tunnel.hang({ op, path, panelTimeout })             — не отвечать никогда; с panelTimeout: true —
 *                                                         как настоящая панель, ошибка через 60 с;
 *   tunnel.delay(ms, { op, path })                      — ответить позже (виртуальное время);
 *   tunnel.throws({ op, path, error })                  — отклонить промис (ошибка панели);
 *   tunnel.setLinks('agent' | 'follow' | 'nofollow')    — поведение ссылок (см. agentResolve).
 * op и path — строка, RegExp, функция или массив; op: 'all' — любые.
 * Журнал: tunnel.calls — записи { seq, op, path, rawPath, nodeId, uuid, outcome, error };
 * tunnel.paths('delete') — пути одной операции по порядку.
 */
export function createTunnel({
  tree = createTree(),
  nodeId = DEFAULT_NODE_ID,
  nodes,
  links = 'agent',
  journal = createJournal(),
  panelTimeoutMs = PANEL_TUNNEL_TIMEOUT_MS,
} = {}) {
  const knownNodes = new Set(nodes ?? [nodeId]);
  let linkMode = links;
  const rules = [];
  const hanging = new Set();
  let requestCounter = 0;

  const addRule = (match, action) => {
    const rule = { match: match || {}, action, remaining: match?.times };
    rules.push(rule);
    return () => {
      const index = rules.indexOf(rule);
      if (index >= 0) rules.splice(index, 1);
    };
  };

  const ruleMatches = (rule, request) => {
    const { op, path: pathPattern, nodeId: nodePattern, uuid } = rule.match;
    if (op !== undefined && op !== 'all' && !matchValue(op, request.op)) return false;
    if (pathPattern !== undefined && !matchValue(pathPattern, request.path)) return false;
    if (nodePattern !== undefined && !matchValue(nodePattern, request.nodeId)) return false;
    if (uuid !== undefined && !matchValue(uuid, request.uuid)) return false;
    return true;
  };

  const takeRule = (request) => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index];
      if (rule.remaining !== undefined && rule.remaining <= 0) continue;
      if (!ruleMatches(rule, request)) continue;
      if (rule.remaining !== undefined) rule.remaining -= 1;
      return rule;
    }
    return null;
  };

  const response = (requestId, success, data, error) => ({
    requestId,
    success,
    data,
    error,
    contentType: undefined,
  });

  function runAgent(request) {
    if (request.op === 'list' || request.op === 'delete') {
      try {
        if (request.op === 'list') {
          return response(request.requestId, true, tree.agentList(request.uuid, request.path, linkMode), undefined);
        }
        tree.agentDelete(request.uuid, request.path, linkMode);
        return response(request.requestId, true, undefined, undefined);
      } catch (error) {
        if (error instanceof AgentError) return response(request.requestId, false, undefined, error.message);
        throw error;
      }
    }
    if (AGENT_OPERATIONS.has(request.op)) {
      return response(request.requestId, false, undefined, `песочница: операция агента «${request.op}» не эмулируется`);
    }
    return response(request.requestId, false, undefined, `Unknown operation: ${request.op}`);
  }

  async function respond(request, rule, entry) {
    const action = rule?.action || {};
    if (action.delayMs) await virtualSleep(action.delayMs);
    if (action.hang) {
      journal.update(entry, { outcome: 'hang' });
      if (action.panelTimeout) {
        await virtualSleep(panelTimeoutMs);
        throw new Error('Agent file operation timed out');
      }
      hanging.add(entry);
      return new Promise(() => {});
    }
    if (action.throws) throw action.throws instanceof Error ? action.throws : new Error(String(action.throws));
    if (action.error !== undefined) return response(request.requestId, false, undefined, String(action.error));
    if (action.serverNotFound) return response(request.requestId, false, undefined, 'Server not found');
    if (typeof action.respond === 'function') {
      return { ...response(request.requestId, false, undefined, undefined), ...(await action.respond(request)) };
    }
    if (!knownNodes.has(request.nodeId)) {
      // Нода не подключена: запрос ждёт в очереди панели и снимается по таймауту.
      journal.update(entry, { outcome: 'hang' });
      await virtualSleep(panelTimeoutMs);
      throw new Error('Agent file operation timed out');
    }
    return runAgent(request);
  }

  const tunnel = {
    async queueRequest(requestNodeId, operation, serverUuid, filePath, data, uploadData) {
      await null; // настоящий queueRequest асинхронный ещё до отправки агенту
      const requestId = `req-${++requestCounter}`;
      let normalized;
      try {
        normalized = normalizeRequestPath(filePath);
      } catch (error) {
        journal.push('tunnel', {
          op: operation,
          path: String(filePath),
          rawPath: filePath,
          nodeId: requestNodeId,
          uuid: serverUuid,
          outcome: 'throw',
          error: error.message,
        });
        throw error;
      }
      const request = { requestId, op: operation, path: normalized, rawPath: filePath, nodeId: requestNodeId, uuid: serverUuid };
      const entry = journal.push('tunnel', {
        op: operation,
        path: normalized,
        rawPath: filePath,
        nodeId: requestNodeId,
        uuid: serverUuid,
        requestId,
        data: data === undefined ? undefined : safeClone(data),
        upload: uploadData ? uploadData.length : undefined,
        outcome: 'pending',
      });
      const rule = takeRule(request);
      try {
        const result = await respond(request, rule, entry);
        journal.update(entry, {
          outcome: result.success ? 'ok' : 'error',
          error: result.error,
          count: Array.isArray(result.data) ? result.data.length : undefined,
        });
        return result;
      } catch (error) {
        journal.update(entry, { outcome: 'throw', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    get calls() {
      return journal.of('tunnel');
    },
    /** Пути запросов одной операции по порядку. */
    paths(op) {
      return journal
        .of('tunnel')
        .filter((entry) => !op || entry.op === op)
        .map((entry) => entry.path);
    },
    /** Запросы, оставшиеся без ответа (режим hang). */
    pending() {
      return [...hanging];
    },
    rule: addRule,
    fail({ error = 'Permission denied: Access denied', ...match } = {}) {
      return addRule(match, { error });
    },
    serverNotFound({ op = 'all', ...match } = {}) {
      return addRule({ op, ...match }, { serverNotFound: true });
    },
    hang({ panelTimeout = false, ...match } = {}) {
      return addRule(match, { hang: true, panelTimeout });
    },
    delay(ms, match = {}) {
      return addRule(match, { delayMs: ms });
    },
    throws({ error = 'Too many pending requests for node', ...match } = {}) {
      return addRule(match, { throws: error });
    },
    clear() {
      rules.length = 0;
    },
    setLinks(mode) {
      if (!['agent', 'follow', 'nofollow'].includes(mode)) throw new Error(`песочница: неизвестный режим ссылок ${mode}`);
      linkMode = mode;
    },
    get links() {
      return linkMode;
    },
    tree,
    nodeId,
    describe() {
      return [...hanging].map((entry) => `туннель: без ответа ${entry.op} ${entry.path} (запрос #${entry.seq})`);
    },
  };
  return tunnel;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Подмена панели: ctx.db.servers и REST API через fetch
// ════════════════════════════════════════════════════════════════════════════

/** Поля сервера, которые отдаёт плагину ctx.db.servers: catalyst-backend/src/plugins/context.ts:42-48. */
const SERVER_ALLOWED_SELECT_FIELDS = [
  'id', 'name', 'uuid', 'description', 'status', 'createdAt', 'updatedAt',
  'nodeId', 'ownerId', 'templateId', 'locationId',
  'allocatedMemoryMb', 'allocatedCpuCores', 'allocatedDiskMb', 'allocatedSwapMb',
  'containerId', 'containerName', 'networkMode', 'primaryPort', 'primaryIp',
  'environment', 'startupCommand', 'suspendedAt', 'suspensionReason',
];
const SERVER_DATE_FIELDS = new Set(['createdAt', 'updatedAt', 'suspendedAt']);

/** Шаблон Rust с переменными, как их отдаёт GET /variables (routes/servers/variables.ts:57-72). */
export const RUST_TEMPLATE = Object.freeze({
  id: 'tpl_rust',
  name: 'Rust',
  variables: [
    { name: 'SERVER_HOSTNAME', description: 'Имя сервера', default: 'Rust Server', required: true, input: 'text', rules: ['required', 'string', 'between:1,128'] },
    { name: 'WORLD_SEED', description: 'Сид карты', default: '12345', required: true, input: 'number', rules: ['required', 'integer', 'between:1,2147483647'] },
    { name: 'WORLD_SIZE', description: 'Размер карты', default: '3000', required: true, input: 'number', rules: ['required', 'integer', 'between:1000,6000'] },
    { name: 'MAX_PLAYERS', description: 'Слоты', default: '50', required: true, input: 'number', rules: ['required', 'integer', 'between:1,500'] },
    { name: 'RCON_PASS', description: 'Пароль RCON', default: 'changeme', required: true, input: 'text', rules: ['required', 'string', 'between:1,64'] },
  ],
});

const LOGIN_HTML =
  '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход — Catalyst</title></head>' +
  '<body><form method="post" action="/api/auth/sign-in"><input name="email"><input name="password" type="password"></form></body></html>';

/**
 * Пользователи песочницы по умолчанию (роли — глобальные права из ролей панели):
 *   admin    — права «*»;
 *   owner    — владелец сервера srv1, роли плагина manage и run;
 *   sub      — субпользователь srv1 (ServerAccess: server.read, console.read, file.read), роли плагина;
 *   stranger — чужой: роли плагина есть, доступа к srv1 нет.
 * У каждого есть сессия: cookie 'better-auth.session_token=<session>'.
 * Внимание: в Catalyst пресет роли «User» содержит глобальное server.read
 * (permission-vocabulary.ts:103-107), а глобальное серверное право открывает
 * GET /api/servers/:id любого сервера (server-access.ts:68-71, routes/servers/core.ts:1809-1824).
 * Чтобы проверить такой случай, дайте пользователю permissions: ['server.read', …].
 */
export function defaultUsers() {
  const pluginRoles = ['rust-autowipe.manage', 'rust-autowipe.run'];
  return {
    admin: { id: 'user_admin', username: 'admin', email: 'admin@panel.test', permissions: ['*'], session: 'sess_admin' },
    owner: { id: 'user_owner', username: 'owner', email: 'owner@panel.test', permissions: [...pluginRoles], session: 'sess_owner' },
    sub: {
      id: 'user_sub',
      username: 'sub',
      email: 'sub@panel.test',
      permissions: [...pluginRoles],
      session: 'sess_sub',
      serverAccess: { srv1: ['server.read', 'console.read', 'file.read'] },
    },
    stranger: { id: 'user_stranger', username: 'stranger', email: 'stranger@panel.test', permissions: [...pluginRoles], session: 'sess_stranger' },
  };
}

/** Сервер по умолчанию: srv1 на node1, владелец user_owner, шаблон Rust, статус running. */
export function defaultServer(overrides = {}) {
  return {
    id: 'srv1',
    uuid: DEFAULT_SERVER_UUID,
    nodeId: DEFAULT_NODE_ID,
    ownerId: 'user_owner',
    name: 'Rust #1',
    description: '',
    status: 'running',
    templateId: RUST_TEMPLATE.id,
    template: RUST_TEMPLATE,
    environment: {
      SERVER_HOSTNAME: 'Rust #1',
      WORLD_SEED: '12345',
      WORLD_SIZE: '3000',
      MAX_PLAYERS: '50',
      RCON_PASS: 'rcon-sandbox-secret',
    },
    ...overrides,
  };
}

function parseSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const prefix = `${SESSION_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function rawJson(status, body, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
  };
}

function rawHtml(status, html) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
}

/** Ответ об ошибке, как apiError: catalyst-backend/src/lib/http-error.ts:26-40. */
function apiErrorResponse(status, code, message, params) {
  return rawJson(status, { error: message, code, ...(params ? { params } : {}) });
}

function networkError(url, code = 'ENOTFOUND') {
  const error = new TypeError('fetch failed');
  const parsed = new URL(url);
  error.cause =
    code === 'ECONNREFUSED'
      ? makeError(`connect ECONNREFUSED ${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`, { code })
      : makeError(`getaddrinfo ${code} ${parsed.hostname}`, { code, hostname: parsed.hostname });
  return error;
}

/** Проверка правила переменной: catalyst-backend/src/routes/servers/_helpers.ts:1806-1870. */
function validateVariableRule(value, rule, allRules) {
  const [name, ...rest] = String(rule).split(':');
  const param = rest.join(':');
  if (name === 'between') {
    const [minText, maxText] = param.split(',');
    const min = Number(minText);
    const max = Number(maxText);
    if (Number.isNaN(min) || Number.isNaN(max) || min > max) return null;
    if (allRules.includes('numeric') || allRules.includes('integer')) {
      const number = Number(value);
      return Number.isNaN(number) || number < min || number > max ? `Must be between ${min} and ${max}` : null;
    }
    return value.length < min || value.length > max ? `Must be between ${min} and ${max} characters` : null;
  }
  if (name === 'in') {
    const allowed = param.split(',');
    return allowed.includes(value) ? null : `Must be one of: ${allowed.join(', ')}`;
  }
  if (name === 'regex') {
    let pattern = param;
    if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) pattern = pattern.slice(1, -1);
    try {
      return new RegExp(pattern).test(value) ? null : 'Invalid format';
    } catch {
      return 'Invalid rule configuration';
    }
  }
  return null;
}

/**
 * Подмена панели: сервера (состояние в памяти), ctx.db.servers и REST API.
 *   const panel = createPanel({ base, apiKey, servers: [defaultServer()], users: defaultUsers() });
 *   panel.install()  — globalThis.fetch = подмена; panel.restore() — вернуть прежний fetch.
 *
 * REST (как в Catalyst v1.89.2):
 *   GET   /api/servers/:id             — проверка доступа (routes/servers/core.ts:1771-1838);
 *   POST  /api/servers/:id/stop|start  — питание (routes/servers/power.ts:759-1094, state-machine.ts:81-90);
 *   POST  /api/servers/:id/kill|restart — упрощённо;
 *   POST  /api/servers/:id/console/command — консоль (routes/console-stream.ts:166-288);
 *   GET/PATCH /api/servers/:id/variables — переменные (routes/servers/variables.ts:12-240);
 *   GET   /api/servers/:id/permissions — список доступа сервера (routes/servers/invites.ts:39-72);
 *   GET   /api/servers                 — список (для ping);
 *   GET   /login                       — страница входа (HTML).
 * Вход — ключом 'Bearer catalyst…' или cookie сессии (middleware/authenticate.ts:93-247).
 * Панель отвечает на base и на внутренних адресах http://127.0.0.1:<PORT|3000>
 * и http://localhost:<PORT|3000> (так плагин зовёт панель без panelUrl);
 * чужие адреса — сетевая ошибка ENOTFOUND, если не задан panel.host(origin, handler).
 * Переходы (redirect) — как fetch в Node (undici): до 20, POST→GET на 301/302/303,
 * при смене origin выбрасываются заголовки authorization, cookie, proxy-authorization, host.
 *
 * Сервер — конечный автомат. panel.behave(id, { stop, start, stopMs, startMs, startingMs, stopAckMs }):
 *   stop:  'normal' — stopping → stopped через stopMs (по умолчанию 3 с; ответ на POST придёт,
 *                     когда сервер остановится: панель ждёт ack агента до 60 с, power.ts:14-16);
 *          'never'  — не останавливается: висит в stopping, ответ 202 через 60 с;
 *          stopAckMs — ответить на POST /stop через столько мс в любом случае (что-если);
 *          внимание: api.js плагина ждёт ответа 20 с — остановка дольше 20 с даёт ему таймаут;
 *   start: 'normal' — starting → running через startMs;
 *          'never'  — не запускается: starting → stopped через startMs;
 *          'crash'  — starting → crashed через startMs;
 *          'slow'   — долго висит в starting: running через startingMs (по умолчанию 10 мин);
 *          'stuck'  — навсегда starting.
 * panel.crash(id), panel.suspend(id, { status }), panel.unsuspend(id), panel.setStatus(id, s).
 * Проверка доступа: panel.setAccess(mode, { scope: 'access' | 'all', loginOrigin }):
 *   'panel'        — решение панели по правам (по умолчанию);
 *   'ok'           — всегда 200 JSON; 'forbidden' — всегда 403 JSON;
 *   'login-200'    — 200 и HTML страницы входа (panelUrl указывает не на API);
 *   'redirect-302' — 302 на страницу входа, после перехода — 200 HTML.
 * scope 'access' — только GET /api/servers/:id; 'all' — все запросы к панели.
 * Сбои: panel.fail({ method, path, status, body, network, times }), panel.hang({ method, path }),
 * panel.delay(ms, { method, path }). Журнал: panel.calls — записи { method, url, origin,
 * path, headers, cookie, authorization, body, status, redirectedFrom, serverStatus }.
 */
export function createPanel({
  base = DEFAULT_PANEL_BASE,
  origins,
  apiKey = DEFAULT_API_KEY,
  apiKeyOwner = 'user_admin',
  apiKeyPermissions = ['*'],
  servers = [defaultServer()],
  users = defaultUsers(),
  journal = createJournal(),
  access = 'panel',
} = {}) {
  const baseUrl = new URL(base);
  const panelBase = baseUrl.origin + baseUrl.pathname.replace(/\/+$/, '');
  const port = Number(process.env.PORT) || 3000;
  const panelOrigins = new Set(
    (origins ?? [baseUrl.origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`]).map((item) => new URL(item).origin),
  );
  const foreignHosts = new Map();
  const userList = Object.values(users || {});
  const usersById = new Map(userList.map((user) => [user.id, user]));
  const sessions = new Map(
    userList.filter((user) => user.session !== false).map((user) => [user.session ?? `sess_${user.id}`, user.id]),
  );
  const accessRows = [];
  for (const user of userList) {
    for (const [serverId, permissions] of Object.entries(user.serverAccess || {})) {
      accessRows.push({ userId: user.id, serverId, permissions: [...permissions] });
    }
  }
  const apiKeys = new Map();
  if (apiKey) apiKeys.set(apiKey, { id: 'key_sandbox', ownerId: apiKeyOwner, permissions: [...apiKeyPermissions] });

  const records = new Map();
  const consoleLog = [];
  const rules = [];
  let accessMode = access;
  let accessScope = 'access';
  let loginOrigin = null;
  let installed = false;
  let previousFetch = null;
  let requestCounter = 0;
  const hanging = new Set();

  function addServer(spec) {
    const now = Date.now();
    const record = {
      ...defaultServer(),
      ...spec,
      environment: { ...(spec.environment ?? defaultServer().environment) },
      template: spec.template ?? RUST_TEMPLATE,
      createdAt: spec.createdAt ? toMs(spec.createdAt) : now,
      updatedAt: spec.updatedAt ? toMs(spec.updatedAt) : now,
      suspendedAt: spec.suspendedAt ? toMs(spec.suspendedAt) : null,
      suspensionReason: spec.suspensionReason ?? null,
      nodeOnline: spec.nodeOnline !== false,
      behavior: { stop: 'normal', start: 'normal', stopMs: 3000, startMs: 5000, startingMs: 600000, ...(spec.behavior || {}) },
      history: [],
      timer: null,
    };
    records.set(record.id, record);
    return record;
  }
  for (const spec of servers) addServer(spec);

  function recordOf(id) {
    const record = records.get(id);
    if (!record) throw new Error(`песочница: нет сервера ${id}`);
    return record;
  }

  function setStatus(record, to, cause) {
    if (record.status === to) return;
    const from = record.status;
    record.status = to;
    record.updatedAt = Date.now();
    record.history.push({ at: record.updatedAt, from, to, cause });
    journal.push('server', { id: record.id, from, to, cause });
  }

  function clearTransition(record) {
    if (record.timer) globalThis.clearTimeout(record.timer);
    record.timer = null;
  }

  function scheduleTransition(record, to, delayMs, cause) {
    clearTransition(record);
    record.timer = globalThis.setTimeout(() => {
      record.timer = null;
      setStatus(record, to, cause);
    }, delayMs);
  }

  function authenticate(request) {
    const authorization = request.headers.get('authorization');
    if (authorization && authorization.startsWith('Bearer ')) {
      const token = authorization.slice(7);
      if (token.startsWith('catalyst')) {
        const key = apiKeys.get(token);
        if (!key) return { error: rawJson(401, { error: 'Invalid API key' }) };
        const owner = usersById.get(key.ownerId);
        return {
          user: {
            userId: key.ownerId,
            email: owner?.email,
            username: owner?.username,
            permissions: [...key.permissions],
            apiKeyId: key.id,
          },
        };
      }
    }
    const token = parseSessionToken(request.headers.get('cookie'));
    const userId = token ? sessions.get(token) : null;
    const user = userId ? usersById.get(userId) : null;
    if (!user) return { error: rawJson(401, { error: 'Unauthorized' }) };
    if (user.banned) return { error: rawJson(403, { error: 'Account is banned', code: 'ACCOUNT_BANNED' }) };
    return { user: { userId: user.id, email: user.email, username: user.username, permissions: [...(user.permissions || [])] } };
  }

  const rowOf = (userId, serverId) => accessRows.find((row) => row.userId === userId && row.serverId === serverId);

  function publicServer(record, actor) {
    const owner = usersById.get(record.ownerId);
    const row = rowOf(actor.userId, record.id);
    let effective;
    if (record.ownerId === actor.userId || hasGrant(actor.permissions, 'admin.write')) effective = [...ALL_SERVER_PERMISSIONS];
    else if (row) effective = [...row.permissions];
    else effective = actor.permissions.filter((permission) => ALL_SERVER_PERMISSIONS.includes(permission));
    return {
      id: record.id,
      name: record.name,
      uuid: record.uuid,
      description: record.description,
      status: record.status,
      nodeId: record.nodeId,
      ownerId: record.ownerId,
      templateId: record.templateId,
      template: { id: record.template.id, name: record.template.name },
      environment: { ...record.environment },
      suspendedAt: record.suspendedAt ? isoOf(record.suspendedAt) : null,
      suspensionReason: record.suspensionReason,
      createdAt: isoOf(record.createdAt),
      updatedAt: isoOf(record.updatedAt),
      effectivePermissions: effective,
      owner: owner ? { id: owner.id, username: owner.username, email: owner.email, name: owner.username } : null,
    };
  }

  function getServer(request, id) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const actor = auth.user;
    const record = records.get(id);
    if (!record) return apiErrorResponse(404, 'SERVER_NOT_FOUND', 'Server not found');
    if (actor.apiKeyId && !hasGrant(actor.permissions, 'server.read')) {
      return apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
    }
    const isOwner = record.ownerId === actor.userId;
    const hasExplicit = accessRows.some((row) => row.serverId === id && row.userId === actor.userId);
    if (!isOwner && !hasExplicit) {
      const decision = decideServerAccess({
        isOwner: false,
        hasExplicitServerAccess: false,
        rolePermissions: actor.permissions,
        requiredPermission: 'server.read',
      });
      const hasServerGrant = actor.permissions.some((permission) => ALL_SERVER_PERMISSIONS.includes(permission));
      if (!decision && !hasServerGrant) return apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
    }
    return rawJson(200, { success: true, data: publicServer(record, actor) });
  }

  function listServers(request) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const actor = auth.user;
    const visible = [...records.values()].filter(
      (record) =>
        hasGrant(actor.permissions, 'admin.read') ||
        record.ownerId === actor.userId ||
        Boolean(rowOf(actor.userId, record.id)),
    );
    return rawJson(200, { success: true, data: visible.map((record) => publicServer(record, actor)) });
  }

  function suspendedResponse(record) {
    // ensureNotSuspended: catalyst-backend/src/routes/servers/_helpers.ts:1400-1414.
    return rawJson(423, {
      error: 'Server is suspended',
      code: 'SERVER_SUSPENDED',
      suspendedAt: isoOf(record.suspendedAt),
      suspensionReason: record.suspensionReason ?? null,
    });
  }

  function powerAllowed(actor, record, permissions, requireAll = false) {
    // ensurePowerAccess: catalyst-backend/src/routes/servers/power.ts:56-110.
    if (actor.apiKeyId) {
      const check = (permission) => hasGrant(actor.permissions, permission);
      const ceiling = requireAll ? permissions.every(check) : permissions.some(check);
      if (!ceiling) return apiErrorResponse(403, 'PERMISSION_DENIED', 'API key scope does not permit this operation');
    }
    if (record.ownerId === actor.userId) return null;
    if (hasGrant(actor.permissions, 'admin.write')) return null;
    const row = rowOf(actor.userId, record.id);
    const decisions = permissions.map(
      (permission) =>
        Boolean(row && row.permissions.some((granted) => hasGrant([granted], permission))) ||
        Boolean(decideServerAccess({ isOwner: false, hasExplicitServerAccess: false, rolePermissions: actor.permissions, requiredPermission: permission })),
    );
    const allowed = requireAll ? decisions.every(Boolean) : decisions.some(Boolean);
    return allowed ? null : apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
  }

  async function power(request, id, action) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const record = records.get(id);
    if (!record) return apiErrorResponse(404, 'SERVER_NOT_FOUND', 'Server not found');
    if (record.suspendedAt) return suspendedResponse(record);
    const permissions =
      action === 'restart' ? ['server.start', 'server.stop'] : [`server.${action === 'kill' ? 'kill' : action}`];
    const denied = powerAllowed(auth.user, record, permissions, action === 'restart');
    if (denied) return denied;
    const status = record.status;
    const requestId = `pwr-${++requestCounter}`;
    const behavior = record.behavior;
    if (action === 'start') {
      if (!['stopped', 'crashed', 'suspended', 'error'].includes(status)) {
        return apiErrorResponse(409, 'SERVER_STATE_TRANSITION_INVALID', `Cannot start server in ${status} state. Server must be stopped or crashed.`, { status });
      }
      if (!record.nodeOnline) return apiErrorResponse(503, 'NODE_OFFLINE', 'Node is offline');
      clearTransition(record);
      setStatus(record, 'starting', 'POST /start');
      if (behavior.start === 'normal') scheduleTransition(record, 'running', behavior.startMs, 'агент: сервер запущен');
      else if (behavior.start === 'never') scheduleTransition(record, 'stopped', behavior.startMs, 'агент: процесс сразу завершился');
      else if (behavior.start === 'crash') scheduleTransition(record, 'crashed', behavior.startMs, 'агент: сервер упал при запуске');
      else if (behavior.start === 'slow') scheduleTransition(record, 'running', behavior.startingMs, 'агент: сервер запущен после долгого starting');
      return rawJson(200, {
        success: true,
        accepted: true,
        acked: true,
        requestId,
        message: 'Start command accepted by agent; completion is asynchronous',
      });
    }
    if (action === 'stop' || action === 'kill') {
      if (!['running', 'starting', 'error', 'crashed'].includes(status)) {
        return apiErrorResponse(409, 'SERVER_STATE_TRANSITION_INVALID', `Cannot stop server in ${status} state. Server must be running or starting.`, { status });
      }
      if (status === 'crashed') {
        clearTransition(record);
        setStatus(record, 'stopped', `POST /${action}: сервер уже упал`);
        return rawJson(200, { success: true, message: 'Server marked as stopped' });
      }
      if (!record.nodeOnline) return apiErrorResponse(503, 'NODE_OFFLINE', 'Node is offline');
      clearTransition(record);
      if (action === 'kill') {
        setStatus(record, 'stopped', 'POST /kill');
        return rawJson(200, { success: true, acked: true, requestId, message: 'Kill command completed by agent' });
      }
      setStatus(record, 'stopping', 'POST /stop');
      // Сервер останавливается сам по себе, даже если плагин бросит ждать ответа.
      if (behavior.stop === 'normal') scheduleTransition(record, 'stopped', behavior.stopMs, 'агент: сервер остановлен');
      // Панель ждёт ack агента до 60 с (power.ts:14-16, 1040-1094): ack приходит,
      // когда сервер остановлен. stopAckMs — ответить через заданное время в любом случае.
      const explicitAck = behavior.stopAckMs !== undefined && behavior.stopAckMs !== null;
      const stopsInTime = behavior.stop === 'normal' && behavior.stopMs <= PANEL_TUNNEL_TIMEOUT_MS;
      const ackAfter = explicitAck ? behavior.stopAckMs : stopsInTime ? behavior.stopMs : PANEL_TUNNEL_TIMEOUT_MS;
      await waitSignal(ackAfter, request.signal);
      if (explicitAck || stopsInTime) {
        return rawJson(200, { success: true, acked: true, requestId, message: 'Stop command completed by agent' });
      }
      return rawJson(202, {
        success: true,
        accepted: true,
        async: true,
        timedOutWaitingForAck: true,
        requestId,
        message: 'Stop command sent; agent ack timed out — completion is asynchronous',
      });
    }
    // restart — упрощённо: stopping → starting → running.
    if (!['running', 'stopped', 'error', 'crashed'].includes(status)) {
      return apiErrorResponse(409, 'SERVER_STATE_TRANSITION_INVALID', `Cannot restart server in ${status} state.`, { status });
    }
    clearTransition(record);
    setStatus(record, 'starting', 'POST /restart');
    scheduleTransition(record, 'running', behavior.startMs, 'агент: сервер перезапущен');
    return rawJson(200, { success: true, accepted: true, requestId, message: 'Restart command accepted by agent' });
  }

  function consoleCommand(request, id, body) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const actor = auth.user;
    const command = body?.command;
    if (!command || typeof command !== 'string' || !command.trim()) {
      return apiErrorResponse(400, 'VALIDATION_ERROR', 'Command is required');
    }
    const trimmed = command.trim();
    if (trimmed.length > 4096) {
      return apiErrorResponse(400, 'VALIDATION_ERROR', 'Command exceeds maximum length (4096 characters)');
    }
    const record = records.get(id);
    if (!record) return apiErrorResponse(404, 'SERVER_NOT_FOUND', 'Server not found');
    const row = rowOf(actor.userId, id);
    const allowed =
      hasGrant(actor.permissions, 'admin.write') ||
      Boolean(row?.permissions.includes('console.write')) ||
      record.ownerId === actor.userId ||
      actor.permissions.includes('console.write');
    if (!allowed) return apiErrorResponse(403, 'PERMISSION_DENIED', 'PERMISSION_DENIED');
    if (actor.apiKeyId && !hasGrant(actor.permissions, 'console.write')) {
      return apiErrorResponse(403, 'PERMISSION_DENIED', 'PERMISSION_DENIED');
    }
    if (record.suspendedAt) return apiErrorResponse(403, 'SERVER_SUSPENDED', 'Server is suspended');
    // Панель статус сервера не проверяет: команда уходит агенту как есть.
    consoleLog.push({ at: Date.now(), serverId: id, command: trimmed, status: record.status });
    return rawJson(202, { success: true, timestamp: new Date().toISOString() });
  }

  function variablesOf(record) {
    return (record.template?.variables || []).map((definition) => ({
      name: definition.name,
      description: definition.description ?? '',
      default: definition.default ?? '',
      required: definition.required ?? false,
      input: definition.input ?? 'text',
      rules: definition.rules ?? [],
      value: String(record.environment[definition.name] ?? definition.default ?? ''),
    }));
  }

  function getVariables(request, id) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const actor = auth.user;
    const record = records.get(id);
    if (!record) return apiErrorResponse(404, 'SERVER_NOT_FOUND', 'Server not found');
    if (actor.apiKeyId && !hasGrant(actor.permissions, 'server.read')) {
      return apiErrorResponse(403, 'PERMISSION_DENIED', 'API key scope does not permit this operation');
    }
    if (record.ownerId !== actor.userId) {
      const row = rowOf(actor.userId, id);
      const allowed =
        Boolean(row && row.permissions.includes('server.read')) ||
        hasGrant(actor.permissions, 'admin.read') ||
        hasGrant(actor.permissions, 'server.read');
      if (!allowed) return apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
    }
    return rawJson(200, { success: true, data: variablesOf(record) });
  }

  function patchVariables(request, id, body) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const actor = auth.user;
    const record = records.get(id);
    if (!record) return apiErrorResponse(404, 'SERVER_NOT_FOUND', 'Server not found');
    if (record.suspendedAt) return suspendedResponse(record);
    if (actor.apiKeyId && !hasGrant(actor.permissions, 'server.startup')) {
      return apiErrorResponse(403, 'PERMISSION_DENIED', 'API key scope does not permit this operation');
    }
    if (record.ownerId !== actor.userId) {
      const row = rowOf(actor.userId, id);
      const allowed =
        hasGrant(row?.permissions ?? [], 'server.startup') ||
        actor.permissions.includes('*') ||
        actor.permissions.includes('admin.write') ||
        hasGrant(actor.permissions, 'server.startup');
      if (!allowed) return apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
    }
    const source = body && typeof body === 'object' ? body : {};
    const environment = { ...record.environment };
    const fields = {};
    for (const definition of record.template?.variables || []) {
      const name = definition.name;
      const present = name in source;
      const submitted = source[name];
      if (definition.required && (!present || submitted === undefined || submitted === null || String(submitted).trim() === '')) {
        fields[name] = 'This field is required';
        continue;
      }
      if (!present) continue;
      const text = String(submitted);
      if (definition.input === 'number' && text.trim() !== '' && Number.isNaN(Number(text))) {
        fields[name] = 'Must be a valid number';
        continue;
      }
      let failure = null;
      for (const rule of definition.rules || []) {
        failure = validateVariableRule(text, rule, definition.rules || []);
        if (failure) break;
      }
      if (failure) {
        fields[name] = failure;
        continue;
      }
      environment[name] = text;
    }
    if (Object.keys(fields).length) {
      return rawJson(422, { error: 'Validation failed', code: 'VALIDATION_ERROR', fields });
    }
    record.environment = environment;
    record.updatedAt = Date.now();
    return rawJson(200, { success: true, data: { ...environment } });
  }

  function accessOverride(url) {
    if (accessMode === 'ok') {
      // Ответ как у панели для владельца: настоящие данные сервера, без проверки прав.
      const match = /^\/api\/servers\/([^/]+)$/.exec(url.pathname);
      const record = match ? records.get(decodeURIComponent(match[1])) : null;
      if (record) return rawJson(200, { success: true, data: publicServer(record, { userId: record.ownerId, permissions: [] }) });
      return rawJson(200, { success: true, data: {} });
    }
    if (accessMode === 'forbidden') return apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
    if (accessMode === 'login-200') return rawHtml(200, LOGIN_HTML);
    if (accessMode === 'redirect-302') {
      const target = new URL('/login', loginOrigin ?? url.origin);
      target.searchParams.set('next', url.pathname);
      return { status: 302, headers: { location: target.href }, body: '' };
    }
    return null;
  }

  async function routePanel(url, request) {
    const pathname = url.pathname;
    const method = request.method;
    const isAccessCheck = method === 'GET' && /^\/api\/servers\/[^/]+$/.test(pathname);
    if (accessMode !== 'panel' && (accessScope === 'all' || isAccessCheck) && pathname !== '/login') {
      const override = accessOverride(url);
      if (override) return override;
    }
    const contentType = request.headers.get('content-type') || '';
    let body;
    if (contentType.includes('application/json')) {
      if (!request.bodyText) {
        return rawJson(400, {
          statusCode: 400,
          code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
          error: 'Bad Request',
          message: "Body cannot be empty when content-type is set to 'application/json'",
        });
      }
      try {
        body = JSON.parse(request.bodyText);
      } catch {
        return rawJson(400, {
          statusCode: 400,
          code: 'FST_ERR_CTP_INVALID_JSON_BODY',
          error: 'Bad Request',
          message: "Body is not valid JSON but content-type is set to 'application/json'",
        });
      }
    }
    if (method === 'GET' && pathname === '/login') return rawHtml(200, LOGIN_HTML);
    if (method === 'GET' && pathname === '/api/servers') return listServers(request);
    let match = /^\/api\/servers\/([^/]+)$/.exec(pathname);
    if (match && method === 'GET') return getServer(request, decodeURIComponent(match[1]));
    match = /^\/api\/servers\/([^/]+)\/(start|stop|restart|kill)$/.exec(pathname);
    if (match && method === 'POST') return power(request, decodeURIComponent(match[1]), match[2]);
    match = /^\/api\/servers\/([^/]+)\/console\/command$/.exec(pathname);
    if (match && method === 'POST') return consoleCommand(request, decodeURIComponent(match[1]), body);
    match = /^\/api\/servers\/([^/]+)\/variables$/.exec(pathname);
    if (match && method === 'GET') return getVariables(request, decodeURIComponent(match[1]));
    if (match && method === 'PATCH') return patchVariables(request, decodeURIComponent(match[1]), body);
    match = /^\/api\/servers\/([^/]+)\/permissions$/.exec(pathname);
    if (match && method === 'GET') return getServerPermissions(request, decodeURIComponent(match[1]));
    return rawJson(404, { message: `Route ${method}:${pathname} not found`, error: 'Not Found', statusCode: 404 });
  }

  /**
   * Список доступа сервера — как GET /api/servers/:serverId/permissions в Catalyst v1.89.2
   * (catalyst-backend/src/routes/servers/invites.ts:39-72): роут требует server.read, пускает
   * владельца, admin.write и «*», запись ServerAccess (canAccessServer) и отдаёт все записи
   * доступа этого сервера с краткими данными пользователя.
   */
  function getServerPermissions(request, id) {
    const auth = authenticate(request);
    if (auth.error) return auth.error;
    const actor = auth.user;
    const record = records.get(id);
    if (!record) return apiErrorResponse(404, 'SERVER_NOT_FOUND', 'Server not found');
    if (actor.apiKeyId && !hasGrant(actor.permissions, 'server.read')) {
      return apiErrorResponse(403, 'PERMISSION_DENIED', 'API key scope does not permit this operation');
    }
    if (record.ownerId !== actor.userId) {
      const allowed =
        Boolean(rowOf(actor.userId, id)) ||
        actor.permissions.includes('*') ||
        actor.permissions.includes('admin.write');
      if (!allowed) return apiErrorResponse(403, 'PERMISSION_DENIED', 'Forbidden');
    }
    const data = accessRows
      .filter((row) => row.serverId === id)
      .map((row, index) => {
        const user = usersById.get(row.userId);
        return {
          id: `access_${index + 1}`,
          userId: row.userId,
          serverId: row.serverId,
          permissions: [...row.permissions],
          user: user ? { id: user.id, email: user.email ?? null, username: user.username ?? null } : null,
        };
      });
    return rawJson(200, { success: true, data, presets: {} });
  }

  function waitSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = globalThis.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        globalThis.clearTimeout(timer);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function hangUntilAbort(signal, entry) {
    hanging.add(entry);
    return new Promise((_resolve, reject) => {
      if (!signal) return;
      const onAbort = () => {
        hanging.delete(entry);
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  const ruleMatches = (rule, hop) => {
    const { method, path: pathPattern, origin } = rule.match;
    if (method !== undefined && !matchValue(method, hop.method)) return false;
    if (pathPattern !== undefined && !matchValue(pathPattern, hop.path)) return false;
    if (origin !== undefined && !matchValue(origin, hop.origin)) return false;
    return true;
  };

  const takeRule = (hop) => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index];
      if (rule.remaining !== undefined && rule.remaining <= 0) continue;
      if (!ruleMatches(rule, hop)) continue;
      if (rule.remaining !== undefined) rule.remaining -= 1;
      return rule;
    }
    return null;
  };

  const addRule = (match, action) => {
    const rule = { match: match || {}, action, remaining: match?.times };
    rules.push(rule);
    return () => {
      const index = rules.indexOf(rule);
      if (index >= 0) rules.splice(index, 1);
    };
  };

  async function handleHop(hop, entry) {
    const rule = takeRule(hop);
    const action = rule?.action || {};
    if (action.delayMs) await waitSignal(action.delayMs, hop.signal);
    if (action.hang) {
      journal.update(entry, { outcome: 'hang' });
      return hangUntilAbort(hop.signal, entry);
    }
    if (action.network) throw networkError(hop.url, action.network === true ? 'ECONNREFUSED' : action.network);
    if (action.status !== undefined) {
      const payload = action.body ?? { error: `песочница: сбой ${action.status}` };
      return typeof payload === 'string'
        ? { status: action.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...(action.headers || {}) }, body: payload }
        : rawJson(action.status, payload, action.headers);
    }
    const url = new URL(hop.url);
    if (panelOrigins.has(url.origin)) return routePanel(url, hop);
    const foreign = foreignHosts.get(url.origin);
    if (foreign) {
      const result = await foreign({ method: hop.method, url: hop.url, headers: Object.fromEntries(hop.headers), body: hop.bodyText });
      return result ?? rawJson(200, { success: true });
    }
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]';
    throw networkError(hop.url, local ? 'ECONNREFUSED' : 'ENOTFOUND');
  }

  function toResponse(raw, url, redirected) {
    const nullBody = [101, 204, 205, 304].includes(raw.status);
    const response = new Response(nullBody ? null : raw.body ?? '', { status: raw.status, headers: raw.headers });
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
  }

  function serverStatusFor(pathname) {
    const match = /^\/api\/servers\/([^/]+)/.exec(pathname);
    if (!match) return undefined;
    const record = records.get(decodeURIComponent(match[1]));
    return record ? record.status : undefined;
  }

  async function fakeFetch(input, init = {}) {
    let url;
    let method;
    let headers;
    let bodyText;
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      headers = new Headers(input.headers);
      bodyText = input.body ? await input.text() : undefined;
    } else {
      url = String(input instanceof URL ? input.href : input);
      method = 'GET';
      headers = new Headers();
    }
    if (init.method) method = String(init.method).toUpperCase();
    if (init.headers) headers = new Headers(init.headers);
    if (init.body !== undefined && init.body !== null) bodyText = typeof init.body === 'string' ? init.body : String(init.body);
    const signal = init.signal ?? null;
    const redirectMode = init.redirect ?? 'follow';
    if (signal?.aborted) throw signal.reason;
    let redirects = 0;
    let previous = null;
    for (;;) {
      const parsed = new URL(url);
      const hop = { url, method, headers, bodyText, signal, origin: parsed.origin, path: parsed.pathname };
      let body = bodyText;
      try {
        body = bodyText !== undefined ? JSON.parse(bodyText) : undefined;
      } catch {
        /* тело не JSON — оставляем текстом */
      }
      const entry = journal.push('fetch', {
        method,
        url,
        origin: parsed.origin,
        path: parsed.pathname,
        query: parsed.search,
        headers: Object.fromEntries(headers),
        cookie: headers.has('cookie'),
        authorization: headers.has('authorization'),
        body,
        redirectedFrom: previous,
        hop: redirects,
        serverStatus: panelOrigins.has(parsed.origin) ? serverStatusFor(parsed.pathname) : undefined,
        outcome: 'pending',
      });
      let raw;
      try {
        raw = await handleHop(hop, entry);
      } catch (error) {
        hanging.delete(entry);
        journal.update(entry, {
          outcome: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'aborted' : 'error',
          error: error?.cause?.message ?? error?.message ?? String(error),
        });
        throw error;
      }
      const location = raw.headers?.location;
      journal.update(entry, { outcome: 'done', status: raw.status, contentType: raw.headers?.['content-type'], location });
      if ([301, 302, 303, 307, 308].includes(raw.status) && location && redirectMode !== 'manual') {
        if (redirectMode === 'error') {
          throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
        }
        if (redirects >= 20) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('redirect count exceeded') });
        redirects += 1;
        const next = new URL(location, url);
        if (([301, 302].includes(raw.status) && method === 'POST') || (raw.status === 303 && !['GET', 'HEAD'].includes(method))) {
          method = 'GET';
          bodyText = undefined;
          for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) {
            headers.delete(name);
          }
        }
        if (next.origin !== parsed.origin) {
          // Как undici в Node: при смене origin учётные заголовки не уходят дальше.
          headers.delete('authorization');
          headers.delete('proxy-authorization');
          headers.delete('cookie');
          headers.delete('host');
        }
        previous = url;
        url = next.href;
        continue;
      }
      return toResponse(raw, url, redirects > 0);
    }
  }
  fakeFetch[FAKE_FETCH] = 'панель';

  const db = {
    async findUnique(args) {
      await null;
      const where = args?.where;
      if (!where || (where.id === undefined && where.uuid === undefined)) {
        throw new Error(
          'Invalid `prisma.server.findUnique()` invocation: Argument `where` of type ServerWhereUniqueInput needs at least one of `id` or `uuid` arguments.',
        );
      }
      let record = where.id !== undefined ? records.get(where.id) : [...records.values()].find((item) => item.uuid === where.uuid);
      // Прочие поля where (как extendedWhereUnique в Prisma) — дополнительное равенство.
      for (const [key, value] of Object.entries(where)) {
        if (record && key !== 'id' && key !== 'uuid' && value !== undefined && record[key] !== value) record = undefined;
      }
      journal.push('db', { table: 'servers', op: 'findUnique', filter: where, count: record ? 1 : 0, status: record?.status });
      if (!record) return null;
      const select = args.select && typeof args.select === 'object' ? args.select : null;
      const allowed = SERVER_ALLOWED_SELECT_FIELDS.filter((field) => !select || select[field]);
      const fields = allowed.length ? allowed : SERVER_ALLOWED_SELECT_FIELDS;
      const out = {};
      for (const field of fields) {
        const value = record[field];
        if (SERVER_DATE_FIELDS.has(field)) out[field] = value ? new REAL.Date(value) : null;
        else if (field === 'environment') out[field] = { ...record.environment };
        else out[field] = value === undefined ? null : value;
      }
      return out;
    },
    async findMany() {
      await null;
      return Promise.all([...records.keys()].map((id) => db.findUnique({ where: { id } })));
    },
    async count() {
      await null;
      return records.size;
    },
    async update(id, data) {
      await null;
      const record = recordOf(id);
      if (data.status !== undefined) setStatus(record, data.status, 'плагин: ctx.db.servers.update');
      return db.findUnique({ where: { id } });
    },
  };

  const panel = {
    base: panelBase,
    apiKey,
    fetch: fakeFetch,
    db,
    journal,
    /** Подставить подмену в globalThis.fetch. */
    install() {
      if (installed) return panel;
      previousFetch = globalThis.fetch;
      globalThis.fetch = fakeFetch;
      installed = true;
      onTestCleanup(() => panel.restore());
      return panel;
    },
    /** Вернуть fetch, который был до install() (обычно — сторож сети). */
    restore() {
      if (!installed) return;
      if (globalThis.fetch === fakeFetch) globalThis.fetch = previousFetch;
      installed = false;
    },
    get calls() {
      return journal.of('fetch');
    },
    /** Запись сервера (живой объект состояния). */
    server: (id) => recordOf(id),
    status: (id) => recordOf(id).status,
    history: (id) => recordOf(id).history.map((item) => ({ ...item })),
    /** Команды консоли: [{ at, serverId, command, status }] — status на момент команды. */
    console: (id) => consoleLog.filter((item) => !id || item.serverId === id).map((item) => ({ ...item })),
    addServer,
    setStatus(id, status, cause = 'тест') {
      const record = recordOf(id);
      clearTransition(record);
      setStatus(record, status, cause);
    },
    behave(id, behavior) {
      Object.assign(recordOf(id).behavior, behavior);
      return panel;
    },
    crash(id) {
      const record = recordOf(id);
      clearTransition(record);
      setStatus(record, 'crashed', 'агент: сервер упал');
    },
    /** Приостановить: suspendedAt = сейчас и статус status (как POST /suspend: power.ts:1404-1460). */
    suspend(id, { status = 'suspended', reason = null } = {}) {
      const record = recordOf(id);
      clearTransition(record);
      record.suspendedAt = Date.now();
      record.suspensionReason = reason;
      setStatus(record, status, 'панель: сервер приостановлен');
    },
    unsuspend(id, { status = 'stopped' } = {}) {
      const record = recordOf(id);
      record.suspendedAt = null;
      record.suspensionReason = null;
      setStatus(record, status, 'панель: приостановка снята');
    },
    setNodeOnline(id, online) {
      recordOf(id).nodeOnline = Boolean(online);
    },
    setAccess(mode, { scope = 'access', loginOrigin: origin = null } = {}) {
      if (!['panel', 'ok', 'forbidden', 'login-200', 'redirect-302'].includes(mode)) {
        throw new Error(`песочница: неизвестный режим проверки доступа ${mode}`);
      }
      accessMode = mode;
      accessScope = scope;
      loginOrigin = origin ? new URL(origin).origin : null;
      return panel;
    },
    /** Ещё один origin, который отвечает как панель (страница входа внешнего SSO и т. п.). */
    addOrigin(origin) {
      panelOrigins.add(new URL(origin).origin);
      return panel;
    },
    /** Чужой хост: handler({ method, url, headers, body }) → { status, headers, body } (необязательно). */
    host(origin, handler) {
      foreignHosts.set(new URL(origin).origin, handler);
      return panel;
    },
    fail({ status = 500, body, headers, network, ...match } = {}) {
      return addRule(match, network ? { network } : { status, body, headers });
    },
    hang(match = {}) {
      return addRule(match, { hang: true });
    },
    delay(ms, match = {}) {
      return addRule(match, { delayMs: ms });
    },
    clear() {
      rules.length = 0;
    },
    describe() {
      return [...hanging].map((entry) => `панель: без ответа ${entry.method} ${entry.url} (запрос #${entry.seq})`);
    },
  };
  return panel;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Контекст плагина, как его даёт панель
// ════════════════════════════════════════════════════════════════════════════

/** Классы операций туннеля: catalyst-backend/src/plugins/capabilities.ts:28-61. */
const FILE_READ_OPS = new Set(['list', 'download', 'archive-contents']);
const FILE_WRITE_OPS = new Set(['upload', 'write', 'create', 'delete', 'rename', 'permissions', 'compress', 'decompress', 'install-url']);

const CONFIG_FIELD_TYPES = new Set(['string', 'number', 'boolean', 'select', 'text', 'password', 'object', 'array']);
const CONFIG_META_KEYS = new Set(['type', 'default', 'description', 'options', 'required', 'enum', 'min', 'max', 'label']);

/** Схема поля plugin.json или значение: catalyst-backend/src/plugins/config-utils.ts:39-60 и 92-98. */
function resolveConfigValue(value) {
  if (value === undefined) return undefined;
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.type === 'string' && CONFIG_FIELD_TYPES.has(value.type)) {
    const keys = Object.keys(value);
    const isSchema =
      (keys.length === 1 && keys[0] === 'type') ||
      (keys.some((key) => key !== 'type' && CONFIG_META_KEYS.has(key)) && keys.every((key) => CONFIG_META_KEYS.has(key)));
    if (isSchema) return value.default;
  }
  return value;
}

let manifestCache = null;

/** plugin.json плагина (читается один раз). */
function readPluginManifest() {
  if (!manifestCache) {
    manifestCache = JSON.parse(fs.readFileSync(new URL('plugin.json', PLUGIN_DIR_URL), 'utf8'));
  }
  return jsonClone(manifestCache);
}

function generateDocId() {
  // Как collection-storage.ts:6-8.
  return Date.now().toString(36) + randomBytes(4).toString('hex');
}

/** matchFilter: catalyst-backend/src/plugins/path-utils.ts:75-128. */
function getByPath(doc, dotted) {
  if (!doc || typeof doc !== 'object') return undefined;
  let current = doc;
  for (const part of String(dotted).split('.')) {
    if (!part || part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setByPath(doc, dotted, value) {
  const parts = String(dotted).split('.');
  if (parts.some((part) => !part || part === '__proto__' || part === 'constructor' || part === 'prototype')) return;
  let current = doc;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current[part] === null || current[part] === undefined || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function unsetByPath(doc, dotted) {
  const parts = String(dotted).split('.');
  let current = doc;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (current === null || current === undefined || typeof current !== 'object') return;
    current = current[parts[index]];
  }
  if (current && typeof current === 'object') delete current[parts[parts.length - 1]];
}

function matchFilter(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(value) || !value.some((sub) => matchFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(value) || !value.every((sub) => matchFilter(doc, sub))) return false;
      continue;
    }
    const docValue = getByPath(doc, key);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length > 0 && keys.every((item) => item.startsWith('$'))) {
        if (value.$eq !== undefined && docValue !== value.$eq) return false;
        if (value.$ne !== undefined && docValue === value.$ne) return false;
        if (value.$gt !== undefined && !(docValue > value.$gt)) return false;
        if (value.$gte !== undefined && !(docValue >= value.$gte)) return false;
        if (value.$lt !== undefined && !(docValue < value.$lt)) return false;
        if (value.$lte !== undefined && !(docValue <= value.$lte)) return false;
        if (value.$in !== undefined && (!Array.isArray(value.$in) || !value.$in.includes(docValue))) return false;
        if (value.$nin !== undefined && (!Array.isArray(value.$nin) || value.$nin.includes(docValue))) return false;
        if (value.$exists !== undefined && value.$exists !== (docValue !== undefined && docValue !== null)) return false;
        if (value.$regex !== undefined) {
          const regex = typeof value.$regex === 'string' ? new RegExp(value.$regex, value.$flags || '') : value.$regex;
          if (!regex.test(String(docValue ?? ''))) return false;
        }
        continue;
      }
    }
    if (docValue !== value) return false;
  }
  return true;
}

/** applyUpdateOperators: catalyst-backend/src/plugins/path-utils.ts:135-196. */
function applyUpdateOperators(target, update) {
  if (!update || typeof update !== 'object') return;
  const hasOps = update.$set || update.$unset || update.$inc || update.$push || update.$pull;
  if (update.$set && typeof update.$set === 'object') {
    for (const [key, value] of Object.entries(update.$set)) setByPath(target, key, value);
  }
  if (update.$unset && typeof update.$unset === 'object') {
    for (const key of Object.keys(update.$unset)) unsetByPath(target, key);
  }
  if (update.$inc && typeof update.$inc === 'object') {
    for (const [key, value] of Object.entries(update.$inc)) {
      const current = getByPath(target, key);
      setByPath(target, key, (typeof current === 'number' ? current : 0) + value);
    }
  }
  if (update.$push && typeof update.$push === 'object') {
    for (const [key, value] of Object.entries(update.$push)) {
      const current = getByPath(target, key);
      const list = Array.isArray(current) ? current : [];
      list.push(value);
      setByPath(target, key, list);
    }
  }
  if (update.$pull && typeof update.$pull === 'object') {
    for (const [key, value] of Object.entries(update.$pull)) {
      const current = getByPath(target, key);
      if (!Array.isArray(current)) continue;
      setByPath(
        target,
        key,
        current.filter((item) => (typeof value === 'object' && value !== null ? !matchFilter(item, value) : item !== value)),
      );
    }
  }
  if (!hasOps) {
    for (const [key, value] of Object.entries(update)) {
      if (!key.startsWith('$')) setByPath(target, key, value);
    }
  }
}

const isJsonScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value);

/** Условия, которые хранилище считает в базе (collection-storage.ts:186-235). */
function pushdownMatches(row, filter) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or' || key === '$and') continue;
    if (key === '_id' || key === 'docId') {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (value.$eq !== undefined && isJsonScalar(value.$eq)) {
          if (row.docId !== String(value.$eq)) return false;
        } else if (Array.isArray(value.$in) && value.$in.every(isJsonScalar)) {
          if (!value.$in.map(String).includes(row.docId)) return false;
        }
        continue;
      }
      if (isJsonScalar(value) && row.docId !== String(value)) return false;
      continue;
    }
    // Ключ берётся как одно имя поля верхнего уровня (точки не разбираются).
    const docValue = Object.prototype.hasOwnProperty.call(row.document, key) ? row.document[key] : undefined;
    if (isJsonScalar(value)) {
      if (docValue !== value) return false;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (value.$eq !== undefined && isJsonScalar(value.$eq)) {
        if (docValue !== value.$eq) return false;
      } else if (Array.isArray(value.$in) && value.$in.every(isJsonScalar)) {
        if (!value.$in.includes(docValue)) return false;
      }
    }
  }
  return true;
}

/** Нужна ли досортировка в памяти (collection-storage.ts:242-263). */
function needsClientSideFilter(filter) {
  if (!filter) return false;
  for (const key of Object.keys(filter)) {
    if (key === '$or' || key === '$and') return true;
    const value = filter[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const onlyPushdown =
        keys.length > 0 &&
        keys.every(
          (item) =>
            (item === '$eq' && isJsonScalar(value.$eq)) ||
            (item === '$in' && Array.isArray(value.$in) && value.$in.every(isJsonScalar)),
        );
      if (onlyPushdown) continue;
      return true;
    }
  }
  return false;
}

const DB_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'docId']);

/**
 * Хранилище плагина: коллекции (как dedicated-движок — у RustWipe в plugin.json
 * "storageEngine": "dedicated") и ключ-значение (getStorage/setStorage).
 * Семантика коллекций — catalyst-backend/src/plugins/storage/collection-storage.ts:25-176:
 *   - каждый документ — отдельная строка; данные проходят через JSON;
 *   - find без sort — сначала новые (createdAt desc); sort по своему полю
 *     делается в памяти ПОСЛЕ limit/skip, а limit берёт самые новые по createdAt;
 *   - фильтр по скалярам и _id считается «в базе» (поле верхнего уровня,
 *     точки не разбираются), undefined/null/массив в фильтре условием не считаются;
 *   - update: прочитать → изменить → записать каждую строку отдельно, без транзакции;
 *     insert/update/delete — ни одной общей транзакции между вызовами.
 * Сбои: store.failWrite({ collection, op, nth, times, error }) — упасть на N-й
 * подходящей записи (insert — одна запись, update — по записи на документ,
 * delete — одна запись); collection не задана — счёт по всем коллекциям;
 * storageKey — для ключа хранилища. store.failRead(...) — то же для чтения.
 */
function createStore(journal) {
  const tables = new Map();
  const kv = new Map();
  const failRules = [];
  let rowSeq = 0;

  const table = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  function checkFail(on, target, op) {
    for (const rule of failRules) {
      if (rule.on !== on) continue;
      if (rule.collection !== undefined && rule.collection !== target.collection) continue;
      if (rule.storageKey !== undefined && rule.storageKey !== target.storageKey) continue;
      if (rule.op !== undefined && !matchValue(rule.op, op)) continue;
      rule.seen += 1;
      if (rule.seen >= rule.nth && rule.fired < rule.times) {
        rule.fired += 1;
        const what = target.collection !== undefined ? `коллекция ${target.collection}` : `ключ ${target.storageKey}`;
        const error =
          rule.error instanceof Error
            ? rule.error
            : new Error(rule.error ?? `песочница: сбой ${on === 'write' ? 'записи' : 'чтения'} (${what}, ${op}, обращение №${rule.seen})`);
        if (target.collection !== undefined) {
          journal.push('db', { table: target.collection, op, failed: true, error: error.message });
        } else {
          journal.push('storage', { op, key: target.storageKey, failed: true, error: error.message });
        }
        throw error;
      }
    }
  }

  const toDoc = (row) => ({
    _id: row.docId,
    ...jsonClone(row.document),
    _createdAt: isoOf(row.createdAt),
    _updatedAt: isoOf(row.updatedAt),
  });

  async function selectDocs(name, filter, options = {}) {
    await null;
    checkFail('read', { collection: name }, 'find');
    let rows = table(name).filter((row) => pushdownMatches(row, filter));
    const dbOrder = options.sort
      ? Object.entries(options.sort)
          .filter(([field]) => DB_SORT_FIELDS.has(field))
          .map(([field, dir]) => ({ field, asc: dir === 1 }))
      : [];
    const order = dbOrder.length ? dbOrder : [{ field: 'createdAt', asc: false }];
    rows = [...rows].sort((a, b) => {
      for (const { field, asc } of order) {
        const av = field === 'docId' ? a.docId : a[field];
        const bv = field === 'docId' ? b.docId : b[field];
        if (av !== bv) return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      }
      return (a.seq - b.seq) * (order[0].asc ? 1 : -1);
    });
    if (options.skip) rows = rows.slice(options.skip);
    if (options.limit !== undefined && options.limit !== null) rows = rows.slice(0, options.limit);
    let docs = rows.map(toDoc);
    if (options.sort) {
      for (const [field, sortOrder] of Object.entries(options.sort)) {
        if (DB_SORT_FIELDS.has(field)) continue;
        docs.sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const aEmpty = av === null || av === undefined;
          const bEmpty = bv === null || bv === undefined;
          if (aEmpty && bEmpty) return 0;
          if (aEmpty) return sortOrder;
          if (bEmpty) return -sortOrder;
          return av < bv ? -sortOrder : av > bv ? sortOrder : 0;
        });
      }
    }
    if (filter && needsClientSideFilter(filter)) docs = docs.filter((doc) => matchFilter(doc, filter));
    if (options.projection) {
      docs = docs.map((doc) => {
        const projected = { _id: doc._id };
        for (const [field, include] of Object.entries(options.projection)) {
          if (include && doc[field] !== undefined) projected[field] = doc[field];
        }
        return projected;
      });
    }
    return docs;
  }

  function collection(name) {
    return {
      async find(filter, options) {
        const docs = await selectDocs(name, filter, options || {});
        journal.push('db', { table: name, op: 'find', filter: filter ? safeClone(filter) : undefined, count: docs.length });
        return docs;
      },
      async findOne(filter) {
        const docs = await selectDocs(name, filter, { limit: 1 });
        journal.push('db', { table: name, op: 'findOne', filter: filter ? safeClone(filter) : undefined, count: docs.length });
        return docs[0] || null;
      },
      async insert(doc) {
        await null;
        const { _id, _createdAt, _updatedAt, ...document } = doc || {};
        void _id;
        void _createdAt;
        void _updatedAt;
        checkFail('write', { collection: name }, 'insert');
        const now = Date.now();
        const row = { docId: generateDocId(), document: jsonClone(document), createdAt: now, updatedAt: now, seq: ++rowSeq };
        table(name).push(row);
        journal.push('db', { table: name, op: 'insert', id: row.docId, count: 1 });
        return toDoc(row);
      },
      async update(filter, updateData) {
        const docs = await selectDocs(name, filter, {});
        let count = 0;
        for (const doc of docs) {
          const updated = { ...doc };
          applyUpdateOperators(updated, updateData);
          const { _id: docId, _createdAt, _updatedAt, ...document } = updated;
          void _createdAt;
          void _updatedAt;
          await null;
          checkFail('write', { collection: name }, 'update');
          const row = table(name).find((item) => item.docId === doc._id);
          if (row) {
            row.document = jsonClone(document);
            row.updatedAt = Date.now();
          }
          void docId;
          count += 1;
        }
        journal.push('db', { table: name, op: 'update', filter: safeClone(filter), count });
        return count;
      },
      async delete(filter) {
        const docs = await selectDocs(name, filter, {});
        if (!docs.length) {
          journal.push('db', { table: name, op: 'delete', filter: safeClone(filter), count: 0 });
          return 0;
        }
        await null;
        checkFail('write', { collection: name }, 'delete');
        const ids = new Set(docs.map((doc) => doc._id));
        const rows = table(name);
        const before = rows.length;
        tables.set(name, rows.filter((row) => !ids.has(row.docId)));
        const count = before - tables.get(name).length;
        journal.push('db', { table: name, op: 'delete', filter: safeClone(filter), count });
        return count;
      },
      async count(filter) {
        if (!filter) {
          await null;
          checkFail('read', { collection: name }, 'count');
          return table(name).length;
        }
        return (await selectDocs(name, filter, {})).length;
      },
      /** Документы как есть, без задержек и журнала (для проверок в тесте). */
      get docs() {
        return [...table(name)].sort((a, b) => a.seq - b.seq).map(toDoc);
      },
    };
  }

  return {
    collection,
    async getStorage(key) {
      await null;
      checkFail('read', { storageKey: key }, 'get');
      journal.push('storage', { op: 'get', key });
      return kv.has(key) ? jsonClone(kv.get(key)) : null;
    },
    async setStorage(key, value) {
      await null;
      checkFail('write', { storageKey: key }, 'set');
      kv.set(key, value === undefined ? null : jsonClone(value));
      journal.push('storage', { op: 'set', key });
    },
    async deleteStorage(key) {
      await null;
      checkFail('write', { storageKey: key }, 'delete');
      kv.delete(key);
      journal.push('storage', { op: 'delete', key });
    },
    /** Значение ключа хранилища без задержек и журнала. */
    peek: (key) => (kv.has(key) ? jsonClone(kv.get(key)) : null),
    /** Положить документы при подготовке теста (с теми же createdAt, что «сейчас»). */
    seed(name, docs) {
      for (const doc of docs || []) {
        const { _id, _createdAt, _updatedAt, ...document } = doc;
        const now = Date.now();
        table(name).push({
          docId: _id ? String(_id) : generateDocId(),
          document: jsonClone(document),
          createdAt: _createdAt ? toMs(_createdAt) : now,
          updatedAt: _updatedAt ? toMs(_updatedAt) : now,
          seq: ++rowSeq,
        });
      }
    },
    seedStorage(values) {
      for (const [key, value] of Object.entries(values || {})) kv.set(key, jsonClone(value));
    },
    failWrite(options = {}) {
      return addFailRule('write', options);
    },
    failRead(options = {}) {
      return addFailRule('read', options);
    },
    clearFailures() {
      failRules.length = 0;
    },
  };

  function addFailRule(on, { collection: collectionName, storageKey, op, nth = 1, times = 1, error } = {}) {
    const rule = { on, collection: collectionName, storageKey, op, nth, times, seen: 0, fired: 0, error };
    failRules.push(rule);
    return () => {
      const index = failRules.indexOf(rule);
      if (index >= 0) failRules.splice(index, 1);
    };
  }
}

function makeLogger(journal) {
  const write = (level) => (first, second) => {
    let msg;
    let data;
    if (typeof first === 'string') {
      msg = first;
    } else {
      data = first === undefined ? undefined : safeClone(first);
      msg = second === undefined ? '' : String(second);
    }
    journal.push('log', { level, msg, data });
    if (process.env.REVIEW_VERBOSE) {
      process.stdout.write(`      [${level}] ${msg}${data !== undefined ? ` ${short(data, 300)}` : ''}\n`);
    }
  };
  const logger = {
    level: 'info',
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
    child: () => logger,
  };
  return logger;
}

/**
 * Контекст плагина — то, что панель передаёт в onLoad/onEnable
 * (catalyst-backend/src/plugins/context.ts:766-1365), в той части, что
 * использует backend RustWipe:
 *   db.servers.findUnique — из panel (поля context.ts:42-48; без права
 *     server.read — «Permission denied: servers access not declared in manifest», context.ts:148-152);
 *   fileTunnel.queueRequest — tunnel за шлюзом прав (capabilities.ts:156-194);
 *   collection(name) — коллекции dedicated-движка (см. createStore);
 *   getStorage/setStorage/deleteStorage — ключ-значение;
 *   getConfig/setConfig — значения plugin.json по умолчанию + config
 *     (config-utils.ts:92-146); configDefaults: false — без значений plugin.json;
 *   scheduleTask — задача записывается, сама не запускается: runTask() вызывает её
 *     (как node-cron, ошибки ловятся и пишутся в лог — context.ts:925-960);
 *   registerRoute — роут с адресом /api/plugins/<имя>/… (context.ts:775-892);
 *   logger, emit/emitTyped/on — в журнал;
 *   getUserId/hasPermission/requirePermission — как context.ts:1194-1232.
 * grants — права плагина (по умолчанию permissions из plugin.json).
 * collections: { profiles: [...], runs: [...] } и storage: { ключ: значение } — начальные данные.
 * Возвращает { ctx, routes, tasks, store, journal, config, grants, runTask }.
 */
export function makeContext({
  tunnel = null,
  panel = null,
  config = {},
  configDefaults = true,
  grants,
  manifest,
  journal = createJournal(),
  collections = {},
  storage = {},
  installId = 'inst_sandbox',
} = {}) {
  const pluginJson = manifest ?? readPluginManifest();
  const effectiveGrants = grants ? [...grants] : [...(pluginJson.permissions || [])];
  const runtimeConfig = {};
  if (configDefaults) {
    for (const [key, schema] of Object.entries(pluginJson.config || {})) runtimeConfig[key] = resolveConfigValue(schema);
  }
  Object.assign(runtimeConfig, config);
  const routes = [];
  const tasks = new Map();
  const handlers = new Map();
  const store = createStore(journal);
  for (const [name, docs] of Object.entries(collections || {})) store.seed(name, docs);
  store.seedStorage(storage);
  const logger = makeLogger(journal);
  const grantList = () => effectiveGrants;

  const fileTunnel = tunnel
    ? {
        async queueRequest(nodeId, operation, serverUuid, filePath, data, uploadData) {
          const current = grantList();
          const kind = FILE_READ_OPS.has(operation) ? 'read' : FILE_WRITE_OPS.has(operation) ? 'write' : 'unknown';
          const canRead = ['files.read', 'files.write', 'server.read', 'server.write'].some((item) => hasGrant(current, item));
          const canWrite = ['files.write', 'server.write'].some((item) => hasGrant(current, item));
          if (kind === 'read' && !canRead) {
            throw new Error(`Permission denied: file read operation "${operation}" requires files.read, files.write, server.read or server.write`);
          }
          if (kind === 'write' && !canWrite) {
            throw new Error(`Permission denied: file write operation "${operation}" requires files.write or server.write`);
          }
          if (kind === 'unknown') {
            throw new Error(`Permission denied: file tunnel operation "${operation}" is not permitted (unknown op)`);
          }
          return tunnel.queueRequest(nodeId, operation, serverUuid, filePath, data, uploadData);
        },
      }
    : undefined;

  const canTable = (tableName) => {
    const current = grantList();
    if (current.includes('*')) return true;
    if (tableName === 'servers') return current.includes('server.read');
    if (tableName === 'users') return current.includes('user.read');
    return false;
  };

  const db = {
    get servers() {
      if (!canTable('servers')) throw new Error('Permission denied: servers access not declared in manifest');
      if (!panel) throw new Error('песочница: панель не подключена — makeContext({ panel })');
      return {
        findUnique: (args) => panel.db.findUnique(args),
        findMany: (args) => panel.db.findMany(args),
        count: (args) => panel.db.count(args),
        update: async (id, data) => {
          const current = grantList();
          if (!(current.includes('*') || current.includes('server.write'))) {
            throw new Error('Permission denied: server.write permission required for updates');
          }
          const filtered = {};
          if (data && data.status !== undefined) filtered.status = data.status;
          if (!Object.keys(filtered).length) throw new Error('No whitelisted fields in update data. Allowed fields: status');
          return panel.db.update(id, filtered);
        },
      };
    },
    get users() {
      if (!canTable('users')) throw new Error('Permission denied: users access not declared in manifest');
      throw new Error('песочница: таблица users не эмулируется');
    },
    get credentials() {
      throw new Error('Access to credentials is prohibited for security reasons');
    },
    get apiKeys() {
      throw new Error('Access to API keys is prohibited for security reasons');
    },
  };

  const ctx = {
    manifest: { ...pluginJson, config: runtimeConfig },
    originalConfig: { ...runtimeConfig },
    installId,
    logger,
    db,
    fileTunnel,
    wsGateway: {
      async sendToAgent() {
        throw new Error('Permission denied: console.write or server.write required to drive the agent console');
      },
      broadcastToAuthenticated() {},
      sendToClient: () => false,
      registerPluginWsHandler() {},
      unregisterPluginWsHandlers() {},
    },
    registerRoute(options) {
      const url = `/api/plugins/${pluginJson.name}/${String(options.url).replace(/^\//, '')}`;
      const requested = options.config?.auth;
      const publicAllowed = effectiveGrants.includes('routes.public') || effectiveGrants.includes('*');
      const auth = (requested === 'public' || requested === 'optional') && publicAllowed ? requested : 'required';
      routes.push({
        method: options.method,
        url,
        pattern: options.url,
        handler: options.handler,
        auth,
        requiredPermissions: Array.isArray(options.config?.requiredPermissions) ? [...options.config.requiredPermissions] : [],
      });
    },
    registerMiddleware() {},
    onWebSocketMessage() {},
    sendWebSocketMessage() {},
    scheduleTask(cronExpression, handler) {
      const fields = String(cronExpression).trim().split(/\s+/);
      if (fields.length < 5 || fields.length > 6 || !fields.every((field) => /^[\d*/,\-A-Za-z?LW#]+$/.test(field))) {
        throw new Error(`Invalid cron expression: ${cronExpression}`);
      }
      const taskId = `${pluginJson.name}:${cronExpression}`;
      tasks.set(taskId, { cron: cronExpression, handler, taskId });
      journal.push('task', { op: 'schedule', cron: cronExpression });
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    emit(event, data) {
      journal.push('event', { event, data: safeClone(data) });
      for (const handler of handlers.get(event) || []) handler(data);
    },
    emitTyped(event, data) {
      ctx.emit(event, data);
    },
    getDeclaredEvents: () => pluginJson.events,
    getConfig(key) {
      return resolveConfigValue(runtimeConfig[key]);
    },
    async setConfig(key, value) {
      runtimeConfig[key] = value;
      journal.push('config', { key, value: safeClone(value) });
    },
    getStorage: (key) => store.getStorage(key),
    setStorage: (key, value) => store.setStorage(key, value),
    deleteStorage: (key) => store.deleteStorage(key),
    collection: (name) => store.collection(name),
    exposeApi() {},
    async callPluginApi() {
      throw new Error('Permission denied: plugin.rpc permission required');
    },
    getUserId(request) {
      return request?.user?.userId || request?.user?.id || null;
    },
    hasPermission(request, ...required) {
      const permissions = request?.user?.permissions ?? [];
      return required.some((permission) => hasGrant(permissions, permission));
    },
    requirePermission(...required) {
      return async (request, reply) => {
        const permissions = request?.user?.permissions ?? [];
        if (required.some((permission) => hasGrant(permissions, permission))) return undefined;
        return reply.status(403).send({ success: false, error: `Permission denied: requires one of [${required.join(', ')}]` });
      };
    },
  };

  /** Вызвать задачу scheduleTask вручную (по cron или единственную). Ошибки — в лог, как в панели. */
  async function runTask(cron) {
    const list = [...tasks.values()];
    const task = cron ? list.find((item) => item.cron === cron) : list[list.length - 1];
    if (!task) throw new Error('песочница: задач нет — плагин не вызвал scheduleTask (onEnable не запускали?)');
    journal.push('task', { op: 'run', cron: task.cron });
    try {
      return await task.handler();
    } catch (error) {
      logger.error({ error: error?.message }, 'Task execution failed');
      journal.push('task', { op: 'error', cron: task.cron, error: error?.message });
      return undefined;
    }
  }

  return { ctx, routes, tasks, store, journal, config: runtimeConfig, grants: effectiveGrants, runTask };
}

let profileCounter = 0;

/**
 * Профиль вайпа в том виде, в каком его хранит плагин (store.js buildProfile),
 * без проверок. По умолчанию: еженедельно в четверг 05:00, цели — карта и
 * сохранение мира, остановка и запуск включены, боевой режим. Поля map нет —
 * значит «сид и размер не меняются» (как у старых профилей).
 * server — запись сервера или его id; overrides — что поменять (options сливаются).
 */
export function makeProfile(server = {}, overrides = {}) {
  const info = typeof server === 'string' ? { id: server } : server || {};
  const now = new Date().toISOString();
  profileCounter += 1;
  const base = {
    id: `wipe_sandbox_${profileCounter}`,
    name: `Профиль песочницы ${profileCounter}`,
    serverId: info.id ?? 'srv1',
    serverName: info.name ?? '',
    serverUuid: info.uuid ?? '',
    nodeId: info.nodeId ?? '',
    enabled: true,
    schedule: { kind: 'weekly', time: '05:00', weekday: 4, nth: 1, day: 1, intervalDays: 7 },
    targets: ['/server/*/proceduralmap.*.map', '/server/*/proceduralmap.*.sav'],
    excludes: [],
    options: { stopServer: true, startServer: true, dryRun: false, warnChat: true, commandsAfter: [] },
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides, options: { ...base.options, ...(overrides.options || {}) } };
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Загрузка плагина и вызов роутов
// ════════════════════════════════════════════════════════════════════════════

let isolationMode = null;
let loadCounter = 0;

/**
 * Каждая загрузка плагина получает свои экземпляры модулей backend (у index.js
 * и warnings.js есть состояние в памяти: runningProfiles, tickBusy, lastState).
 * Для этого к адресам модулей backend добавляется ?rwsandbox=<номер>.
 */
function installIsolationHooks() {
  if (isolationMode) return isolationMode;
  const prefix = BACKEND_DIR_URL.href;
  const resolveWithVersion = (result, parentURL) => {
    const match = /[?&](rwsandbox=\d+)/.exec(parentURL || '');
    if (match && result.url.startsWith(prefix) && !/[?&]rwsandbox=/.test(result.url)) {
      return { ...result, url: `${result.url}${result.url.includes('?') ? '&' : '?'}${match[1]}` };
    }
    return result;
  };
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        return resolveWithVersion(nextResolve(specifier, context), context.parentURL);
      },
    });
    isolationMode = 'registerHooks';
  } else if (typeof nodeModule.register === 'function') {
    const code =
      `const prefix = ${JSON.stringify(prefix)};` +
      'export async function resolve(specifier, context, nextResolve) {' +
      '  const result = await nextResolve(specifier, context);' +
      "  const match = /[?&](rwsandbox=\\d+)/.exec(context.parentURL || '');" +
      '  if (match && result.url.startsWith(prefix) && !/[?&]rwsandbox=/.test(result.url)) {' +
      "    return { ...result, url: result.url + (result.url.includes('?') ? '&' : '?') + match[1] };" +
      '  }' +
      '  return result;' +
      '}';
    nodeModule.register(`data:text/javascript,${encodeURIComponent(code)}`);
    isolationMode = 'register';
  } else {
    isolationMode = 'нет';
  }
  return isolationMode;
}

function importBackend(relativePath, version) {
  const mode = installIsolationHooks();
  const url = new URL(relativePath, BACKEND_DIR_URL);
  if (version !== null && version !== undefined && mode !== 'нет') url.searchParams.set('rwsandbox', String(version));
  return import(url.href);
}

/**
 * Загрузить плагин (default export из rust-autowipe/backend/index.js) и вызвать
 * onLoad(ctx) — он регистрирует роуты. enable: true — ещё и onEnable(ctx)
 * (ставит задачу scheduleTask и сразу делает один тик в фоне).
 * fresh: true (по умолчанию) — свои экземпляры модулей на каждую загрузку.
 * env — объект с ctx (и clock, если есть) — например, из makeContext или createSandbox.
 * Повторная загрузка заменяет роуты и задачи прежнего экземпляра, а хранилище,
 * дерево и панель остаются — так эмулируется перезапуск панели посреди вайпа.
 * Фоновые промисы и таймеры прежнего экземпляра при этом не убиваются: чтобы
 * они «умерли», как при падении процесса, подвесьте их заранее (tunnel.hang).
 * Возвращает { plugin, module, lib(name) }; lib('wipe') — модуль lib/wipe.js того же экземпляра.
 */
export async function loadPlugin(env, { enable = false, fresh = true } = {}) {
  const version = fresh ? ++loadCounter : null;
  const module = await importBackend('index.js', version);
  const plugin = module.default;
  if (Array.isArray(env.routes)) env.routes.length = 0;
  if (env.tasks instanceof Map) env.tasks.clear();
  const drive = (promise) => (env.clock?.installed ? env.clock.runUntil(promise) : promise);
  await drive(Promise.resolve().then(() => plugin.onLoad(env.ctx)));
  if (enable) await drive(Promise.resolve().then(() => plugin.onEnable(env.ctx)));
  const lib = (name) => importBackend(`lib/${String(name).replace(/\.js$/, '')}.js`, version);
  Object.assign(env, { plugin, module, lib });
  return { plugin, module, lib };
}

function createReply() {
  const reply = {
    statusCode: 200,
    sent: false,
    payload: undefined,
    headers: {},
    status(code) {
      reply.statusCode = code;
      return reply;
    },
    code(code) {
      return reply.status(code);
    },
    header(name, value) {
      reply.headers[String(name).toLowerCase()] = value;
      return reply;
    },
    getHeader(name) {
      return reply.headers[String(name).toLowerCase()];
    },
    type(contentType) {
      return reply.header('content-type', contentType);
    },
    send(payload) {
      if (reply.sent) return reply;
      reply.sent = true;
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

function matchRoute(routes, method, fullPath) {
  for (const route of routes) {
    const methods = [].concat(route.method).map((item) => String(item).toUpperCase());
    if (!methods.includes(method)) continue;
    const patternParts = route.url.split('/').filter(Boolean);
    const pathParts = fullPath.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let index = 0; index < patternParts.length; index += 1) {
      const part = patternParts[index];
      if (part.startsWith(':')) {
        try {
          params[part.slice(1)] = decodeURIComponent(pathParts[index]);
        } catch {
          params[part.slice(1)] = pathParts[index];
        }
      } else if (part !== pathParts[index]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

function resolveUser(env, user) {
  if (user === null || user === undefined) return null;
  if (typeof user === 'string') {
    // У env из makeContext пользователей нет — берём defaultUsers (как у createPanel по умолчанию).
    const users = env.users ?? defaultUsers();
    const found = users[user];
    if (!found) throw new Error(`песочница: нет пользователя «${user}» (есть: ${Object.keys(users).join(', ')})`);
    return found;
  }
  return user;
}

let requestCounter = 0;
const activeRequestsByCtx = new WeakMap();

/**
 * Вызвать роут плагина от имени пользователя — как браузер через диспетчер
 * панели (catalyst-backend/src/plugins/route-table.ts:149-226) и шлюз
 * (runtime/request-gate.ts:58-146). env — createSandbox() или результат
 * makeContext(), после loadPlugin(env); часы берутся из env.clock, люди — из env.users:
 *   user — 'admin' | 'owner' | 'sub' | 'stranger' (env.users или defaultUsers()), объект
 *          { id, permissions, session?, email?, username?, apiKeyId? } или null (аноним → 401);
 *   method, path — 'GET', '/servers/srv1/status' (можно полный '/api/plugins/rust-autowipe/…' и ?query);
 *   options: { body, query, headers, cookie, authorization, drive }:
 *     cookie — по умолчанию cookie сессии пользователя; строка — своя; false — без cookie;
 *     authorization — заголовок Authorization; headers — любые заголовки;
 *     drive: false — не крутить поддельные часы (по умолчанию крутит, если они стоят).
 * Нет роута — 404 { success:false, error:'Plugin route not found' }; ответ дольше
 * 30 с виртуального времени — 504 «Plugin request timed out after 30000ms»;
 * больше 10 одновременных — 503. Ответ: { status, body, text, headers }.
 */
export async function callRoute(env, user, method, routePath, options = {}) {
  const run = () => executeRoute(env, user, method, routePath, options);
  if (options.drive !== false && env.clock?.installed) return env.clock.runUntil(run());
  return run();
}

async function executeRoute(env, user, method, routePath, options) {
  const { ctx } = env;
  const journal = env.journal;
  const actor = resolveUser(env, user);
  const upper = String(method).toUpperCase();
  const parsed = new URL(String(routePath), 'http://plugin.invalid');
  const fullPath = parsed.pathname.startsWith('/api/plugins/')
    ? parsed.pathname
    : `/api/plugins/${ctx.manifest.name}${parsed.pathname.startsWith('/') ? '' : '/'}${parsed.pathname}`;
  const query = {};
  for (const [key, value] of parsed.searchParams) {
    if (key in query) query[key] = [].concat(query[key], value);
    else query[key] = value;
  }
  for (const [key, value] of Object.entries(options.query || {})) query[key] = String(value);
  const search = new URLSearchParams(query).toString();
  const url = `${fullPath}${search ? `?${search}` : ''}`;

  const headers = {};
  if (actor && options.cookie !== false) {
    const cookie = typeof options.cookie === 'string' ? options.cookie : actor.session ? `${SESSION_COOKIE_NAME}=${actor.session}` : null;
    if (cookie) headers.cookie = cookie;
  } else if (typeof options.cookie === 'string') {
    headers.cookie = options.cookie;
  }
  if (options.authorization) headers.authorization = options.authorization;
  for (const [key, value] of Object.entries(options.headers || {})) headers[key.toLowerCase()] = value;
  let body;
  if (options.body !== undefined) {
    body = jsonClone(options.body);
    headers['content-type'] ??= 'application/json';
  }

  const entry = journal?.push('route', { method: upper, url, user: actor?.id ?? null });
  const finish = (status, payload, replyHeaders = {}) => {
    let text;
    let parsedBody = payload;
    if (typeof payload === 'string') {
      text = payload;
      try {
        parsedBody = JSON.parse(payload);
      } catch {
        parsedBody = payload;
      }
    } else if (payload === undefined) {
      text = '';
    } else {
      text = JSON.stringify(payload);
      parsedBody = text === undefined ? undefined : JSON.parse(text);
    }
    if (entry) journal.update(entry, { status });
    return { status, body: parsedBody, text, headers: replyHeaders };
  };

  const match = matchRoute(env.routes, upper, fullPath);
  if (!actor && (!match || match.route.auth === 'required')) return finish(401, { error: 'Unauthorized' });
  if (!match) return finish(404, { success: false, error: 'Plugin route not found' });
  if (match.route.auth !== 'public' && match.route.requiredPermissions.length) {
    const permissions = actor?.permissions ?? [];
    if (!match.route.requiredPermissions.some((permission) => hasGrant(permissions, permission))) {
      return finish(403, { success: false, code: 'PLUGIN_ROUTE_FORBIDDEN', error: 'Permission denied' });
    }
  }

  const active = activeRequestsByCtx.get(ctx) || 0;
  if (active >= 10) return finish(503, { success: false, error: 'Plugin concurrent request limit exceeded' });
  activeRequestsByCtx.set(ctx, active + 1);

  const request = {
    id: `req-${++requestCounter}`,
    method: upper,
    url,
    routeOptions: { url: match.route.url, method: upper },
    params: match.params,
    query,
    body,
    headers,
    ip: '127.0.0.1',
    log: ctx.logger,
    user: actor
      ? {
          userId: actor.id,
          email: actor.email,
          username: actor.username,
          permissions: [...(actor.permissions || [])],
          ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}),
        }
      : undefined,
  };
  const reply = createReply();
  let gateTimer = null;
  const gate = new Promise((_resolve, reject) => {
    gateTimer = globalThis.setTimeout(() => reject(new Error('Request timeout')), 30000);
  });
  try {
    const returned = await Promise.race([Promise.resolve().then(() => match.route.handler(request, reply)), gate]);
    if (reply.sent) return finish(reply.statusCode, reply.payload, reply.headers);
    if (returned !== undefined && returned !== reply) return finish(reply.statusCode, returned, reply.headers);
    return finish(500, { error: 'песочница: обработчик не отправил ответ (Fastify ответил бы ошибкой)' });
  } catch (error) {
    if (error?.message === 'Request timeout') {
      return finish(504, { success: false, error: 'Plugin request timed out after 30000ms' });
    }
    return finish(500, { statusCode: 500, error: 'Internal Server Error', message: error?.message ?? String(error) });
  } finally {
    globalThis.clearTimeout(gateTimer);
    activeRequestsByCtx.set(ctx, (activeRequestsByCtx.get(ctx) || 1) - 1);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Всё вместе
// ════════════════════════════════════════════════════════════════════════════

/**
 * Песочница целиком: часы (уже стоят), дерево rustServerTree, туннель, панель
 * (fetch уже подменён), пользователи defaultUsers, сервер srv1 и контекст.
 *   const sb = createSandbox({
 *     now,            // виртуальное «сейчас» (по умолчанию 2026-11-19T00:00:00Z)
 *     clock: false,   // без поддельных часов
 *     tree,           // описание для createTree или готовое дерево
 *     links,          // 'agent' | 'follow' | 'nofollow'
 *     nodeId, nodes,  // ноды, к которым «подключён» агент (по умолчанию нода первого сервера)
 *     servers, users, // свои сервера (defaultServer(...)) и пользователи (defaultUsers())
 *     base, apiKey, apiKeyPermissions, access,  // панель (panelUrl и apiKey плагина берутся отсюда)
 *     config, configDefaults, grants, collections, storage,  // контекст (см. makeContext)
 *     installFetch: false,                      // не подменять globalThis.fetch
 *   });
 *   await sb.load({ enable })         — загрузить плагин (onLoad, при enable — onEnable);
 *   await sb.call(user, method, path, options) — роут (см. callRoute);
 *   await sb.tick()                   — один тик планировщика (задача scheduleTask или runTick);
 *   await sb.wipe(profile, options)   — executeProfileRun из lib/wipe.js того же экземпляра;
 *   await sb.addProfile(overrides)    — положить профиль (makeProfile) в коллекцию profiles;
 *   await sb.run(promise), sb.until(predicate), sb.idle() — двигать часы;
 *   sb.runs() — документы коллекции runs; sb.profiles() — profiles; sb.status() — статус srv1;
 *   sb.tree, sb.tunnel, sb.panel, sb.clock, sb.journal, sb.store, sb.ctx, sb.users, sb.serverId;
 *   sb.plugin, sb.module (экспорт index.js: runTick, serverAccess), sb.lib(name) — после load();
 *   sb.restore() — снять подмены (тест делает это сам).
 */
export function createSandbox(options = {}) {
  const clock = options.clock === false ? null : createClock({ now: options.now ?? DEFAULT_NOW });
  if (clock) clock.install();
  const journal = createJournal();
  if (clock) journal.onPush(() => clock.poke());
  const treeSpec = options.tree ?? rustServerTree();
  const tree = treeSpec instanceof SandboxTree ? treeSpec : createTree(treeSpec);
  const users = options.users ?? defaultUsers();
  const servers = options.servers ?? [defaultServer({ uuid: tree.uuid })];
  const panel = createPanel({
    base: options.base ?? DEFAULT_PANEL_BASE,
    apiKey: options.apiKey ?? DEFAULT_API_KEY,
    apiKeyPermissions: options.apiKeyPermissions ?? ['*'],
    servers,
    users,
    journal,
    access: options.access ?? 'panel',
  });
  if (options.installFetch !== false) panel.install();
  const tunnel = createTunnel({
    tree,
    nodeId: options.nodeId ?? servers[0]?.nodeId ?? DEFAULT_NODE_ID,
    nodes: options.nodes,
    links: options.links ?? 'agent',
    journal,
  });
  const env = makeContext({
    tunnel,
    panel,
    config: { panelUrl: panel.base, apiKey: panel.apiKey, ...(options.config || {}) },
    configDefaults: options.configDefaults ?? true,
    grants: options.grants,
    journal,
    collections: options.collections,
    storage: options.storage,
  });
  const drive = (promise) => (clock?.installed ? clock.runUntil(promise) : promise);
  const sb = {
    ...env,
    clock,
    journal,
    tree,
    tunnel,
    panel,
    users,
    serverId: servers[0]?.id,
    async load(loadOptions = {}) {
      return loadPlugin(sb, loadOptions);
    },
    call(user, method, routePath, callOptions) {
      return callRoute(sb, user, method, routePath, callOptions);
    },
    async tick() {
      if (sb.tasks.size) return drive(sb.runTask());
      if (!sb.module) await sb.load();
      return drive(sb.module.runTick(sb.ctx));
    },
    async wipe(profile, wipeOptions = {}) {
      if (!sb.lib) await sb.load();
      const { executeProfileRun } = await sb.lib('wipe');
      return drive(executeProfileRun(sb.ctx, profile, wipeOptions));
    },
    async addProfile(overrides = {}) {
      const record = panel.server(overrides.serverId ?? sb.serverId);
      const profile = makeProfile(record, overrides);
      await sb.ctx.collection('profiles').insert(profile);
      return sb.ctx.collection('profiles').findOne({ id: profile.id });
    },
    run: (promise, runOptions) => (clock ? clock.runUntil(promise, runOptions) : Promise.resolve(promise)),
    until: (predicate, runOptions) => {
      if (!clock) throw new Error('песочница: until() работает только с поддельными часами');
      return clock.until(predicate, runOptions);
    },
    idle: (idleOptions) => (clock ? clock.runAll(idleOptions) : Promise.resolve(0)),
    runs: () => env.store.collection('runs').docs,
    profiles: () => env.store.collection('profiles').docs,
    status: (id = sb.serverId) => panel.status(id),
    restore() {
      panel.restore();
      clock?.restore();
    },
  };
  onTestDiagnostic(() => [...(clock ? clock.describe() : []), ...tunnel.describe(), ...panel.describe()]);
  return sb;
}

// ════════════════════════════════════════════════════════════════════════════
// 7. Дочерний процесс node с заданным TZ
// ════════════════════════════════════════════════════════════════════════════

/**
 * Запустить node в дочернем процессе и дождаться конца.
 *   runNode({ file, code, args, tz, env, timeoutMs, echo, cwd })
 *     file — путь к файлу; code — текст ES-модуля вместо файла (node --input-type=module --eval);
 *     tz — часовой пояс процесса (TZ задаётся через env дочернего процесса из node:
 *          заданный в Git Bash TZ со слешем по дороге теряется); null — убрать TZ;
 *     timeoutMs — настоящий предел времени (по умолчанию 120 с), потом процесс убивается;
 *     echo — сразу печатать вывод.
 * Возвращает { code, signal, stdout, stderr, tz, timedOut, durationMs }.
 */
export function runNode({ file, code, args = [], tz, env = {}, timeoutMs = 120000, echo = false, cwd } = {}) {
  if (!file && code === undefined) return Promise.reject(new Error('runNode: укажите file или code'));
  const childEnv = { ...process.env, ...env };
  if (tz === null) delete childEnv.TZ;
  else if (tz !== undefined) childEnv.TZ = String(tz);
  const argv = code !== undefined ? ['--input-type=module', '--eval', code, ...args] : [file, ...args];
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(process.execPath, argv, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    const timer = REAL.setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const done = (exitCode, signal, error) => {
      REAL.clearTimeout(timer);
      resolve({
        code: exitCode,
        signal: signal ?? null,
        stdout,
        stderr: error ? `${stderr}${error.message}` : stderr,
        tz: childEnv.TZ ?? null,
        timedOut,
        durationMs: Math.round(performance.now() - started),
      });
    };
    child.on('error', (error) => done(null, null, error));
    child.on('close', (exitCode, signal) => done(exitCode, signal));
  });
}

/** Запустить файл под часовым поясом tz: runWithTz('tools/review/x.test.mjs', 'Europe/Moscow'). */
export function runWithTz(file, tz, options = {}) {
  return runNode({ ...options, file, tz });
}

// ════════════════════════════════════════════════════════════════════════════
// 8. Мини-фреймворк тестов
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_TEST_TIMEOUT_MS = Number(process.env.REVIEW_TEST_TIMEOUT_MS) || 10000;

const testState = {
  queue: [],
  current: null,
  results: [],
  hooked: false,
  scheduled: false,
  finished: false,
  headerPrinted: false,
  strays: 0,
  skippedByFilter: 0,
  /** Тесты, снятые сторожем: их код может крутиться дальше и не дать процессу выйти. */
  abandoned: 0,
};

function out(line) {
  process.stdout.write(`${line}\n`);
}

function outSync(line) {
  try {
    fs.writeSync(1, `${line}\n`);
  } catch {
    /* вывод недоступен — ничего не поделать */
  }
}

function currentTestSignal() {
  return testState.current && !testState.current.done ? testState.current.signal : null;
}

/** Зарегистрировать уборку для текущего теста (если тест идёт). */
function onTestCleanup(fn) {
  const current = testState.current;
  if (current && !current.done) current.cleanups.push(fn);
}

/** Зарегистрировать источник строк диагностики на случай зависания. */
function onTestDiagnostic(fn) {
  const current = testState.current;
  if (current && !current.done) current.diagnostics.push(fn);
}

function timezoneLine() {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new REAL.Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const text = `${resolved} (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')})`;
  const requested = process.env.TZ;
  if (!requested) return { text, mismatch: null };
  let canonical = null;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: requested }).resolvedOptions().timeZone;
  } catch {
    canonical = null;
  }
  return {
    text,
    mismatch: canonical === resolved ? null : `часовой пояс TZ=${requested} не применился: процесс работает в ${resolved}`,
  };
}

function printHeader() {
  if (testState.headerPrinted) return;
  testState.headerPrinted = true;
  const script = process.argv[1] ? path.relative(process.cwd(), process.argv[1]) || process.argv[1] : '(код из --eval)';
  const zone = timezoneLine();
  out(`▶ ${script} · TZ: ${zone.text} · Node ${process.version}`);
  if (zone.mismatch) {
    testState.results.push({ name: 'проверка часового пояса', ok: false, ms: 0 });
    out(`FAIL  проверка часового пояса\n      ${zone.mismatch}`);
  }
}

const SELF_URL = import.meta.url;

/** Ошибка без строк стека — для сообщений самого фреймворка. */
function plainError(message) {
  const error = new Error(message);
  error.stack = message;
  return error;
}

function formatError(error) {
  if (!(error instanceof Error)) return [`      ${String(error)}`];
  const lines = String(error.stack || `${error.name}: ${error.message}`).split('\n');
  const head = lines.filter((line) => !/^\s+at /.test(line));
  const frames = lines
    .filter((line) => /^\s+at /.test(line) && !line.includes('node:internal') && !line.includes(SELF_URL))
    .slice(0, 6);
  return [...head, ...frames].map((line) => `      ${line.trimEnd()}`);
}

function restoreLeakedGlobals() {
  const leaked = [];
  if (globalThis.Date !== REAL.Date) {
    globalThis.Date = REAL.Date;
    leaked.push('Date');
  }
  for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']) {
    if (globalThis[name] !== REAL[name]) {
      globalThis[name] = REAL[name];
      leaked.push(name);
    }
  }
  if (AbortSignal.timeout !== REAL.abortSignalTimeout) {
    AbortSignal.timeout = REAL.abortSignalTimeout;
    leaked.push('AbortSignal.timeout');
  }
  if (globalThis.fetch?.[FAKE_FETCH] === 'панель') {
    globalThis.fetch = guardFetch;
    leaked.push('fetch');
  }
  if (leaked.length) activeClock = null;
  return leaked;
}

function finishTest(current, error) {
  if (current.done) return;
  current.done = true;
  REAL.clearTimeout(current.watchdog);
  if (error && !current.signal.aborted) current.controller.abort(error);
  const cleanupErrors = [];
  for (const fn of current.cleanups.reverse()) {
    try {
      fn();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  const leaked = restoreLeakedGlobals();
  const ms = Math.round(performance.now() - current.started);
  const ok = !error && cleanupErrors.length === 0;
  testState.results.push({ name: current.name, ok, ms });
  const write = testState.finished ? outSync : out;
  write(`${ok ? 'PASS' : 'FAIL'}  ${current.name} (${ms} мс)`);
  for (const note of current.notes) write(`      · ${note}`);
  if (error) for (const line of formatError(error)) write(line);
  for (const cleanupError of cleanupErrors) {
    write('      ошибка уборки после теста:');
    for (const line of formatError(cleanupError)) write(line);
  }
  if (leaked.length) {
    write(`      внимание: после теста остались подмены (${leaked.join(', ')}) — сняты. Создавайте песочницу внутри test().`);
  }
  if (testState.current === current) testState.current = null;
  scheduleNextTest();
}

function scheduleNextTest() {
  if (testState.scheduled || testState.current || testState.finished) return;
  testState.scheduled = true;
  REAL.setImmediate(runNextTest);
}

async function runNextTest() {
  testState.scheduled = false;
  if (testState.current || testState.finished) return;
  printHeader();
  const item = testState.queue.shift();
  if (!item) {
    // Обычно итог печатает beforeExit. Но если сторож снял тест, его код может
    // крутиться дальше и цикл событий не опустеет — тогда завершаемся сами.
    if (testState.abandoned) {
      testState.finished = true;
      printSummary(out, () => process.exit(process.exitCode || 1));
    }
    return;
  }
  const filter = process.env.REVIEW_ONLY;
  if (item.skip || (filter && !item.name.includes(filter))) {
    if (item.skip) out(`SKIP  ${item.name}`);
    else testState.skippedByFilter += 1;
    scheduleNextTest();
    return;
  }
  const controller = new AbortController();
  const current = {
    ...item,
    controller,
    signal: controller.signal,
    cleanups: [],
    diagnostics: [],
    notes: [],
    done: false,
    started: performance.now(),
  };
  testState.current = current;
  current.watchdog = REAL.setTimeout(() => {
    testState.abandoned += 1;
    finishTest(
      current,
      plainError(
        [`сторож: тест идёт дольше ${current.timeoutMs} мс настоящего времени`, ...collectDiagnostics(current)].join('\n      '),
      ),
    );
  }, current.timeoutMs);
  current.watchdog.unref?.();
  const api = {
    name: current.name,
    signal: current.signal,
    cleanup: (fn) => current.cleanups.push(fn),
    note: (message) => current.notes.push(String(message)),
  };
  try {
    await current.fn(api);
    finishTest(current, null);
  } catch (error) {
    finishTest(current, error);
  }
}

function collectDiagnostics(current) {
  const lines = [];
  for (const fn of current.diagnostics) {
    try {
      lines.push(...fn());
    } catch {
      /* диагностика не должна ломать отчёт */
    }
  }
  return lines;
}

/** Итог прогона; done — вызвать, когда последняя строка ушла в вывод. */
function printSummary(write = out, done) {
  const passed = testState.results.filter((result) => result.ok).length;
  const failed = testState.results.filter((result) => !result.ok);
  write('');
  if (testState.skippedByFilter) write(`пропущено по фильтру REVIEW_ONLY: ${testState.skippedByFilter}`);
  if (failed.length) write(`провалены: ${failed.map((result) => result.name).join('; ')}`);
  if (testState.strays) write(`ошибок вне тестов: ${testState.strays}`);
  if (failed.length || testState.strays) process.exitCode = 1;
  const last = `Итог: ${passed} PASS, ${failed.length + testState.strays} FAIL`;
  if (done) process.stdout.write(`${last}\n`, () => done());
  else write(last);
}

function hookProcess() {
  if (testState.hooked) return;
  testState.hooked = true;
  process.on('beforeExit', () => {
    const current = testState.current;
    if (current && !current.done) {
      finishTest(
        current,
        plainError(
          [
            'тест не завершился: цикл событий опустел, а тест ещё ждёт (вечный промис или часы, которые никто не двигает)',
            ...collectDiagnostics(current),
          ].join('\n      '),
        ),
      );
      return;
    }
    if (testState.queue.length) {
      scheduleNextTest();
      return;
    }
    if (!testState.finished) {
      printHeader();
      testState.finished = true;
      printSummary();
    }
  });
  process.on('exit', (code) => {
    if (testState.finished) return;
    testState.finished = true;
    const current = testState.current;
    if (current && !current.done) {
      finishTest(current, plainError(`тест не завершился: процесс завершился (код ${code}) раньше теста`));
    }
    for (const item of testState.queue.splice(0)) {
      testState.results.push({ name: item.name, ok: false, ms: 0 });
      outSync(`FAIL  ${item.name}\n      не запускался: процесс завершился раньше`);
    }
    printSummary(outSync);
    process.exitCode = 1;
  });
  const stray = (kind) => (error) => {
    const current = testState.current;
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (current && !current.done) {
      const failure = new Error(`${kind}: ${wrapped.message}`);
      failure.stack = `${failure.message}\n${String(wrapped.stack || '').split('\n').slice(1).join('\n')}`;
      finishTest(current, failure);
      return;
    }
    testState.strays += 1;
    out(`FAIL  (вне теста) ${kind}`);
    for (const line of formatError(wrapped)) out(line);
    process.exitCode = 1;
  };
  process.on('unhandledRejection', stray('необработанное отклонение промиса'));
  process.on('uncaughtException', stray('необработанное исключение'));
}

/**
 * Зарегистрировать тест. Тесты идут по очереди, по одному.
 *   test('имя', async (t) => { ... }, { timeoutMs, skip })
 * t: { name, signal, cleanup(fn), note(текст) } — note печатается под строкой PASS/FAIL.
 * Вывод: PASS/FAIL на тест и «Итог: N PASS, M FAIL»; код выхода 1 при любом провале.
 * Зависания:
 *   - цикл событий опустел, а тест не закончился (вечный промис, часы никто не
 *     двигает) — FAIL «тест не завершился», остальные тесты продолжаются;
 *   - тест идёт дольше timeoutMs настоящего времени (по умолчанию 10 с,
 *     переменная REVIEW_TEST_TIMEOUT_MS) — FAIL «сторож»;
 *   - процесс завершился раньше — FAIL «тест не завершился», код выхода 1.
 * Необработанные исключения и отклонения промисов проваливают текущий тест.
 * REVIEW_ONLY=<подстрока> — запустить только тесты с подстрокой в имени.
 * Если задан TZ, а процесс работает в другом поясе, это тоже FAIL.
 */
export function test(name, fn, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('test(name, fn): fn должна быть функцией');
  hookProcess();
  if (testState.finished) {
    outSync(`FAIL  ${name}\n      зарегистрирован после итога — не запускался`);
    process.exitCode = 1;
    return;
  }
  testState.queue.push({
    name: String(name),
    fn,
    timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    skip: Boolean(options.skip),
  });
  scheduleNextTest();
}

// ════════════════════════════════════════════════════════════════════════════
// Временная папка для настоящих файлов
// ════════════════════════════════════════════════════════════════════════════

/**
 * Временная папка из os.tmpdir() через fs.mkdtemp; после fn(dir) удаляется.
 * Удаление — только этой папки и только если она внутри временного каталога
 * и её имя начинается с prefix. Ссылки внутри на важные места не создавайте.
 */
export async function withTempDir(fn, { prefix = 'rustwipe-review-' } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new Error('withTempDir: префикс — латиница, цифры, . _ -');
  const base = await fsp.realpath(os.tmpdir());
  const dir = await fsp.mkdtemp(path.join(base, prefix));
  try {
    return await fn(dir);
  } finally {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(base + path.sep) || !path.basename(resolved).startsWith(prefix)) {
      throw new Error('песочница: отказ удалять папку вне временного каталога');
    }
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

/** Каталог этого файла (для run.mjs и самопроверки). */
export const REVIEW_DIR = path.dirname(fileURLToPath(import.meta.url));
