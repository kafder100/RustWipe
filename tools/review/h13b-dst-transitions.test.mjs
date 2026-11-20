/**
 * Ревью RustWipe, гипотеза 13 (раздел 4.2), утверждение H13b:
 * в ночь перехода на летнее/зимнее время (пояс процесса панели) плановый вайп
 * пропускается, проходит дважды или уходит на другое время.
 *
 * Правильное поведение (README: «время — в часовом поясе панели»): вайп по
 * настенным часам пояса панели — ровно один раз в нужный день; несуществующее время
 * (весной) — сразу после перевода часов, не позже чем через час; повторяющееся
 * (осенью) — один раз; следующий запуск — через неделю в то же настенное время.
 *
 * Ожидания считаются отдельно от кода плагина: по зашитым моментам перехода
 * 2026 года (New York — 08.03 и 01.11, Берлин — 29.03 и 25.10, Москва и UTC —
 * без перехода).
 *
 * Запуск: node tools/review/h13b-dst-transitions.test.mjs
 * Файл сам перезапускает себя дочерними процессами с TZ=UTC, Europe/Moscow,
 * America/New_York и Europe/Berlin (для европейского перехода). Часы поддельные:
 * тик планировщика прогоняется каждую минуту без реального ожидания.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ZONES = ['UTC', 'Europe/Moscow', 'America/New_York', 'Europe/Berlin'];
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
const iso = (value) => new RealDate(value).toISOString();

// ── Независимый оракул: допустимые моменты UTC для настенного времени ───────
const RULES = {
  UTC: { std: 0 },
  'Europe/Moscow': { std: 180 },
  'America/New_York': { std: -300, dst: -240, from: RealDate.UTC(2026, 2, 8, 7), to: RealDate.UTC(2026, 10, 1, 6) },
  'Europe/Berlin': { std: 60, dst: 120, from: RealDate.UTC(2026, 2, 29, 1), to: RealDate.UTC(2026, 9, 25, 1) },
};
function allowed(y, mo, d, h, mi) {
  const rule = RULES[process.env.TZ];
  if (!rule) throw new Error(`нет правил перехода для TZ=${process.env.TZ}`);
  const wall = RealDate.UTC(y, mo - 1, d, h, mi);
  if (rule.dst === undefined) return { exact: [wall - rule.std * 60000] };
  const inDst = (t) => t >= rule.from && t < rule.to;
  const exact = [];
  const asStd = wall - rule.std * 60000;
  const asDst = wall - rule.dst * 60000;
  if (!inDst(asStd)) exact.push(asStd);
  if (inDst(asDst)) exact.push(asDst);
  if (exact.length) return { exact };
  return { gap: [rule.from, asStd] }; // время не существует: от перевода часов до +1 ч
}
function fits(ms, spec, slackMs) {
  if (spec.exact) return spec.exact.some((t) => ms >= t && ms <= t + slackMs);
  return ms >= spec.gap[0] && ms <= spec.gap[1] + slackMs;
}
const show = (spec) => (spec.exact ? spec.exact.map(iso).join(' или ') : `${iso(spec.gap[0])} … ${iso(spec.gap[1])}`);

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

// ── Помощники сценариев ─────────────────────────────────────────────────────
let plugin;
let runTick;

async function profileAt(createdAt, schedule) {
  const env = makeCtx();
  await plugin.onLoad(env.ctx);
  globalThis.fetch = async (url) => {
    throw new Error(`сеть в тесте запрещена: ${url}`);
  };
  setNow(createdAt);
  const created = await callRoute(env.routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: { name: 'DST', targets: ['/server/rust/*.sav'], schedule, options: { dryRun: true, warnChat: false } },
  });
  assert.equal(created.status, 200, `профиль не создан: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id;
  return {
    ...env,
    id,
    profile: () => env.ctx.collection('profiles').findOne({ id }),
    runs: () => env.ctx.collection('runs').find({ profileId: id }, { sort: { startedAt: 1 } }),
  };
}

/** Тик cron «* * * * *» каждую минуту реального времени (через +40 мс после начала минуты). */
async function tickEveryMinute(ctx, from, to) {
  const start = Math.ceil(new RealDate(from).getTime() / 60000) * 60000;
  for (let t = start; t <= new RealDate(to).getTime(); t += 60000) {
    setNow(t + 40);
    await runTick(ctx);
  }
}

