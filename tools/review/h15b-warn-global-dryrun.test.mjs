/**
 * Ревью RustWipe, гипотеза 15 (раздел 4.2), утверждение H15b:
 * предупреждения в чат не учитывают глобальный режим проверки — при включённой
 * настройке плагина dryRun («показывать, что было бы удалено, но ничего не удалять
 * и не останавливать сервер») игроки всё равно видят отсчёт «Вайп сервера через N мин».
 *
 * Правильное поведение (ответ владельца №15 «Отсчёт перед проверочным прогоном — Нет»):
 * при глобальном dry-run в консоль сервера не уходит ни одного предупреждения.
 *
 * Проверяется настоящий тик планировщика (runTick из index.js) на подменах контекста
 * и fetch: смотрим, какие команды ушли в /console/command.
 *
 * Запуск: node tools/review/h15b-warn-global-dryrun.test.mjs
 * Файл сам перезапускает себя дочерними процессами с TZ=UTC, Europe/Moscow,
 * America/New_York. Часы поддельные, файлов и сети нет.
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
    deletes: [],
    async queueRequest(_nodeId, operation, _uuid, path) {
      if (operation === 'delete') {
        this.deletes.push(path);
        return { success: false, error: 'удаление в тесте запрещено' };
      }
      return { success: true, data: [] };
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

/** fetch панели: записывает вызовы и отвечает успехом; в сеть ничего не уходит. */
function recordFetch() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  return calls;
}
const consoleCommands = (calls) => calls.filter((c) => c.url.endsWith('/console/command')).map((c) => c.body?.command);

// ── Проверки ────────────────────────────────────────────────────────────────
let plugin;
let runTick;

/**
 * Боевой профиль «четверг 05:00» (создан в понедельник), API-ключ задан,
 * предупреждения включены по умолчанию; глобальный dryRun — как передан.
 * Тикаем каждую минуту за 6 минут до запуска (сам запуск не наступает).
 */
async function warningsBeforeRun({ globalDryRun }) {
  const env = makeCtx({ config: { apiKey: 'test-key', panelUrl: 'https://panel.test', dryRun: globalDryRun } });
  await plugin.onLoad(env.ctx);
  setNow(new RealDate(2026, 10, 16, 12, 0));
  recordFetch();
  const created = await callRoute(env.routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: {
      name: 'Четверг',
      targets: ['/server/rust/*.sav'],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
      options: { dryRun: false, warnChat: true, stopServer: true, startServer: true },
    },
  });
  assert.equal(created.status, 200, `профиль не создан: ${JSON.stringify(created.body)}`);
  const runAt = new RealDate(created.body.data.nextRunAt).getTime();
  const calls = recordFetch();
  for (let t = runAt - 6 * 60000; t < runAt; t += 60000) {
    setNow(t + 40);
    await runTick(env.ctx);
  }
  return consoleCommands(calls);
}

test('контроль: глобальный dryRun выключен — отсчёт уходит в чат (5, 4, 3, 2, 1)', async () => {
  const sent = await warningsBeforeRun({ globalDryRun: false });
  assert.equal(sent.length, 5, `ушло команд: ${sent.length} (${sent.join(' | ')})`);
});

test('глобальный dryRun включён — в чат сервера не уходит ни одного предупреждения', async () => {
  const sent = await warningsBeforeRun({ globalDryRun: true });
  assert.deepEqual(sent, [], `при глобальном режиме проверки ушло в консоль ${sent.length}: ${sent.join(' | ')}`);
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
