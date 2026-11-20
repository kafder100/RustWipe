/**
 * Ревью RustWipe, гипотеза 13 (раздел 4.2), утверждение H13g:
 * вкладка переводит все времена (следующий запуск, последний запуск, история
 * прогонов) одним смещением пояса панели «на сейчас» (status.clock.offsetMinutes).
 * Если между «сейчас» и показываемым моментом был переход на летнее/зимнее время,
 * вкладка показывает время на час не то.
 *
 * Правильное поведение (README и подпись поля «Время (часовой пояс панели)»): вайп
 * «воскресенье 05:00» во вкладке показан как 05:00 — и до перехода, и после.
 *
 * Как проверяется: настоящий backend (роуты плагина на подменах контекста) и
 * настоящий frontend.mjs, отрисованный в маленькой подмене DOM; fetch вкладки
 * уходит прямо в обработчики роутов. Смотрится текст, который видит человек.
 *
 * Запуск: node tools/review/h13g-ui-dst-offset.test.mjs
 * Файл сам перезапускает себя дочерними процессами с TZ=UTC, Europe/Moscow,
 * America/New_York и Europe/Berlin. Часы поддельные, файлов и сети нет.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ZONES = ['UTC', 'Europe/Moscow', 'America/New_York', 'Europe/Berlin'];
const BACKEND = new URL('../../rust-autowipe/backend/index.js', import.meta.url).href;
const FRONTEND = new URL('../../rust-autowipe/frontend/frontend.mjs', import.meta.url).href;

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

// ── Маленькая подмена DOM: только то, чем пользуется frontend.mjs ───────────
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.className = '';
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get isConnected() {
    return true;
  }
  get classList() {
    const node = this;
    const list = () => node.className.split(/\s+/).filter(Boolean);
    return {
      add: (...names) => {
        node.className = [...new Set([...list(), ...names])].join(' ');
      },
      remove: (...names) => {
        node.className = list().filter((n) => !names.includes(n)).join(' ');
      },
      contains: (name) => list().includes(name),
    };
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  addEventListener() {}
  focus() {}
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new FakeText(value));
  }
  set innerHTML(value) {
    this.textContent = value;
  }
  querySelector(selector) {
    const match = /^\[([\w-]+)\]$/.exec(selector);
    if (!match) throw new Error(`подмена DOM не знает селектор ${selector}`);
    return findAll(this, (n) => n !== this && n.attributes && match[1] in n.attributes)[0] ?? null;
  }
}
class FakeText extends FakeNode {
  constructor(text) {
    super('#text');
    this.data = String(text);
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = String(value);
  }
}
function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes || []) findAll(child, predicate, out);
  return out;
}
function installDom() {
  const head = new FakeNode('head');
  globalThis.Node = FakeNode;
  globalThis.document = {
    documentElement: new FakeNode('html'),
    head,
    body: new FakeNode('body'),
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => new FakeText(text),
    getElementById: (id) => findAll(head, (n) => n.id === id)[0] ?? null,
  };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }), prompt: () => null };
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(20, 20, 20)', colorScheme: 'dark' });
  globalThis.setInterval = () => 0; // часы вкладки обновляются раз в 15 с — в тесте не нужны
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

function makeReply() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      return payload;
    },
  };
}

async function callRoute(routes, method, url, { params = {}, query = {}, body, headers = {} } = {}) {
  const route = routes.find((r) => r.method === method && r.url === url);
  if (!route) throw new Error(`нет роута ${method} ${url}`);
  const reply = makeReply();
  const result = await route.handler({ params, query, body, headers, url }, reply);
  return { status: reply.statusCode, body: result };
}

/** fetch вкладки → обработчики роутов плагина (как панель под /api/plugins/rust-autowipe). */
function tabFetch(routes, counter) {
  const prefix = '/api/plugins/rust-autowipe';
  return async (input, options = {}) => {
    counter.calls += 1;
    const url = new URL(String(input), 'http://panel.local');
    if (!url.pathname.startsWith(prefix)) throw new Error(`вкладка обратилась не к плагину: ${input}`);
    const path = url.pathname.slice(prefix.length);
    const method = options.method || 'GET';
    for (const route of routes) {
      if (route.method !== method) continue;
      const a = route.url.split('/');
      const b = path.split('/');
      if (a.length !== b.length) continue;
      const params = {};
      let ok = true;
      a.forEach((part, i) => {
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(b[i]);
        else if (part !== b[i]) ok = false;
      });
      if (!ok) continue;
      const reply = makeReply();
      const body = options.body ? JSON.parse(options.body) : undefined;
      const result = await route.handler({ params, query: Object.fromEntries(url.searchParams), body, headers: {}, url: path }, reply);
      return { ok: reply.statusCode < 400, status: reply.statusCode, json: async () => structuredClone(result) };
    }
    return { ok: false, status: 404, json: async () => ({ success: false, error: `нет роута ${method} ${path}` }) };
  };
}

