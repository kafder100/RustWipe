/**
 * Исправление F2a: кто может работать с сервером через плагин.
 *
 * Правило (ответы владельца №2, №17, №19):
 *  - админ панели и владелец сервера — всё, без ролей плагина;
 *  - субпользователь — тот, кто есть в списке доступа сервера в панели
 *    (GET /api/servers/:id/permissions, читается ключом плагина) и у кого
 *    там есть server.read; изменения и запуск — с ролями плагина;
 *  - остальным — отказ. Ответ панели «сервер виден», страница входа с кодом
 *    200 и переход (302) доступом не считаются; cookie и ключи пользователя
 *    плагин никуда не пересылает.
 *
 * Закрывает: L31-9 (владелец без роли), L32-7 (просмотр без server.read,
 * файлы без роли), H9d по сути (отказы панели: 403, HTML 200, 302 — здесь,
 * а не в tools/test.mjs), L34-8 (таблица «роут → право» без побочных действий).
 *
 * Запуск: node tools/review/fix-f2a-access.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultUsers, test } from './sandbox.mjs';

const ROLES = ['rust-autowipe.manage', 'rust-autowipe.run'];

/** Пользователи сверх стандартных: владелец без ролей и субпользователи с разными правами на srv1. */
function users() {
  return {
    ...defaultUsers(),
    plainOwner: { id: 'user_owner', username: 'owner', email: 'owner@panel.test', permissions: [], session: 'sess_plain_owner' },
    console: {
      id: 'user_console',
      username: 'console',
      email: 'console@panel.test',
      permissions: [...ROLES],
      session: 'sess_console',
      serverAccess: { srv1: ['console.read', 'console.write'] },
    },
    viewer: {
      id: 'user_viewer',
      username: 'viewer',
      email: 'viewer@panel.test',
      permissions: [],
      session: 'sess_viewer',
      serverAccess: { srv1: ['server.read', 'file.read'] },
    },
  };
}

/**
 * Список доступа сервера, как его отдаёт панель (routes/servers/invites.ts:39-75).
 * В песочнице такого роута нет — подставляем ответ по записям ServerAccess.
 */
function emulateAccessList(sb, serverId = 'srv1') {
  const data = Object.values(sb.users)
    .filter((user) => user.serverAccess?.[serverId])
    .map((user) => ({ serverId, userId: user.id, permissions: [...user.serverAccess[serverId]] }));
  return sb.panel.fail({ method: 'GET', path: `/api/servers/${serverId}/permissions`, status: 200, body: { success: true, data } });
}

const refused = (res) => res.status >= 400 && res.status < 500;

/** Что изменилось на «сервере»: удаления, питание, команды, записи в коллекции. */
function sideEffects(sb, since) {
  const after = sb.journal.entries.filter((entry) => entry.seq > since);
  return {
    deletes: after.filter((entry) => entry.kind === 'tunnel' && entry.op === 'delete').length,
    power: after.filter((entry) => entry.kind === 'fetch' && entry.method === 'POST' && /\/(stop|start|console\/command)$/.test(entry.path)).length,
    writes: after.filter((entry) => entry.kind === 'db' && ['insert', 'update', 'delete'].includes(entry.op) && entry.count).length,
  };
}

