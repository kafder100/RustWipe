/**
 * Ревью RustWipe, гипотеза 15 (раздел 4.2), утверждение H15c:
 * состояние отправки предупреждений одно на весь плагин (wipeWarningState) и
 * отдаётся во вкладку любого сервера: владелец сервера B видит в /status
 * (wipeWarning.state → чип «Чат: ок» / «Чат: ошибка предупреждения») чужую
 * отправку с сервера A — её текст, ошибку и id чужого сервера и профиля.
 *
 * Правильное поведение (README: вкладка «работает только с этим сервером»;
 * правила 3.1 — без неправды в интерфейсе): вкладка сервера B показывает только
 * состояние предупреждений сервера B (или ничего, если B ничего не отправлял).
 *
 * Запуск: node tools/review/h15c-warn-state-shared.test.mjs
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

// ── Подмены контекста плагина и fetch ───────────────────────────────────────
function makeTunnel() {
  return {
    async queueRequest(_nodeId, operation) {
      if (operation === 'delete') return { success: false, error: 'удаление в тесте запрещено' };
      return { success: true, data: [] };
    },
  };
}

/** Два сервера разных владельцев; кто «вызывает роут», задаётся через who. */
function makeCtx({ config = {} } = {}) {
  const servers = [
    { id: 'srvA', uuid: 'uuid-a', nodeId: 'node-1', ownerId: 'owner_a', name: 'Rust A', status: 'running' },
    { id: 'srvB', uuid: 'uuid-b', nodeId: 'node-1', ownerId: 'owner_b', name: 'Rust B', status: 'running' },
  ];
  const who = { userId: 'admin_1', perms: ['*'] };
  const stores = new Map();
  const storage = new Map();
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
    getStorage: async (key) => (storage.has(key) ? structuredClone(storage.get(key)) : null),
    setStorage: async (key, value) => {
      storage.set(key, structuredClone(value));
    },
    collection,
    db: { servers: { findUnique: async ({ where }) => servers.find((s) => s.id === where.id) || null } },
    registerRoute: (route) => routes.push(route),
    scheduleTask: () => {},
    emit: () => {},
    fileTunnel: makeTunnel(),
    getUserId: () => who.userId,
    hasPermission: (_request, token) => who.perms.includes('*') || who.perms.includes(token),
  };
  return { ctx, routes, stores, who };
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

/** fetch панели: отвечает заданным кодом; в сеть ничего не уходит. */
function panelFetch(status) {
  globalThis.fetch = async () => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(status < 400 ? { success: true } : { error: 'Forbidden: console.write' }),
  });
}

// ── Проверки ────────────────────────────────────────────────────────────────
let plugin;
let runTick;

/** Админ создаёт профиль на сервере A; тик за 3 минуты до запуска шлёт предупреждение. */
async function warnOnServerA(status) {
  const env = makeCtx({ config: { apiKey: 'test-key', panelUrl: 'https://panel.test' } });
  await plugin.onLoad(env.ctx);
  setNow(new RealDate(2026, 10, 16, 12, 0));
  panelFetch(200);
  const created = await callRoute(env.routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srvA' },
    body: {
      name: 'Вайп A',
      targets: ['/server/rust/*.sav'],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
      options: { dryRun: false, warnChat: true },
    },
  });
  assert.equal(created.status, 200, `профиль не создан: ${JSON.stringify(created.body)}`);
  panelFetch(status);
  setNow(new RealDate(created.body.data.nextRunAt).getTime() - 3 * 60000 + 40);
  await runTick(env.ctx);
  return env;
}

/** Владелец сервера B (без ролей плагина) открывает вкладку своего сервера. */
async function statusOfServerB(env) {
  env.who.userId = 'owner_b';
  env.who.perms = [];
  const res = await callRoute(env.routes, 'GET', '/servers/:serverId/status', { params: { serverId: 'srvB' } });
  assert.equal(res.status, 200, `вкладка B не открылась: ${JSON.stringify(res.body)}`);
  return res.body.data.wipeWarning?.state ?? null;
}

const foreign = (state) => Boolean(state) && state.serverId !== 'srvB';

test('успешное предупреждение сервера A не показывается во вкладке сервера B', async () => {
  const env = await warnOnServerA(200);
  const state = await statusOfServerB(env);
  assert.ok(!foreign(state), `вкладка B получила чужое состояние: ${JSON.stringify(state)}`);
});

test('ошибка предупреждения сервера A не превращается в «Чат: ошибка» во вкладке сервера B', async () => {
  const env = await warnOnServerA(403);
  const state = await statusOfServerB(env);
  assert.ok(!foreign(state), `вкладка B получила чужую ошибку: ${JSON.stringify(state)}`);
});

test('«Тест предупреждения» админа на сервере A не показывается во вкладке сервера B', async () => {
  const env = makeCtx({ config: { apiKey: 'test-key', panelUrl: 'https://panel.test' } });
  await plugin.onLoad(env.ctx);
  setNow(new RealDate(2026, 10, 16, 12, 0));
  panelFetch(200);
  const res = await callRoute(env.routes, 'POST', '/servers/:serverId/warn-test', { params: { serverId: 'srvA' } });
  assert.equal(res.status, 200, `тест предупреждения не отправлен: ${JSON.stringify(res.body)}`);
  const state = await statusOfServerB(env);
  assert.ok(!foreign(state), `вкладка B получила чужой тест: ${JSON.stringify(state)}`);
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
  ({ default: plugin, runTick } = await import(BACKEND));
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
    console.log(`
=== TZ=${zone}`);
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
  console.log(bad ? `
ИТОГ: провал в ${bad} из ${ZONES.length} поясов` : `
ИТОГ: все пояса прошли (${ZONES.length})`);
  process.exitCode = bad ? 1 : 0;
}

if (process.env.RW_REVIEW_CHILD === '1') runAll();
else spawnZones();
