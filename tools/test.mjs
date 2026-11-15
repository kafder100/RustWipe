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
import plugin, { runTick } from '../rust-autowipe/backend/index.js';
import { PRESETS } from '../rust-autowipe/backend/lib/presets.js';

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL  ${name}`);
      console.error(error);
      process.exitCode = 1;
      throw error;
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

await test('владелец сервера читает данные, но без роли не может менять', async () => {
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
  assert.equal(status.result.data.permissions.canManage, false);
  assert.equal(status.result.data.permissions.canRun, false);

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

await test('субпользователь проходит, если панель подтверждает доступ по cookie', async () => {
  const server = { id: 'srv1', uuid: 'u', nodeId: 'n', ownerId: 'owner_1', name: 'Rust', status: 'stopped' };
  const { ctx, routes } = makeContext({
    tunnel: makeTunnel(),
    servers: [server],
    userId: 'sub_1',
    perms: [],
  });
  await plugin.onLoad(ctx);

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), cookie: options?.headers?.cookie });
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const status = await callRoute(routes, 'GET', '/servers/:serverId/status', {
    params: { serverId: 'srv1' },
    headers: { cookie: 'session=abc' },
  });
  assert.equal(status.result.success, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/servers/srv1'));
  assert.equal(calls[0].cookie, 'session=abc');
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
    config: { apiKey: 'k', panelUrl: 'https://panel.test', catchUpMinutes: 120 },
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

if (process.exitCode) {
  console.error(`\n${passed} проверок прошло, есть ошибки`);
} else {
  console.log(`\nВсе проверки прошли: ${passed}`);
}