test('владелец без ролей плагина: может менять профили и запускать вайп своего сервера', async (t) => {
  const sb = createSandbox({ users: users() });
  await sb.load();
  sb.panel.setStatus('srv1', 'stopped');

  const status = await sb.call('plainOwner', 'GET', '/servers/srv1/status');
  const created = await sb.call('plainOwner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Карта', targets: ['/server/*/proceduralmap.*.map'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  const id = created.body?.data?.id;
  const run = await sb.call('plainOwner', 'POST', `/servers/srv1/profiles/${id}/run`, { body: { dryRun: true } });
  const files = await sb.call('plainOwner', 'GET', '/servers/srv1/files', { query: { path: '/' } });
  await sb.idle();
  t.note(`права во вкладке: ${JSON.stringify(status.body?.data?.permissions)}; профиль → ${created.status}, проверка → ${run.status}, файлы → ${files.status}`);

  assert.deepEqual(status.body?.data?.permissions, { canManage: true, canRun: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(files.status, 200, JSON.stringify(files.body));
});

test('владелец через API-ключ: права ограничены областью ключа, как в панели', async (t) => {
  const sb = createSandbox({ users: users() });
  await sb.load();
  sb.panel.setStatus('srv1', 'stopped');
  const profile = await sb.addProfile({ name: 'Карта', options: { warnChat: false } });
  const narrowKey = { id: 'user_owner', username: 'owner', permissions: ['server.read'], apiKeyId: 'key_narrow' };
  const wideKey = { id: 'user_owner', username: 'owner', permissions: ['server.read', 'rust-autowipe.run'], apiKeyId: 'key_wide' };
  const narrow = await sb.call(narrowKey, 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: { dryRun: true } });
  const status = await sb.call(narrowKey, 'GET', '/servers/srv1/status');
  const wide = await sb.call(wideKey, 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: { dryRun: true } });
  await sb.idle();
  t.note(`ключ без rust-autowipe.run → ${narrow.status}, права во вкладке ${JSON.stringify(status.body?.data?.permissions)}; ключ с ним → ${wide.status}`);
  assert.equal(narrow.status, 403);
  assert.deepEqual(status.body.data.permissions, { canManage: false, canRun: false });
  assert.equal(wide.status, 200);
});

test('субпользователь без server.read (только консоль) не видит ни профилей, ни истории, ни файлов', async (t) => {
  const sb = createSandbox({ users: users() });
  emulateAccessList(sb);
  await sb.load();
  const profile = await sb.addProfile({ name: 'Карта' });
  const since = sb.journal.entries.at(-1).seq;

  const answers = {
    status: await sb.call('console', 'GET', '/servers/srv1/status'),
    profiles: await sb.call('console', 'GET', '/servers/srv1/profiles'),
    runs: await sb.call('console', 'GET', '/servers/srv1/runs'),
    preview: await sb.call('console', 'POST', `/servers/srv1/profiles/${profile.id}/preview`),
    files: await sb.call('console', 'GET', '/servers/srv1/files', { query: { path: '/' } }),
  };
  const lists = sb.tunnel.calls.filter((entry) => entry.seq > since && entry.op === 'list').length;
  t.note(Object.entries(answers).map(([name, res]) => `${name} → ${res.status}`).join(', ') + `; запросов list к агенту: ${lists}`);
  t.note(`текст отказа: ${answers.status.body?.error}`);

  for (const [name, res] of Object.entries(answers)) assert.ok(refused(res), `${name}: ${res.status} ${JSON.stringify(res.body)}`);
  assert.match(answers.status.body.error, /server\.read/);
  assert.equal(lists, 0, 'без доступа плагин не должен листать каталоги сервера');
});

test('субпользователь с server.read без ролей: смотрит вкладку, но не листает файлы и не меняет профили', async (t) => {
  const sb = createSandbox({ users: users() });
  emulateAccessList(sb);
  await sb.load();
  await sb.addProfile({ name: 'Карта' });

  const status = await sb.call('viewer', 'GET', '/servers/srv1/status');
  const profiles = await sb.call('viewer', 'GET', '/servers/srv1/profiles');
  const files = await sb.call('viewer', 'GET', '/servers/srv1/files', { query: { path: '/' } });
  const created = await sb.call('viewer', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Своё', targets: ['/server/rust/cfg/*'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  t.note(`статус → ${status.status} ${JSON.stringify(status.body?.data?.permissions)}, профили → ${profiles.status}, файлы → ${files.status}, создание → ${created.status}`);

  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.deepEqual(status.body.data.permissions, { canManage: false, canRun: false });
  assert.equal(profiles.status, 200);
  assert.equal(profiles.body.data.length, 1);
  assert.equal(files.status, 403);
  assert.equal(created.status, 403);
});

test('ответ панели на список доступа: 403, страница входа 200 и переход 302 — отказ; верный список — доступ', async (t) => {
  const cases = [
    ['403 JSON', { status: 403, body: { error: 'Forbidden', code: 'PERMISSION_DENIED' } }],
    ['страница входа 200', { status: 200, body: '<!doctype html><title>Вход</title>' }],
    ['переход 302', { status: 302, body: '', headers: { location: 'https://panel.test/login' } }],
    ['200 без success', { status: 200, body: { data: [{ userId: 'user_sub', permissions: ['server.read'] }] } }],
  ];
  const results = [];
  for (const [name, answer] of cases) {
    const sb = createSandbox();
    sb.panel.fail({ method: 'GET', path: '/api/servers/srv1/permissions', ...answer });
    await sb.load();
    const res = await sb.call('sub', 'GET', '/servers/srv1/status');
    results.push(`${name} → ${res.status}`);
    assert.ok(refused(res), `${name}: субпользователь прошёл: ${res.status}`);
    sb.restore();
  }
  const ok = createSandbox();
  emulateAccessList(ok);
  await ok.load();
  const control = await ok.call('sub', 'GET', '/servers/srv1/status');
  results.push(`верный список → ${control.status}`);
  t.note(results.join('; '));
  assert.equal(control.status, 200, JSON.stringify(control.body));
});

test('cookie и личный ключ пользователя никуда не уходят; список доступа читается ключом плагина без переходов', async (t) => {
  const sb = createSandbox();
  emulateAccessList(sb);
  await sb.load();
  const since = sb.journal.entries.at(-1).seq;
  const withCookie = await sb.call('sub', 'GET', '/servers/srv1/status');
  const withKey = await sb.call('sub', 'GET', '/servers/srv1/profiles', { cookie: false, authorization: 'Bearer catalyst_personal_key' });
  const calls = sb.panel.calls.filter((entry) => entry.seq > since);
  const leaked = calls.filter((entry) => entry.cookie || entry.headers.authorization === 'Bearer catalyst_personal_key');
  const lists = calls.filter((entry) => entry.path === '/api/servers/srv1/permissions');
  t.note(`ответы: ${withCookie.status}, ${withKey.status}; запросов к панели: ${calls.length}, со списком доступа: ${lists.length}, с учётными данными пользователя: ${leaked.length}`);

  assert.equal(withCookie.status, 200);
  assert.equal(withKey.status, 200);
  assert.deepEqual(leaked.map((entry) => entry.path), []);
  assert.ok(lists.length >= 2);
  assert.ok(lists.every((entry) => entry.headers.authorization === `Bearer ${sb.panel.apiKey}`));
});

test('без API-ключа субпользователь получает понятный отказ, а владелец и админ работают', async (t) => {
  const sb = createSandbox({ config: { apiKey: '' } });
  emulateAccessList(sb);
  await sb.load();
  const sub = await sb.call('sub', 'GET', '/servers/srv1/status');
  const owner = await sb.call('owner', 'GET', '/servers/srv1/status');
  const admin = await sb.call('admin', 'GET', '/servers/srv1/status');
  t.note(`sub → ${sub.status} «${sub.body?.error}»; владелец → ${owner.status}; админ → ${admin.status}`);
  assert.equal(sub.status, 403);
  assert.match(sub.body.error, /API-ключ/);
  assert.equal(owner.status, 200);
  assert.equal(admin.status, 200);
});

test('таблица «роут → право»: без роли плагина — 403 и никаких действий', async (t) => {
  const sb = createSandbox();
  // Субпользователь с server.read, но без ролей плагина.
  sb.users.noRole = { id: 'user_norole', username: 'norole', email: 'norole@panel.test', permissions: [], session: 'sess_norole' };
  sb.panel.fail({
    method: 'GET',
    path: '/api/servers/srv1/permissions',
    status: 200,
    body: { success: true, data: [{ serverId: 'srv1', userId: 'user_norole', permissions: ['server.read', 'console.read', 'file.read'] }] },
  });
  await sb.load();
  const profile = await sb.addProfile({ name: 'Карта' });
  const routes = [
    ['POST', '/servers/srv1/warn-test', undefined, 'rust-autowipe.run'],
    ['POST', '/servers/srv1/panel-check', undefined, 'rust-autowipe.manage'],
    ['GET', '/servers/srv1/map-variables', undefined, 'rust-autowipe.manage'],
    ['GET', '/servers/srv1/files?path=/', undefined, 'rust-autowipe.manage'],
    ['POST', '/servers/srv1/profiles', { name: 'x', targets: ['/server/rust/cfg/*'] }, 'rust-autowipe.manage'],
    ['PUT', `/servers/srv1/profiles/${profile.id}`, { name: 'другое имя' }, 'rust-autowipe.manage'],
    ['DELETE', `/servers/srv1/profiles/${profile.id}`, undefined, 'rust-autowipe.manage'],
    ['POST', `/servers/srv1/profiles/${profile.id}/run`, {}, 'rust-autowipe.run'],
    ['POST', `/servers/srv1/profiles/${profile.id}/run`, { dryRun: true }, 'rust-autowipe.run'],
  ];
  const rows = [];
  for (const [method, path, body, token] of routes) {
    const since = sb.journal.entries.at(-1).seq;
    const res = await sb.call('noRole', method, path, body === undefined ? {} : { body });
    await sb.idle();
    const effects = sideEffects(sb, since);
    rows.push(`${method} ${path.replace(profile.id, ':id')} → ${res.status}`);
    assert.equal(res.status, 403, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, new RegExp(token.replace('.', '\\.')));
    assert.deepEqual(effects, { deletes: 0, power: 0, writes: 0 }, `${method} ${path}: побочные действия`);
  }
  t.note(rows.join('; '));
  assert.equal(sb.profiles().length, 1);
  assert.equal(sb.runs().length, 0);
});
