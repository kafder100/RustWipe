/**
 * Ревью RustWipe, гипотеза 13 (раздел 4.2), утверждение H13a:
 * время расписания считается в часовом поясе процесса панели, своего пояса у профиля нет.
 *
 * Правильное поведение (ответ владельца №12): «Нужен пояс у каждого профиля» —
 * «четверг 05:00» профиля с поясом America/New_York и профиля с поясом Europe/Moscow —
 * это разные моменты, и ни один не зависит от TZ контейнера панели (у Catalyst по
 * умолчанию TZ=UTC). Переход на летнее время считается по поясу профиля.
 *
 * Поля пояса в плагине пока нет, поэтому тест передаёт его под несколькими
 * вероятными именами (profile.timezone / timeZone, schedule.timezone / timeZone / tz)
 * и проверяет только наблюдаемое — nextRunAt.
 *
 * Запуск: node tools/review/h13a-profile-timezone.test.mjs
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
const iso = (value) => new RealDate(value).toISOString();

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
let runTick;

async function freshPlugin() {
  const env = makeCtx();
  await plugin.onLoad(env.ctx);
  globalThis.fetch = async (url) => {
    throw new Error(`сеть в тесте запрещена: ${url}`);
  };
  return env;
}

/** Создаёт профиль с поясом zone через роут вкладки; возвращает сохранённый профиль. */
async function createInZone(env, name, schedule, zone) {
  const created = await callRoute(env.routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: {
      name,
      targets: ['/server/rust/*.sav'],
      timezone: zone,
      timeZone: zone,
      schedule: { ...schedule, timezone: zone, timeZone: zone, tz: zone },
      options: { dryRun: true, warnChat: false },
    },
  });
  assert.equal(created.status, 200, `профиль не создан: ${JSON.stringify(created.body)}`);
  return env.ctx.collection('profiles').findOne({ id: created.body.data.id });
}

test('два профиля «четверг 05:00» с поясами New York и Москва получают разные nextRunAt', async () => {
  const env = await freshPlugin();
  setNow(Date.UTC(2026, 10, 16, 12, 0)); // понедельник 16.11.2026 12:00 UTC
  const ny = await createInZone(env, 'NY', { kind: 'weekly', weekday: 4, time: '05:00' }, 'America/New_York');
  const msk = await createInZone(env, 'MSK', { kind: 'weekly', weekday: 4, time: '05:00' }, 'Europe/Moscow');
  const got = { ny: iso(ny.nextRunAt), msk: iso(msk.nextRunAt) };
  const want = { ny: '2026-11-19T10:00:00.000Z', msk: '2026-11-19T02:00:00.000Z' };
  assert.deepEqual(got, want, `ожидалось ${JSON.stringify(want)}, получено ${JSON.stringify(got)}`);
});

test('переход на летнее время считается по поясу профиля, а не процесса панели', async () => {
  const env = await freshPlugin();
  setNow(Date.UTC(2026, 9, 28, 12, 0)); // среда 28.10.2026
  const ny = await createInZone(env, 'NY', { kind: 'weekly', weekday: 0, time: '05:00' }, 'America/New_York');
  setNow(Date.UTC(2026, 2, 25, 12, 0)); // среда 25.03.2026
  const ber = await createInZone(env, 'BER', { kind: 'weekly', weekday: 0, time: '05:00' }, 'Europe/Berlin');
  const got = { ny: iso(ny.nextRunAt), ber: iso(ber.nextRunAt) };
  // 01.11.2026 05:00 EST = 10:00Z (уже зимнее); 29.03.2026 05:00 CEST = 03:00Z (уже летнее).
  const want = { ny: '2026-11-01T10:00:00.000Z', ber: '2026-03-29T03:00:00.000Z' };
  assert.deepEqual(got, want, `ожидалось ${JSON.stringify(want)}, получено ${JSON.stringify(got)}`);
});

test('после планового прогона следующий запуск снова считается в поясе профиля', async () => {
  const env = await freshPlugin();
  setNow(Date.UTC(2026, 10, 16, 12, 0));
  const ny = await createInZone(env, 'NY', { kind: 'weekly', weekday: 4, time: '05:00' }, 'America/New_York');
  // Ставим правильный момент явно, чтобы проверка не зависела от первой.
  await env.ctx.collection('profiles').update({ id: ny.id }, { $set: { nextRunAt: '2026-11-19T10:00:00.000Z' } });
  setNow(Date.UTC(2026, 10, 19, 10, 0, 0, 40));
  await runTick(env.ctx);
  const runs = await env.ctx.collection('runs').find({ profileId: ny.id });
  assert.equal(runs.length, 1, `плановый прогон не прошёл: прогонов ${runs.length}`);
  const after = await env.ctx.collection('profiles').findOne({ id: ny.id });
  assert.equal(iso(after.nextRunAt), '2026-11-26T10:00:00.000Z', `nextRunAt после прогона: ${iso(after.nextRunAt)}`);
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