// ── Помощники сценариев ─────────────────────────────────────────────────────
let plugin;
let runTick;
let frontend;

async function freshPlugin() {
  const env = makeCtx();
  await plugin.onLoad(env.ctx);
  globalThis.fetch = async (url) => {
    throw new Error(`сеть в тесте запрещена: ${url}`);
  };
  return env;
}

async function createSunday0500(env) {
  const created = await callRoute(env.routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: {
      name: 'Воскресенье',
      targets: ['/server/rust/*.sav'],
      schedule: { kind: 'weekly', weekday: 0, time: '05:00' },
      options: { dryRun: true, warnChat: false },
    },
  });
  assert.equal(created.status, 200, `профиль не создан: ${JSON.stringify(created.body)}`);
  return created.body.data.id;
}

/** Монтирует вкладку сервера srv1 и ждёт, пока она загрузит данные (без таймеров). */
async function renderTab(env) {
  const counter = { calls: 0 };
  globalThis.fetch = tabFetch(env.routes, counter);
  const tab = frontend.tabs.find((t) => t.location === 'server') ?? frontend.tabs[0];
  const element = tab.component({ serverId: 'srv1' });
  const root = new FakeNode('div');
  (element.props?.ref ?? element.ref)(root);
  for (let i = 0; i < 1000 && counter.calls < 4; i += 1) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
  globalThis.fetch = async (url) => {
    throw new Error(`сеть в тесте запрещена: ${url}`);
  };
  return root;
}

const line = (root, startsWith) =>
  findAll(root, (n) => n.tagName === 'SPAN' && n.textContent.trim().startsWith(startsWith))[0]?.textContent.trim();
const WRONG_HOUR = /\b0[46]:00\b/;

const SUNDAYS = [
  [2026, 3, 8, 'весенний переход в New York'],
  [2026, 11, 1, 'осенний переход в New York'],
  [2026, 3, 29, 'весенний переход в Европе'],
  [2026, 10, 25, 'осенний переход в Европе'],
];
const dd = (d, mo) => `${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}`;

// ── Проверки ────────────────────────────────────────────────────────────────
for (const [y, mo, d, label] of SUNDAYS) {
  test(`за 4 дня до ${dd(d, mo)} (${label}): «Следующий запуск» показан как 05:00`, async () => {
    const env = await freshPlugin();
    setNow(local(y, mo, d - 4, 12, 0));
    await createSunday0500(env);
    const root = await renderTab(env);
    const text = line(root, 'Следующий запуск');
    assert.ok(text, 'в карточке профиля не нашлась строка «Следующий запуск»');
    assert.ok(text.includes('05:00') && !WRONG_HOUR.test(text), `вкладка показывает «${text}», а вайп назначен на 05:00 по часам панели`);
  });

  test(`через 3 дня после ${dd(d, mo)} (${label}): прошлый вайп 05:00 показан как 05:00 в карточке и истории`, async () => {
    const env = await freshPlugin();
    setNow(local(y, mo, d - 8, 12, 0));
    const id = await createSunday0500(env);
    const { nextRunAt } = await env.ctx.collection('profiles').findOne({ id });
    setNow(new RealDate(nextRunAt).getTime() + 40); // вайп за неделю до перехода, 05:00
    await runTick(env.ctx);
    assert.equal((await env.ctx.collection('runs').find({ profileId: id })).length, 1, 'предусловие: плановый прогон прошёл');
    setNow(local(y, mo, d + 3, 12, 0));
    const root = await renderTab(env);
    // Профиль в режиме проверки: итог проверки показывается своей строкой «Проверка: …»,
    // а «Последний: …» — только у настоящего вайпа (договорённость К4). Проверяем время.
    const last = line(root, 'Последний:') || line(root, 'Проверка:');
    assert.ok(last, 'в карточке профиля не нашлась строка «Последний:» или «Проверка:»');
    const rows = findAll(root, (n) => n.tagName === 'TR' && n.parentNode?.tagName === 'TBODY').map((n) => n.textContent);
    assert.equal(rows.length, 1, `в истории ${rows.length} строк, ожидалась 1`);
    const bad = [last, rows[0]].filter((t) => !t.includes('05:00') || WRONG_HOUR.test(t));
    assert.equal(bad.length, 0, `вкладка показывает «${last}» и в истории «${rows[0].slice(0, 16)}…», а вайп был в 05:00 по часам панели`);
  });
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
  installDom();
  ({ default: plugin, runTick } = await import(BACKEND));
  ({ default: frontend } = await import(FRONTEND));
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
      for (const l of text.split('\n').filter((s) => s.trim())) console.log(`        ${l}`);
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
