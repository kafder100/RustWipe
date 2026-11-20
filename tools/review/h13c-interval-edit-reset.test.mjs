/**
 * Ревью RustWipe, гипотеза 13 (раздел 4.2), утверждение H13c:
 * у расписания «каждые N дней» без точки отсчёта (anchorDate: null — так создаёт
 * профиль вкладка) любая правка профиля, даже кнопка «Выключить», начинает отсчёт
 * заново от дня правки.
 *
 * Правильное поведение (ответ владельца №10, «как написано выше»): считать от
 * даты-якоря; если якорь не задан, плагин запоминает первую дату и считает от неё;
 * правка, не меняющая расписание, отсчёт не сбрасывает.
 *
 * Запуск: node tools/review/h13c-interval-edit-reset.test.mjs
 * Файл сам перезапускает себя дочерними процессами с TZ=UTC, Europe/Moscow,
 * America/New_York. Часы поддельные, файлов и сети нет: туннель и fetch — подмены.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ZONES = ['UTC', 'Europe/Moscow', 'America/New_York'];
const BACKEND = new URL('../../rust-autowipe/backend/index.js', import.meta.url).href;

// ── Мини-набор тестов: незавершённый тест считается проваленным ─────────────
const tests = [];
const pending = new Set();
let passed = 0;
let failed = 0;
let reported = false;
function test(name, fn) {
  tests.push({ name, fn });
}

// ── Поддельные часы ─────────────────────────────────────────────────────────
const RealDate = Date;
let nowMs = RealDate.now();
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(nowMs);
    else super(...args);
  }
  static now() {
    return nowMs;
  }
}
function setNow(value) {
  nowMs = new RealDate(value).getTime();
}
const local = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new RealDate(y, mo - 1, d, h, mi, s, ms);
function fmtLocal(value) {
  const d = new RealDate(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Подмены контекста плагина ───────────────────────────────────────────────
function makeTunnel() {
  const tree = {
    '/': [{ name: 'server', isDirectory: true }],
    '/server': [{ name: 'rust', isDirectory: true }],
    '/server/rust': [{ name: 'proceduralmap.3000.1.sav', isDirectory: false }],
  };
  return {
    deletes: [],
    async queueRequest(_nodeId, operation, _uuid, path) {
      if (operation === 'list') {
        const entries = tree[path];
        if (!entries) return { success: false, error: `Path not found: ${path}` };
        return { success: true, data: entries.map((e) => ({ ...e, size: 1 })) };
      }
      if (operation === 'delete') {
        this.deletes.push(path);
        return { success: false, error: 'удаление в тесте запрещено' };
      }
      return { success: false, error: `неизвестная операция ${operation}` };
    },
  };
}

function makeCtx({ config = {} } = {}) {
  const servers = [
    { id: 'srv1', uuid: 'uuid-1', nodeId: 'node-1', ownerId: 'owner_1', name: 'Rust #1', status: 'running' },
  ];
  const stores = new Map();
  const routes = [];
  let seq = 0;
  const matches = (doc, filter) => Object.entries(filter || {}).every(([k, v]) => doc[k] === v);
  const collection = (name) => {
    if (!stores.has(name)) stores.set(name, []);
    const docs = stores.get(name);
    return {
      async find(filter = {}, options = {}) {
        let out = docs.filter((d) => matches(d, filter));
        if (options.sort) {
          const [key, dir] = Object.entries(options.sort)[0];
          out = [...out].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (dir === -1 ? -1 : 1));
        }
        if (options.limit) out = out.slice(0, options.limit);
        return out.map((d) => structuredClone(d));
      },
      async findOne(filter) {
        const doc = docs.find((d) => matches(d, filter));
        return doc ? structuredClone(doc) : null;
      },
      async insert(doc) {
        seq += 1;
        const stored = { _id: `doc${seq}`, ...structuredClone(doc) };
        docs.push(stored);
        return structuredClone(stored);
      },
      async update(filter, update) {
        let count = 0;
        for (const doc of docs) {
          if (!matches(doc, filter)) continue;
          Object.assign(doc, structuredClone(update.$set || {}));
          count += 1;
        }
        return count;
      },
      async delete(filter) {
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i -= 1) if (matches(docs[i], filter)) docs.splice(i, 1);
        return before - docs.length;
      },
      async count(filter) {
        return docs.filter((d) => matches(d, filter)).length;
      },
    };
  };
  const ctx = {
    manifest: { name: 'rust-autowipe', version: 'review' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: (key) => (key in config ? config[key] : undefined),
    getStorage: async () => null,
    setStorage: async () => {},
    collection,
    db: { servers: { findUnique: async ({ where }) => servers.find((s) => s.id === where.id) || null } },
    registerRoute: (route) => routes.push(route),
    scheduleTask: () => {},
    emit: () => {},
    fileTunnel: makeTunnel(),
    getUserId: () => 'admin_1',
    hasPermission: () => true,
  };
  return { ctx, routes, stores };
}

async function callRoute(routes, method, url, { params = {}, query = {}, body, headers = {} } = {}) {
  const route = routes.find((r) => r.method === method && r.url === url);
  if (!route) throw new Error(`нет роута ${method} ${url}`);
  const reply = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      return payload;
    },
  };
  const result = await route.handler({ params, query, body, headers, url }, reply);
  return { status: reply.statusCode, body: result };
}

// ── Проверки ────────────────────────────────────────────────────────────────
let plugin;

/**
 * Понедельник 02.11.2026 12:00: создаём «каждые 7 дн., 05:00» без точки отсчёта —
 * так, как это отправляет вкладка (anchorDate: null). Первый запуск — 09.11 05:00.
 */