/** Перескакивает часы прямо на nextRunAt (+40 мс) и делает тик — для длинных серий. */
async function jumpToNextRun(env) {
  const { nextRunAt } = await env.profile();
  setNow(new RealDate(nextRunAt).getTime() + 40);
  await runTick(env.ctx);
}

const SUNDAYS = [
  [2026, 3, 8, 'весенний переход в New York'],
  [2026, 11, 1, 'осенний переход в New York'],
  [2026, 3, 29, 'весенний переход в Европе'],
  [2026, 10, 25, 'осенний переход в Европе'],
];

// ── Проверки ────────────────────────────────────────────────────────────────
for (const [y, mo, d, label] of SUNDAYS) {
  for (const time of ['01:30', '02:30', '05:00']) {
    const [hh, mm] = time.split(':').map(Number);
    test(`еженедельно, воскресенье ${time}, ${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')} (${label}): ровно один вайп, через неделю — то же время`, async () => {
      const env = await profileAt(local(y, mo, d - 1, 12, 0), { kind: 'weekly', weekday: 0, time });
      await tickEveryMinute(env.ctx, local(y, mo, d - 1, 20, 0), local(y, mo, d, 8, 0));
      const runs = await env.runs();
      const spec = allowed(y, mo, d, hh, mm);
      assert.equal(runs.length, 1, `прогонов за ночь: ${runs.length} (${runs.map((r) => r.startedAt).join(', ')}), ожидался 1 в ${show(spec)}`);
      const at = new RealDate(runs[0].startedAt).getTime();
      assert.ok(fits(at, spec, 61000), `вайп в ${runs[0].startedAt}, ожидалось ${show(spec)}`);
      const next = new RealDate((await env.profile()).nextRunAt).getTime();
      const nextSpec = allowed(y, mo, d + 7, hh, mm);
      assert.ok(fits(next, nextSpec, 0), `следующий запуск ${iso(next)}, ожидалось ${show(nextSpec)}`);
    });
  }
}

for (const [y, mo, d, label] of SUNDAYS) {
  test(`каждые 1 дн. 05:00 с якорем: суббота–понедельник вокруг ${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')} (${label}) — каждый день в 05:00`, async () => {
    const anchor = local(y, mo, d - 2);
    const anchorText = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`;
    const env = await profileAt(local(y, mo, d - 2, 12, 0), { kind: 'interval', intervalDays: 1, time: '05:00', anchorDate: anchorText });
    for (let i = 0; i < 3; i += 1) await jumpToNextRun(env);
    const runs = await env.runs();
    assert.equal(runs.length, 3, `прогонов: ${runs.length}`);
    runs.forEach((run, i) => {
      const spec = allowed(y, mo, d - 1 + i, 5, 0);
      assert.ok(fits(new RealDate(run.startedAt).getTime(), spec, 61000), `прогон ${i + 1}: ${run.startedAt}, ожидалось ${show(spec)}`);
    });
  });
}

const MONTHLY = [
  [2026, 3, 8, { kind: 'monthly_nth_weekday', nth: 2, weekday: 0 }, 'второе воскресенье марта'],
  [2026, 11, 1, { kind: 'monthly_nth_weekday', nth: 1, weekday: 0 }, 'первое воскресенье ноября'],
  [2026, 3, 29, { kind: 'monthly_nth_weekday', nth: -1, weekday: 0 }, 'последнее воскресенье марта'],
  [2026, 10, 25, { kind: 'monthly_nth_weekday', nth: -1, weekday: 0 }, 'последнее воскресенье октября'],
  [2026, 3, 8, { kind: 'monthly_day', day: 8 }, '8-е число'],
  [2026, 11, 1, { kind: 'monthly_day', day: 1 }, '1-е число'],
  [2026, 3, 29, { kind: 'monthly_day', day: 29 }, '29-е число'],
  [2026, 10, 25, { kind: 'monthly_day', day: 25 }, '25-е число'],
];
for (const [y, mo, d, schedule, label] of MONTHLY) {
  for (const time of ['02:30', '05:00']) {
    test(`ежемесячно (${label}) ${time}: nextRunAt — в нужный момент дня перехода`, async () => {
      const [hh, mm] = time.split(':').map(Number);
      const env = await profileAt(local(y, mo, d, 0, 0) - 3 * 86400000, { ...schedule, time });
      const next = new RealDate((await env.profile()).nextRunAt).getTime();
      const spec = allowed(y, mo, d, hh, mm);
      assert.ok(fits(next, spec, 0), `nextRunAt ${iso(next)}, ожидалось ${show(spec)}`);
    });
  }
}

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
