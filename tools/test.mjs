/**
 * Локальные тесты логики плагина (без панели).
 * Запуск: node tools/test.mjs
 */

import assert from 'node:assert/strict';

import {
  describeSchedule,
  nextOccurrence,
  normalizeSchedule,
  parseTime,
} from '../rust-autowipe/backend/lib/schedule.js';
import {
  isExcluded,
  matchPath,
  normalizePath,
  pathDepth,
  segmentMatcher,
} from '../rust-autowipe/backend/lib/glob.js';
import { expandTargets } from '../rust-autowipe/backend/lib/glob-walk.js';
import { executeProfileRun } from '../rust-autowipe/backend/lib/wipe.js';
import { formatWarning, warningPlan } from '../rust-autowipe/backend/lib/warnings.js';
import plugin, { runTick } from '../rust-autowipe/backend/index.js';
import { PRESETS } from '../rust-autowipe/backend/lib/presets.js';

// Упавшая проверка не останавливает прогон: остальные идут дальше, а в конце
// печатается итог со списком упавших и код выхода 1.
let passed = 0;
const failed = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      failed.push(name);
      console.error(`FAIL  ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

function localDate(y, mo, d, h = 0, mi = 0) {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function fmt(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ── Расписание ────────────────────────────────────────────────────────────
await test('parseTime валидирует время', () => {
  assert.deepEqual(parseTime('5:07'), { h: 5, m: 7 });
  assert.deepEqual(parseTime('05:07'), { h: 5, m: 7 });
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('5:7'), null);
  assert.equal(parseTime(''), null);
});

await test('normalizeSchedule приводит мусор к валидным значениям', () => {
  const s = normalizeSchedule({ kind: 'monthly_nth_weekday', nth: '9', weekday: 42, time: '7:5' });
  assert.equal(s.kind, 'monthly_nth_weekday');
  assert.equal(s.weekday, 6);
  assert.equal(s.nth, 1);
  assert.equal(s.time, '05:00');
});

await test('еженедельно: четверг 05:00', () => {
  const s = normalizeSchedule({ kind: 'weekly', weekday: 4, time: '05:00' });
  // 2026-11-15 — воскресенье
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 15, 12, 0))), '2026-11-19 05:00');
  // в четверг до времени — тот же день
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 19, 4, 0))), '2026-11-19 05:00');
  // в четверг после времени — следующий четверг
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 19, 6, 0))), '2026-11-26 05:00');
});

await test('первый четверг месяца (вайп Rust)', () => {
  const s = normalizeSchedule({
    kind: 'monthly_nth_weekday',
    nth: 1,
    weekday: 4,
    time: '19:00',
  });
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 15, 12, 0))), '2026-12-03 19:00');
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 12, 3, 20, 0))), '2027-01-07 19:00');
});

await test('последняя пятница месяца', () => {
  const s = normalizeSchedule({
    kind: 'monthly_nth_weekday',
    nth: -1,
    weekday: 5,
    time: '03:30',
  });
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 1, 0, 0))), '2026-11-27 03:30');
});

await test('31-е число в коротком месяце поджимается', () => {
  const s = normalizeSchedule({ kind: 'monthly_day', day: 31, time: '06:00' });
  assert.equal(fmt(nextOccurrence(s, localDate(2027, 2, 1, 0, 0))), '2027-02-28 06:00');
});

await test('интервал 7 дней от якоря', () => {
  const s = normalizeSchedule({
    kind: 'interval',
    intervalDays: 7,
    time: '05:00',
    anchorDate: '2026-11-01',
  });
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 15, 12, 0))), '2026-11-22 05:00');
  assert.equal(fmt(nextOccurrence(s, localDate(2026, 11, 22, 5, 30))), '2026-11-29 05:00');
});

await test('describeSchedule не падает на пустом', () => {
  assert.equal(describeSchedule(normalizeSchedule({})).length > 0, true);
  assert.equal(describeSchedule(null), '—');
});

// ── Glob ──────────────────────────────────────────────────────────────────
await test('normalizePath схлопывает и защищает от ..', () => {
  assert.equal(normalizePath('server//rust/'), '/server/rust');
  assert.equal(normalizePath('/server/./rust'), '/server/rust');
  assert.equal(normalizePath('/server/../etc'), null);
  assert.equal(normalizePath(''), null);
});

await test('segmentMatcher и matchPath', () => {
  assert.equal(segmentMatcher('*.sav').test('proceduralmap.4500.123.7.sav'), true);
  assert.equal(segmentMatcher('*.sav').test('proceduralmap.map'), false);
  assert.equal(matchPath('/server/*/proceduralmap.*.sav', '/server/rust/proceduralmap.1.2.3.sav'), true);
  assert.equal(matchPath('/server/*/cfg', '/server/rust/cfg'), true);
  assert.equal(matchPath('/server/**/cfg', '/server/a/b/c/cfg'), true);
  assert.equal(matchPath('/server/*', '/server/rust/cfg'), false);
  assert.equal(pathDepth('/server/rust/cfg'), 3);
});

await test('isExcluded закрывает поддерево', () => {
  assert.equal(isExcluded(['/server/*/cfg'], '/server/rust/cfg/server.cfg'), true);
  assert.equal(isExcluded(['/server/*/cfg'], '/server/rust/sv.db'), false);
  assert.equal(isExcluded(['/oxide/**'], '/oxide/data/Kits.json'), true);
});

// ── Раскрытие путей через фейковый туннель ────────────────────────────────
const TREE = {
  '/': [
    { name: 'server', isDirectory: true },
    { name: 'oxide', isDirectory: true },
    { name: 'start.sh', isDirectory: false },
  ],
  '/server': [{ name: 'rust', isDirectory: true }],
  '/server/rust': [
    { name: 'proceduralmap.4500.123.7.map', isDirectory: false },
    { name: 'proceduralmap.4500.123.7.sav', isDirectory: false },
    { name: 'player.blueprints.7656119.db', isDirectory: false },
    { name: 'player.deaths.7656119.db', isDirectory: false },
    { name: 'sv.db', isDirectory: false },
    { name: 'cfg', isDirectory: true },
  ],
  '/server/rust/cfg': [{ name: 'server.cfg', isDirectory: false }],
  '/oxide': [{ name: 'data', isDirectory: true }],
  '/oxide/data': [
    { name: 'Kits.json', isDirectory: false },
    { name: 'ZoneManager.json', isDirectory: false },
  ],
};

function makeTunnel(tree = TREE, { failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async queueRequest(nodeId, operation, uuid, path) {
      calls.push({ nodeId, operation, uuid, path });
      if (operation === 'list') {
        if (failOn && failOn(path)) return { success: false, error: 'Permission denied' };
        const entries = tree[path];
        if (!entries) return { success: false, error: `Path not found: ${path}` };
        return {
          success: true,
          data: entries.map((e) => ({
            name: e.name,
            size: 10,
            isDirectory: e.isDirectory,
            modified: '2026-01-01T00:00:00Z',
          })),
        };
      }
      if (operation === 'delete') {
        return { success: true };
      }
      return { success: false, error: `unknown op ${operation}` };
    },
  };
}

function makeContext({
  tunnel,
  config = {},
  servers = [],
  userId = 'user_owner',
  perms = ['*'],
} = {}) {
  const stores = new Map();
  const routes = [];
  const tasks = [];
  const events = [];
  const collection = (name) => {
    if (!stores.has(name)) stores.set(name, []);
    const docs = stores.get(name);
    const matches = (doc, filter) =>
      Object.entries(filter || {}).every(([key, value]) => doc[key] === value);
    return {
      docs,
      async find(filter = {}, options = {}) {
        let out = docs.filter((doc) => matches(doc, filter));
        if (options.sort) {
          const [key, dir] = Object.entries(options.sort)[0];
          out = [...out].sort((a, b) =>
            String(a[key]).localeCompare(String(b[key])) * (dir === -1 ? -1 : 1),
          );
        }
        if (options.limit) out = out.slice(0, options.limit);
        return out.map((doc) => ({ ...doc }));
      },
      async findOne(filter) {
        const doc = docs.find((item) => matches(item, filter));
        return doc ? { ...doc } : null;
      },
      async insert(doc) {
        const withId = { _id: `doc${docs.length + 1}`, ...doc };
        docs.push(withId);
        return withId;
      },
      async update(filter, update) {
        let count = 0;
        for (const doc of docs) {
          if (!matches(doc, filter)) continue;
          for (const [key, value] of Object.entries(update.$set || {})) doc[key] = value;
          count += 1;
        }
        return count;
      },
      async delete(filter) {
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i -= 1) {
          if (matches(docs[i], filter)) docs.splice(i, 1);
        }
        return before - docs.length;
      },
      async count(filter) {
        return docs.filter((doc) => matches(doc, filter)).length;
      },
    };
  };

  const ctx = {
    manifest: { name: 'rust-autowipe', version: '1.1.0' },
    originalConfig: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    getConfig: (key) => (key in config ? config[key] : undefined),
    setConfig: async () => {},
    getStorage: async () => null,
    setStorage: async () => {},
    deleteStorage: async () => {},
    collection,
    db: {
      servers: {
        async findUnique({ where }) {
          return servers.find((s) => s.id === where.id) || null;
        },
        async findMany() {
          return servers;
        },
        async count() {
          return servers.length;
        },
        async update() {
          return null;
        },
      },
      users: {},
      pluginStorage: {},
      plugin: {},
    },
    registerRoute: (route) => routes.push(route),
    registerMiddleware: () => {},
    onWebSocketMessage: () => {},
    sendWebSocketMessage: () => {},
    scheduleTask: (cron, handler) => tasks.push({ cron, handler }),
    on: () => {},
    emit: (event, data) => events.push({ event, data }),
    emitTyped: (event, data) => events.push({ event, data }),
    exposeApi: () => {},
    callPluginApi: async () => null,
    fileTunnel: tunnel,
    requirePermission: () => async () => {},
    getUserId: () => userId,
    hasPermission: (_request, token) => perms.includes('*') || perms.includes(token),
  };
  return { ctx, stores, routes, tasks, events };
}

/** Поддельный Fastify-reply: запоминает код и тело. */
function makeReply() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

function routeOf(routes, method, url) {
  return routes.find((route) => route.method === method && route.url === url) || null;
}

async function callRoute(routes, method, url, { params = {}, query = {}, body, headers = {} } = {}) {
  const route = routeOf(routes, method, url);
  assert.ok(route, `нет роута ${method} ${url}`);
  const reply = makeReply();
  const result = await route.handler({ params, query, body, headers }, reply);
  return { result, reply };
}

await test('expandTargets раскрывает маски и учитывает exclude', async () => {
  const tunnel = makeTunnel();
  const { ctx } = makeContext({ tunnel });
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust', status: 'stopped' };
  const result = await expandTargets(
    ctx,
    server,
    ['/server/*/proceduralmap.*.sav', '/server/*/proceduralmap.*.map', '/server/*'],
    ['/server/*/cfg'],
  );
  assert.deepEqual(result.paths, [
    '/server/rust/player.blueprints.7656119.db',
    '/server/rust/player.deaths.7656119.db',
    '/server/rust/proceduralmap.4500.123.7.map',
    '/server/rust/proceduralmap.4500.123.7.sav',
    '/server/rust/sv.db',
  ]);
  assert.equal(result.truncated, false);
});

await test('expandTargets уважает literal-пути и ** ', async () => {
  const { ctx } = makeContext({ tunnel: makeTunnel() });
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1' };
  const literal = await expandTargets(ctx, server, ['/oxide/data']);
  assert.deepEqual(literal.paths, ['/oxide/data']);

  // Без исключений каталог схлопывается: удалять /oxide целиком достаточно.
  const deep = await expandTargets(ctx, server, ['/oxide/**']);
  assert.deepEqual(deep.paths, ['/oxide']);
});

await test('пресеты ссылаются на существующие по смыслу пути', () => {
  assert.equal(PRESETS.length >= 4, true);
  const full = PRESETS.find((p) => p.id === 'rust-full');
  assert.deepEqual(full.targets, ['/server/*']);
  assert.deepEqual(full.excludes, ['/server/*/cfg']);
});

await test('валидация профиля запрещает снос корня сервера', async () => {
  const { ctx } = makeContext({
    tunnel: makeTunnel(),
    servers: [{ id: 'srv1', uuid: 'uuid-1', nodeId: 'node-1', name: 'Rust', status: 'stopped' }],
  });
  const { buildProfile } = await import('../rust-autowipe/backend/lib/store.js');

  const root = await buildProfile(ctx, { name: 'x', serverId: 'srv1', targets: ['/*'] });
  assert.equal(root.errors.some((error) => error.includes('корня')), true);

  const ok = await buildProfile(ctx, {
    name: 'x',
    serverId: 'srv1',
    targets: ['/server/*'],
    schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.profile.targets[0], '/server/*');
});

// ── Прогон вайпа (dry-run) ────────────────────────────────────────────────
function profileFixture(serverId = 'srv1', overrides = {}) {
  return {
    id: 'wipe_1',
    name: 'Тест',
    serverId,
    serverName: 'Rust #1',
    targets: ['/server/*/proceduralmap.*.sav'],
    excludes: [],
    options: { stopServer: true, startServer: true, dryRun: true, commandsAfter: [] },
    schedule: normalizeSchedule({ kind: 'weekly', weekday: 4, time: '05:00' }),
    enabled: true,
    ...overrides,
  };
}

await test('dry-run ничего не удаляет и не трогает power-роуты', async () => {
  const tunnel = makeTunnel();
  const { ctx, stores } = makeContext({
    tunnel,
    config: { apiKey: '' },
    servers: [{ id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust #1', status: 'running' }],
  });
  stores.set('profiles', []);
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };

  const run = await executeProfileRun(ctx, profileFixture(), { trigger: 'manual' });
  assert.equal(run.ok, true);
  assert.equal(run.dryRun, true);
  assert.deepEqual(run.deleted, ['/server/rust/proceduralmap.4500.123.7.sav']);
  assert.equal(fetchCalls.length, 0);
  assert.equal(tunnel.calls.filter((c) => c.operation === 'delete').length, 0);
  assert.equal(stores.get('runs').length, 1);
  assert.equal(stores.get('runs')[0].ok, true);
});

await test('полный вайп: stop → delete → start через REST панели', async () => {
  const tunnel = makeTunnel();
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust #1', status: 'running' };
  const { ctx, stores } = makeContext({
    tunnel,
    config: { apiKey: 'test-key', panelUrl: 'https://panel.test' },
    servers: [server],
  });
  stores.set('profiles', [profileFixture('srv1', { options: { stopServer: true, startServer: true, dryRun: false } })]);
  stores.set('runs', []);

  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), method: options?.method, auth: options?.headers?.authorization });
    if (String(url).endsWith('/stop')) {
      server.status = 'stopped';
    } else if (String(url).endsWith('/start')) {
      server.status = 'running';
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };

  const profile = stores.get('profiles')[0];
  const run = await executeProfileRun(ctx, profile, { trigger: 'manual' });

  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.equal(server.status, 'running');
  assert.equal(fetchCalls.length, 2);
  assert.ok(fetchCalls[0].url.endsWith('/api/servers/srv1/stop'));
  assert.ok(fetchCalls[1].url.endsWith('/api/servers/srv1/start'));
  assert.equal(fetchCalls[0].auth, 'Bearer test-key');
  assert.deepEqual(
    tunnel.calls.filter((c) => c.operation === 'delete').map((c) => c.path),
    ['/server/rust/proceduralmap.4500.123.7.sav'],
  );
  assert.equal(stores.get('runs')[0].ok, true);
  assert.equal(stores.get('profiles')[0].lastRunStatus, 'ok');
});

await test('ошибка удаления не мешает поднять сервер обратно', async () => {
  const tunnel = makeTunnel();
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust #1', status: 'stopped' };
  const { ctx, stores } = makeContext({
    tunnel,
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
  });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/start')) server.status = 'running';
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  const failingTunnel = {
    async queueRequest(nodeId, operation, uuid, path) {
      if (operation === 'list') return makeTunnel().queueRequest(nodeId, operation, uuid, path);
      return { success: false, error: 'Permission denied: files.write' };
    },
  };
  ctx.fileTunnel = failingTunnel;

  const run = await executeProfileRun(
    ctx,
    profileFixture('srv1', { options: { stopServer: true, startServer: true, dryRun: false } }),
    { trigger: 'manual' },
  );
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((e) => e.includes('Permission denied')));
  assert.equal(server.status, 'running');
  assert.ok(run.steps.some((s) => s.action === 'start' && s.ok));
});

await test('нет API-ключа → внятная ошибка и ничего не удалено', async () => {
  const tunnel = makeTunnel();
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust #1', status: 'running' };
  const { ctx } = makeContext({ tunnel, config: {}, servers: [server] });
  const run = await executeProfileRun(ctx, profileFixture('srv1', {
    options: { stopServer: true, startServer: true, dryRun: false },
  }));
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((e) => e.includes('API-ключ')));
  assert.equal(tunnel.calls.filter((c) => c.operation === 'delete').length, 0);
});

await test('пустое раскрытие — ошибка, но остановленный сервер поднят обратно', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust #1', status: 'running' };
  const tunnel = {
    async queueRequest() {
      return { success: true, data: [] };
    },
  };
  const { ctx } = makeContext({ tunnel, config: { apiKey: 'k', panelUrl: 'https://panel.test' }, servers: [server] });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/stop')) server.status = 'stopped';
    if (String(url).endsWith('/start')) server.status = 'running';
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };
  const run = await executeProfileRun(ctx, profileFixture('srv1', {
    targets: ['/server/*/nope.*'],
    options: { stopServer: true, startServer: true, dryRun: false },
  }));
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((e) => e.includes('Ни один путь не найден')));
  assert.equal(server.status, 'running');
  assert.ok(run.steps.some((s) => s.action === 'restore-start' && s.ok));
});

// ── Плагин целиком ────────────────────────────────────────────────────────
await test('onLoad регистрирует только серверные роуты, onEnable — планировщик', async () => {
  const { ctx, routes, tasks } = makeContext({
    tunnel: makeTunnel(),
    config: { schedulerEnabled: true },
    servers: [{ id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'user_owner', name: 'Rust', status: 'stopped' }],
  });
  await plugin.onLoad(ctx);
  await plugin.onEnable(ctx);

  const urls = routes.map((r) => `${r.method} ${r.url}`);
  for (const expected of [
    'GET /presets',
    'GET /servers/:serverId/status',
    'POST /servers/:serverId/panel-check',
    'GET /servers/:serverId/files',
    'GET /servers/:serverId/profiles',
    'POST /servers/:serverId/profiles',
    'PUT /servers/:serverId/profiles/:profileId',
    'DELETE /servers/:serverId/profiles/:profileId',
    'POST /servers/:serverId/profiles/:profileId/run',
    'POST /servers/:serverId/profiles/:profileId/preview',
    'GET /servers/:serverId/runs',
  ]) {
    assert.ok(urls.includes(expected), `нет роута ${expected}: ${urls.join(', ')}`);
  }
  // Никаких панельных роутов: всё, кроме справочника пресетов, привязано к серверу.
  for (const url of urls) {
    if (url === 'GET /presets') continue;
    assert.ok(url.includes('/servers/:serverId/'), `роут вне сервера: ${url}`);
  }
  assert.equal(routes.every((r) => !r.config?.requiredPermissions), true);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].cron, '* * * * *');
});

// Владелец отвечал: вайп запускают админы и владельцы серверов. Поэтому
// владельцу своего сервера роль плагина не нужна, а чужому человеку без роли
// по-прежнему ничего нельзя менять.
await test('владелец сервера без роли плагина меняет профили и запускает вайп', async () => {
  const server = { id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'owner_1', name: 'Rust', status: 'stopped' };
  const { ctx, routes } = makeContext({
    tunnel: makeTunnel(),
    servers: [server],
    userId: 'owner_1',
    perms: [],
  });
  await plugin.onLoad(ctx);

  const status = await callRoute(routes, 'GET', '/servers/:serverId/status', {
    params: { serverId: 'srv1' },
  });
  assert.equal(status.result.success, true);
  assert.equal(status.result.data.server.id, 'srv1');
  assert.equal(status.result.data.permissions.canManage, true);
  assert.equal(status.result.data.permissions.canRun, true);

  const create = await callRoute(routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: { name: 'x', targets: ['/server/*'] },
  });
  assert.equal(create.reply.statusCode, 200);
  assert.equal(create.result.success, true);
});

await test('не владелец и не админ без роли плагина менять профили не может', async () => {
  const server = { id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'owner_1', name: 'Rust', status: 'stopped' };
  const { ctx, routes } = makeContext({
    tunnel: makeTunnel(),
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
    userId: 'sub_1',
    perms: [],
  });
  await plugin.onLoad(ctx);
  // Субпользователь с правом server.read на этом сервере: вкладку видит, но без роли не меняет.
  globalThis.fetch = async (url) => {
    const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) });
    if (String(url).endsWith('/api/servers/srv1/permissions')) return json([{ userId: 'sub_1', permissions: ['server.read'] }]);
    if (String(url).endsWith('/api/servers/srv1')) return json({ id: 'srv1', template: { name: 'Rust' } });
    return { ok: false, status: 404, text: async () => '' };
  };

  const create = await callRoute(routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: { name: 'x', targets: ['/server/*'] },
  });
  assert.equal(create.reply.statusCode, 403);
  assert.match(create.result.error, /rust-autowipe\.manage/);
});

await test('чужой сервер недоступен, даже с ролью manage', async () => {
  const server = { id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'owner_1', name: 'Rust', status: 'stopped' };
  const { ctx, routes } = makeContext({
    tunnel: makeTunnel(),
    servers: [server],
    userId: 'stranger',
    perms: ['rust-autowipe.manage', 'rust-autowipe.run', 'rust-autowipe.view'],
  });
  await plugin.onLoad(ctx);

  const status = await callRoute(routes, 'GET', '/servers/:serverId/status', {
    params: { serverId: 'srv1' },
  });
  assert.equal(status.reply.statusCode, 403);
  assert.match(status.result.error, /Нет доступа/);
});

await test('админ панели проходит к любому серверу', async () => {
  const server = { id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'owner_1', name: 'Rust', status: 'stopped' };
  const { ctx, routes } = makeContext({
    tunnel: makeTunnel(),
    servers: [server],
    userId: 'admin_1',
    perms: ['admin.write'],
  });
  await plugin.onLoad(ctx);

  const status = await callRoute(routes, 'GET', '/servers/:serverId/status', {
    params: { serverId: 'srv1' },
  });
  assert.equal(status.result.success, true);
  assert.equal(status.result.data.server.id, 'srv1');
});

// Субпользователя плагин ищет в списке доступа сервера, который читает своим
// API-ключом. Cookie пользователя никуда не пересылаются: раньше ответ «сервер
// виден» по его cookie пропускал и человека с глобальным server.read.
await test('субпользователь проходит, если он есть в списке доступа сервера; cookie не пересылаются', async () => {
  const server = { id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'owner_1', name: 'Rust', status: 'stopped' };
  const { ctx, routes } = makeContext({
    tunnel: makeTunnel(),
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
    userId: 'sub_1',
    perms: [],
  });
  await plugin.onLoad(ctx);

  const calls = [];
  let accessList = [{ userId: 'sub_1', permissions: ['server.read'] }];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), cookie: options?.headers?.cookie, auth: options?.headers?.authorization });
    const json = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) });
    if (String(url).endsWith('/api/servers/srv1/permissions')) return json(accessList);
    if (String(url).endsWith('/api/servers/srv1')) return json({ id: 'srv1', template: { name: 'Rust' } });
    return { ok: false, status: 404, text: async () => '' };
  };

  const status = await callRoute(routes, 'GET', '/servers/:serverId/status', {
    params: { serverId: 'srv1' },
    headers: { cookie: 'session=abc' },
  });
  assert.equal(status.result.success, true);
  assert.ok(calls.some((call) => call.url.endsWith('/api/servers/srv1/permissions')));
  assert.ok(calls.every((call) => call.cookie === undefined), 'cookie пользователя ушли в панель');
  assert.ok(calls.every((call) => call.auth === 'Bearer k'), 'запросы идут ключом плагина');

  // Нет в списке доступа — нет доступа, даже если cookie есть.
  accessList = [];
  const denied = await callRoute(routes, 'GET', '/servers/:serverId/status', {
    params: { serverId: 'srv1' },
    headers: { cookie: 'session=abc' },
  });
  assert.equal(denied.reply.statusCode, 403);
});

await test('профили изолированы по серверу', async () => {
  const srv1 = { id: 'srv1', uuid: 'u1', nodeId: 'n', ownerId: 'owner_1', name: 'Rust #1', status: 'stopped' };
  const srv2 = { id: 'srv2', uuid: 'u2', nodeId: 'n', ownerId: 'owner_1', name: 'Rust #2', status: 'stopped' };
  const { ctx, routes, stores } = makeContext({
    tunnel: makeTunnel(),
    servers: [srv1, srv2],
    userId: 'owner_1',
    perms: ['rust-autowipe.manage', 'rust-autowipe.view', 'rust-autowipe.run'],
  });
  await plugin.onLoad(ctx);
  stores.set('profiles', []);

  const created = await callRoute(routes, 'POST', '/servers/:serverId/profiles', {
    params: { serverId: 'srv1' },
    body: { name: 'Вайп #1', targets: ['/server/*'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  assert.equal(created.result.success, true);

  const list1 = await callRoute(routes, 'GET', '/servers/:serverId/profiles', { params: { serverId: 'srv1' } });
  assert.equal(list1.result.data.length, 1);
  assert.equal(list1.result.data[0].serverId, 'srv1');

  const list2 = await callRoute(routes, 'GET', '/servers/:serverId/profiles', { params: { serverId: 'srv2' } });
  assert.equal(list2.result.data.length, 0);

  // Профиль srv1 нельзя править через роут srv2.
  const profileId = created.result.data.id;
  const cross = await callRoute(routes, 'PUT', '/servers/:serverId/profiles/:profileId', {
    params: { serverId: 'srv2', profileId },
    body: { name: 'взлом', targets: ['/server/*'] },
  });
  assert.equal(cross.reply.statusCode, 404);

  // И нельзя поставить его в очередь через чужой сервер.
  const crossRun = await callRoute(routes, 'POST', '/servers/:serverId/profiles/:profileId/run', {
    params: { serverId: 'srv2', profileId },
  });
  assert.equal(crossRun.reply.statusCode, 404);
});

await test('планировщик запускает просроченный профиль и переносит nextRunAt', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust', status: 'stopped' };
  const tunnel = makeTunnel();
  const { ctx, stores } = makeContext({
    tunnel,
    // Предупреждения выключены: с ними пропущенный вайп догоняется не сразу,
    // а после отсчёта в чате (это проверяют тесты tools/review/).
    config: { apiKey: 'k', panelUrl: 'https://panel.test', catchUpMinutes: 120, wipeWarningEnabled: false },
    servers: [server],
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => ({ success: true }) });

  const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  stores.set('profiles', [
    {
      ...profileFixture('srv1', {
        options: { stopServer: false, startServer: false, dryRun: false },
      }),
      nextRunAt: past,
    },
  ]);
  stores.set('runs', []);

  await runTick(ctx);
  const profile = stores.get('profiles')[0];
  assert.equal(stores.get('runs').length, 1);
  assert.ok(new Date(profile.nextRunAt).getTime() > Date.now());
  assert.equal(profile.lastRunStatus, 'ok');
});

await test('слишком старый пропуск переносится без запуска', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', name: 'Rust', status: 'stopped' };
  const { ctx, stores } = makeContext({
    tunnel: makeTunnel(),
    config: { catchUpMinutes: 30 },
    servers: [server],
  });
  const stale = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  stores.set('profiles', [{ ...profileFixture('srv1'), nextRunAt: stale }]);
  stores.set('runs', []);

  await runTick(ctx);
  assert.equal(stores.get('runs').length, 0);
  assert.ok(stores.get('profiles')[0].lastSkippedAt);
});

// ── Сид и размер карты ────────────────────────────────────────────────────
await test('карта: нормализация, случайный сид, ротация и валидация', async () => {
  const mapgen = await import('../rust-autowipe/backend/lib/mapgen.js');

  const defaults = mapgen.normalizeMapSettings(null);
  assert.equal(defaults.seed.mode, 'random');
  assert.equal(defaults.size.mode, 'fixed');
  assert.equal(defaults.size.value, 3000);
  assert.equal(defaults.vars.seed, 'WORLD_SEED');
  assert.equal(defaults.vars.size, 'WORLD_SIZE');

  const legacy = mapgen.normalizeMapSettings(undefined, { legacy: true });
  assert.equal(legacy.seed.mode, 'keep');
  assert.equal(legacy.size.mode, 'keep');

  const rotate = mapgen.normalizeMapSettings({
    seed: { mode: 'rotate', values: [111, 222, 111, 'bad'] },
    size: { mode: 'random', values: [2000, 6000] },
  });
  assert.deepEqual(rotate.seed.values, [111, 222]);

  const first = mapgen.decideMapValues(rotate, { seedCursor: 0 });
  assert.equal(first.seed, 111);
  assert.equal(first.nextCursor, 1);
  const second = mapgen.decideMapValues(rotate, { seedCursor: first.nextCursor });
  assert.equal(second.seed, 222);
  assert.equal(second.nextCursor, 0);

  const random = mapgen.decideMapValues(
    mapgen.normalizeMapSettings({
      seed: { mode: 'random' },
      size: { mode: 'random', values: [2000] },
    }),
  );
  assert.ok(random.seed >= 1 && random.seed <= 2147483647);
  assert.equal(random.size, 2000);

  const keep = mapgen.decideMapValues(mapgen.normalizeMapSettings(undefined, { legacy: true }));
  assert.equal(keep.seed, null);
  assert.equal(keep.size, null);

  assert.ok(mapgen.validateMapInput({ seed: { mode: 'fixed', value: 0 } }).length > 0);
  assert.ok(mapgen.validateMapInput({ size: { mode: 'fixed', value: 9000 } }).length > 0);
  assert.ok(mapgen.validateMapInput({ seed: { mode: 'rotate', values: [] } }).length > 0);
  assert.ok(mapgen.validateMapInput({ size: { mode: 'random', values: [] } }).length > 0);
  assert.ok(mapgen.validateMapInput({ vars: { seed: '1BAD' } }).length > 0);
  assert.deepEqual(mapgen.validateMapInput({ seed: { mode: 'random' }, size: { mode: 'fixed', value: 3500 } }), []);
});

await test('карта: профиль не сохраняется с невалидным сидом', async () => {
  const { ctx } = makeContext({
    tunnel: makeTunnel(),
    servers: [{ id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'user_owner', name: 'Rust', status: 'stopped' }],
  });
  const { buildProfile } = await import('../rust-autowipe/backend/lib/store.js');
  const result = await buildProfile(ctx, {
    name: 'x',
    serverId: 'srv1',
    targets: ['/server/*'],
    map: { seed: { mode: 'fixed', value: 0 }, size: { mode: 'fixed', value: 3000 } },
  });
  assert.ok(result.errors.some((error) => error.includes('сид')));
});

await test('вайп: сид и размер уходят в переменные до удаления файлов', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', ownerId: 'user_owner', name: 'Rust #1', status: 'stopped' };
  const tunnel = makeTunnel();
  const { ctx, stores } = makeContext({
    tunnel,
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
  });
  stores.set('runs', []);
  stores.set('profiles', [
    profileFixture('srv1', {
      id: 'wipe_map',
      options: { stopServer: true, startServer: false, dryRun: false },
      map: {
        seed: { mode: 'fixed', value: 123456789 },
        size: { mode: 'fixed', value: 4000 },
        vars: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
      },
    }),
  ]);

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };

  const run = await executeProfileRun(ctx, stores.get('profiles')[0], { trigger: 'manual' });
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  assert.equal(run.seed, 123456789);
  assert.equal(run.size, 4000);

  const patch = calls.find((call) => call.url.endsWith('/variables') && call.method === 'PATCH');
  assert.ok(patch, 'не было PATCH /variables');
  assert.deepEqual(patch.body, { WORLD_SEED: '123456789', WORLD_SIZE: '4000' });
  assert.ok(tunnel.calls.some((call) => call.operation === 'delete'));
});

await test('вайп: ошибка записи переменных прерывает вайп и поднимает сервер', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', ownerId: 'user_owner', name: 'Rust #1', status: 'running' };
  const tunnel = makeTunnel();
  const { ctx, stores } = makeContext({
    tunnel,
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
  });
  stores.set('runs', []);
  stores.set('profiles', [
    profileFixture('srv1', {
      id: 'wipe_map_fail',
      options: { stopServer: true, startServer: true, dryRun: false },
      map: {
        seed: { mode: 'fixed', value: 42 },
        size: { mode: 'fixed', value: 3000 },
        vars: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
      },
    }),
  ]);

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/stop')) {
      server.status = 'stopped';
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
    }
    if (href.endsWith('/start')) {
      server.status = 'running';
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
    }
    if (href.endsWith('/variables') && options.method === 'PATCH') {
      return {
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({
            error: 'Validation failed',
            code: 'VALIDATION_ERROR',
            fields: { WORLD_SEED: 'between:1,2147483647' },
          }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };

  const run = await executeProfileRun(ctx, stores.get('profiles')[0], { trigger: 'manual' });
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('WORLD_SEED')));
  assert.equal(server.status, 'running', 'сервер должен быть поднят обратно');
  assert.equal(tunnel.calls.filter((call) => call.operation === 'delete').length, 0, 'файлы не должны удаляться');
  assert.ok(run.steps.some((step) => step.action === 'restore-start' && step.ok));
});

await test('вайп: ротация сида двигает курсор только после записи', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', ownerId: 'user_owner', name: 'Rust #1', status: 'stopped' };
  const { ctx, stores } = makeContext({
    tunnel: makeTunnel(),
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
  });
  stores.set('runs', []);
  stores.set('profiles', [
    profileFixture('srv1', {
      id: 'wipe_rotate',
      options: { stopServer: true, startServer: false, dryRun: false },
      map: {
        seed: { mode: 'rotate', values: [111, 222] },
        size: { mode: 'keep' },
        vars: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
      },
    }),
  ]);

  const patches = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/variables') && options.method === 'PATCH') {
      patches.push(JSON.parse(options.body));
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };

  const first = await executeProfileRun(ctx, stores.get('profiles')[0], { trigger: 'manual' });
  assert.equal(first.seed, 111);
  assert.equal(stores.get('profiles')[0].mapState.seedCursor, 1);

  const second = await executeProfileRun(ctx, stores.get('profiles')[0], { trigger: 'manual' });
  assert.equal(second.seed, 222);
  assert.equal(stores.get('profiles')[0].mapState.seedCursor, 0);

  const third = await executeProfileRun(ctx, stores.get('profiles')[0], { trigger: 'manual' });
  assert.equal(third.seed, 111);
  assert.deepEqual(patches.map((body) => body.WORLD_SEED), ['111', '222', '111']);
});

await test('dry-run не пишет переменные, но показывает план', async () => {
  const server = { id: 'srv1', uuid: 'uuid1', nodeId: 'node1', ownerId: 'user_owner', name: 'Rust #1', status: 'running' };
  const { ctx, stores } = makeContext({
    tunnel: makeTunnel(),
    config: { apiKey: 'k', panelUrl: 'https://panel.test' },
    servers: [server],
  });
  stores.set('runs', []);
  stores.set('profiles', [
    profileFixture('srv1', {
      id: 'wipe_dry_map',
      options: { stopServer: true, startServer: true, dryRun: true },
      map: {
        seed: { mode: 'fixed', value: 777 },
        size: { mode: 'fixed', value: 3500 },
        vars: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
      },
    }),
  ]);

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  };

  const run = await executeProfileRun(ctx, stores.get('profiles')[0], { trigger: 'manual' });
  assert.equal(run.ok, true);
  assert.equal(run.dryRun, true);
  assert.equal(run.seed, 777);
  assert.equal(run.size, 3500);
  assert.equal(calls.filter((call) => call.url.endsWith('/variables')).length, 0);
  assert.ok(run.steps.some((step) => step.action === 'map' && step.detail.includes('WORLD_SEED=777')));
});

await test('предупреждения: окно 5 минут, счёт минут и подстановка', () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  assert.equal(warningPlan(now, now + 5 * 60000, 5), 5);
  assert.equal(warningPlan(now, now + 4 * 60000 + 30000, 5), 5);
  assert.equal(warningPlan(now, now + 3 * 60000 + 1000, 5), 4);
  assert.equal(warningPlan(now, now + 30000, 5), 1);
  assert.equal(warningPlan(now, now + 6 * 60000, 5), null);
  assert.equal(warningPlan(now, now - 1000, 5), null);
  assert.equal(warningPlan(now, now + 60000, 0), null);
  assert.equal(formatWarning('Вайп через {minutes} мин', 3), 'Вайп через 3 мин');
  assert.equal(formatWarning('{minutes}/{minutes}', 2), '2/2');
});

if (failed.length) {
  console.error(`\nПроверок прошло: ${passed}, упало: ${failed.length}`);
  for (const name of failed) console.error(`  FAIL  ${name}`);
  process.exitCode = 1;
} else {
  console.log(`\nВсе проверки прошли: ${passed}`);
}