async function setup() {
  const env = makeCtx();
  await plugin.onLoad(env.ctx);
  globalThis.fetch = async (url) => {
    throw new Error(`сеть в тесте запрещена: ${url}`);
  };
  setNow(local(2026, 11, 2, 12, 0));
  const created = await callRoute(env.routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: {
      name: 'Интервал',
      enabled: true,
      targets: ['/server/rust/*.sav'],
      schedule: { kind: 'interval', intervalDays: 7, time: '05:00', weekday: 4, nth: 1, day: 1, anchorDate: null },
      options: { dryRun: true, warnChat: false },
    },
  });
  assert.equal(created.status, 200, `профиль не создан: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id;
  assert.equal(fmtLocal(created.body.data.nextRunAt), '2026-11-09 05:00', 'предусловие: первый запуск 09.11 05:00');
  const put = async (body) => {
    const res = await callRoute(env.routes, 'PUT', '/servers/:serverId/profiles/:profileId', {
      params: { serverId: 'srv1', profileId: id },
      body,
    });
    assert.equal(res.status, 200, `правка не сохранена: ${JSON.stringify(res.body)}`);
  };
  const nextRun = async () => fmtLocal((await env.ctx.collection('profiles').findOne({ id })).nextRunAt);
  const card = async () => {
    const list = await callRoute(env.routes, 'GET', '/servers/:serverId/profiles', { params: { serverId: 'srv1' } });
    return list.body.data.find((p) => p.id === id);
  };
  return { ...env, id, put, nextRun, card };
}

test('кнопка «Выключить» в среду и «Включить» в пятницу: вайп остаётся 09.11 05:00', async () => {
  const { put, nextRun } = await setup();
  setNow(local(2026, 11, 4, 12, 0));
  await put({ enabled: false }); // ровно то, что шлёт toggleProfile вкладки
  setNow(local(2026, 11, 6, 12, 0));
  await put({ enabled: true });
  const got = await nextRun();
  assert.equal(got, '2026-11-09 05:00', `после выключения и включения следующий вайп ${got}, а должен остаться 2026-11-09 05:00`);
});

test('переименование в редакторе (расписание то же) в среду: вайп остаётся 09.11 05:00', async () => {
  const { put, nextRun, card } = await setup();
  setNow(local(2026, 11, 4, 12, 0));
  const profile = await card();
  // Тело как у saveProfile вкладки: черновик — копия карточки профиля.
  await put({
    name: 'Интервал (новое имя)',
    serverId: profile.serverId,
    enabled: profile.enabled,
    schedule: structuredClone(profile.schedule),
    targets: profile.targets,
    excludes: profile.excludes,
    options: profile.options,
    map: profile.map,
  });
  const got = await nextRun();
  assert.equal(got, '2026-11-09 05:00', `после переименования следующий вайп ${got}, а должен остаться 2026-11-09 05:00`);
});

// ── Точка входа ─────────────────────────────────────────────────────────────
async function runAll() {
  process.on('beforeExit', () => {
    if (reported) return;
    reported = true;
    for (const name of pending) {
      failed += 1;
      console.log(`  FAIL  ${name}: тест не завершился`);
    }
    console.log(`${passed} прошло, ${failed} провалено`);
    if (failed) process.exitCode = 1;
  });
  for (const t of tests) pending.add(t.name);
  globalThis.Date = FakeDate;
  ({ default: plugin } = await import(BACKEND));
  console.log(`TZ процесса: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok    ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      // Своё сообщение — одной строкой, без автоматического диффа node:assert.
      const text = error instanceof assert.AssertionError
        ? (error.generatedMessage ? error.message : error.message.split('\n')[0])
        : String(error?.stack ?? error);
      for (const line of text.split('\n').filter((l) => l.trim())) console.log(`        ${line}`);
    }
    pending.delete(name);
  }
}

function spawnZones() {
  let bad = 0;
  for (const zone of ZONES) {
    console.log(`\n=== TZ=${zone}`);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: zone, RW_REVIEW_CHILD: '1' },
      stdio: 'inherit',
      timeout: 120000,
    });
    if (child.status !== 0) {
      bad += 1;
      console.log(`=== TZ=${zone}: провал (код ${child.status ?? child.signal})`);
    }
  }
  console.log(bad ? `\nИТОГ: провал в ${bad} из ${ZONES.length} поясов` : `\nИТОГ: все пояса прошли (${ZONES.length})`);
  process.exitCode = bad ? 1 : 0;
}

if (process.env.RW_REVIEW_CHILD === '1') runAll();
else spawnZones();
