/**
 * Исправление F2a: «двойной вайп» — на одном сервере не больше одного вайпа,
 * один плановый срок — один вайп (ответ владельца №6).
 *
 * Что проверяем:
 *  - блокировка на сервер, а не на профиль: второй запуск — 409; плановый
 *    срок на занятом сервере ждёт следующего тика и не сдвигается;
 *  - срок занимается до вайпа: пока идёт прогон, nextRunAt уже следующий;
 *  - ручной вайп пропускает плановый, если срок пришёлся на него;
 *  - договорённость К4 (части F2b подменены, их кода в этой ветке ещё нет):
 *    executeProfileRun получает slot; onEnable вызывает
 *    recoverInterruptedRuns до первого тика; запись прогона «running» от
 *    прежнего экземпляра плагина (перезагрузка) держит сервер занятым;
 *  - L34-1: тесты, которые ловят поломки планировщика — будущий срок,
 *    выключенный профиль, тик во время ручного вайпа, второй запуск.
 *
 * Подмена модулей: lib/wipe.js, который импортирует index.js, заменяется
 * обёрткой (хук загрузки node:module) — настоящий executeProfileRun вызывается
 * внутри, recoverInterruptedRuns — из теста.
 *
 * Запуск: node tools/review/fix-f2a-double-wipe.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';

// ── Подмена lib/wipe.js для index.js (только пока stub.wipe задан) ─────────
const stub = { wipe: null };
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const version = /[?&]rwsandbox=(\d+)/.exec(context.parentURL || '')?.[1];
    if (!stub.wipe || !version || !/\/backend\/index\.js\?/.test(context.parentURL || '')) return result;
    const file = result.url.split('?')[0];
    if (!file.endsWith('/lib/wipe.js')) return result;
    const real = JSON.stringify(`${file}?rwsandbox=${version}`);
    const source =
      `import * as real from ${real};\n` +
      `export * from ${real};\n` +
      'const hooks = globalThis.__f2aWipeStub;\n' +
      'export function executeProfileRun(ctx, profile, options) { return hooks.run(real.executeProfileRun, ctx, profile, options); }\n' +
      'export function recoverInterruptedRuns(ctx) { return hooks.recover(ctx); }\n';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

/** Включить подмену wipe.js на время теста. */
function useWipeStub(t, hooks) {
  globalThis.__f2aWipeStub = {
    run: (real, ...args) => real(...args),
    recover: async () => {},
    ...hooks,
  };
  stub.wipe = true;
  t.cleanup(() => {
    stub.wipe = null;
    delete globalThis.__f2aWipeStub;
  });
}

/** Записи прогона «running» в начале и итог в конце — как договорённость К4 у F2b. */
function k4Records(sb) {
  return async (real, ctx, profile, options) => {
    const id = `run_k4_${Math.random().toString(36).slice(2, 8)}`;
    await ctx.collection('runs').insert({
      id,
      profileId: profile.id,
      serverId: profile.serverId,
      slot: options?.slot ?? null,
      trigger: options?.trigger,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    const run = await real(ctx, profile, options);
    await ctx.collection('runs').update({ id }, { $set: { status: run.ok ? 'ok' : 'failed', finishedAt: run.finishedAt } });
    return { ...run, id };
  };
}

const stops = (sb, since = 0) =>
  sb.journal.entries.filter((entry) => entry.seq > since && entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/stop');

test('К4: плановый прогон получает slot, ручной — null; recoverInterruptedRuns — до первого тика', async (t) => {
  const order = [];
  const options = [];
  useWipeStub(t, {
    recover: async () => order.push('recover'),
    run: (real, ctx, profile, opts) => {
      options.push({ trigger: opts?.trigger, slot: opts?.slot ?? null });
      return real(ctx, profile, opts);
    },
  });
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  const profile = await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  sb.journal.onPush((entry) => {
    if (entry.kind === 'db' && entry.table === 'profiles' && entry.op === 'find' && !order.includes('tick')) order.push('tick');
  });
  await sb.load({ enable: true });
  await sb.idle();
  const manual = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.idle();
  t.note(`порядок: ${order.join(' → ')}; вызовы: ${JSON.stringify(options)}`);

  assert.deepEqual(order.slice(0, 2), ['recover', 'tick']);
  assert.equal(manual.status, 200);
  assert.deepEqual(options, [
    { trigger: 'schedule', slot: '2026-11-19T05:00:00.000Z' },
    { trigger: 'manual', slot: null },
  ]);
});

test('срок занимается до вайпа: пока сервер остановлен, nextRunAt уже следующий', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  sb.tunnel.delay(30000, { op: 'delete', path: MAP, times: 1 });
  await sb.load();
  const tick = sb.module.runTick(sb.ctx);
  await sb.until(() => sb.tunnel.calls.some((entry) => entry.op === 'delete' && entry.path === MAP));
  const during = sb.profiles()[0].nextRunAt;
  const statusDuring = sb.status();
  await sb.run(tick);
  await sb.idle();
  t.note(`во время удаления: сервер ${statusDuring}, nextRunAt ${during}; после: ${sb.profiles()[0].nextRunAt}`);
  assert.equal(statusDuring, 'stopped');
  assert.ok(Date.parse(during) > sb.clock.now(), 'срок должен быть перенесён ещё до удаления файлов');
  assert.equal(sb.profiles()[0].nextRunAt, during, 'после прогона срок тот же — второй записи нет');
  assert.equal(sb.runs().length, 1);
});

test('L34-1: будущий срок и выключенный профиль — вайпа нет; тик во время ручного вайпа — один вайп; второй запуск — 409', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  const future = await sb.addProfile({ name: 'Будущий', nextRunAt: '2026-11-19T05:01:00.000Z', options: { warnChat: false } });
  const off = await sb.addProfile({ name: 'Выключен', enabled: false, nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load();

  await sb.tick();
  await sb.idle();
  const afterFirstTick = { runs: sb.runs().length, stops: stops(sb).length };
  assert.deepEqual(afterFirstTick, { runs: 0, stops: 0 }, 'будущий и выключенный профили не должны вайпать');
  assert.equal(sb.profiles().find((item) => item.id === off.id).nextRunAt, '2026-11-19T05:00:00.000Z', 'срок выключенного не трогается');

  // Ручной вайп «Будущего» идёт минуту; в это время наступает его срок и тикает планировщик.
  sb.tunnel.delay(60000, { op: 'delete', path: MAP, times: 1 });
  const first = await sb.call('admin', 'POST', `/servers/srv1/profiles/${future.id}/run`, { body: {} });
  const second = await sb.call('admin', 'POST', `/servers/srv1/profiles/${future.id}/run`, { body: {} });
  const other = await sb.call('admin', 'POST', `/servers/srv1/profiles/${off.id}/run`, { body: {} });
  await sb.clock.advance(Date.parse('2026-11-19T05:01:00.050Z') - sb.clock.now());
  await sb.tick();
  await sb.clock.advance(5 * 60000);
  await sb.tick();
  await sb.idle();
  const next = sb.profiles().find((item) => item.id === future.id).nextRunAt;
  t.note(`запуски: ${first.status}, второй ${second.status} «${second.body?.error}», другой профиль ${other.status} «${other.body?.error}»; прогонов ${sb.runs().length}, POST /stop ${stops(sb).length}; nextRunAt ${next}`);

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(other.status, 409);
  assert.match(other.body.error, /другого профиля/);
  assert.equal(sb.runs().length, 1, 'плановый срок, пришедшийся на ручной вайп, не даёт второго вайпа');
  assert.equal(stops(sb).length, 1);
  assert.ok(Date.parse(next) > sb.clock.now(), 'срок перенесён на следующий раз');
});

test('ручной вайп упал, ничего не удалив, — плановый срок, пришедшийся на него, всё равно проходит', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T04:59:50.000Z' });
  sb.panel.behave('srv1', { stopMs: 15000 });
  const profile = await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  // Первое чтение каталога у агента падает: ручной вайп обрывается до удаления.
  sb.tunnel.fail({ op: 'list', error: 'File system error: Cannot access path: /var/lib/catalyst/x/server', times: 1 });
  await sb.load();
  const manual = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.clock.advance(Date.parse('2026-11-19T05:01:00.050Z') - sb.clock.now());
  await sb.tick();
  await sb.idle();
  const runs = sb.runs().map((run) => `${run.trigger} ok=${run.ok} удалено=${run.deletedCount}`);
  t.note(`ручной → ${manual.status}; прогоны: ${runs.join('; ')}`);
  assert.equal(manual.status, 200);
  assert.deepEqual(sb.runs().map((run) => [run.trigger, run.ok]), [['manual', false], ['schedule', true]]);
});

test('К4: запись «running» прежнего экземпляра держит сервер занятым; запись старше 6 часов — нет', async (t) => {
  const now = Date.parse('2026-11-19T05:00:00.050Z');
  const sb = createSandbox({
    now,
    collections: {
      runs: [{ id: 'run_old', profileId: 'wipe_other', serverId: 'srv1', status: 'running', startedAt: new Date(now - 60000).toISOString() }],
    },
  });
  const profile = await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load();
  const run = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.tick();
  await sb.idle();
  const status = await sb.call('admin', 'GET', '/servers/srv1/status');
  t.note(`ручной запуск → ${run.status}; POST /stop ${stops(sb).length}; nextRunAt ${sb.profiles()[0].nextRunAt}; running ${JSON.stringify(status.body.data.running)}`);
  assert.equal(run.status, 409);
  assert.equal(stops(sb).length, 0);
  assert.equal(sb.profiles()[0].nextRunAt, '2026-11-19T05:00:00.000Z', 'срок ждёт, пока сервер освободится');
  assert.deepEqual(status.body.data.running, ['wipe_other']);
  sb.restore();

  const stale = createSandbox({
    now,
    collections: {
      runs: [{ id: 'run_stale', profileId: 'wipe_other', serverId: 'srv1', status: 'running', startedAt: new Date(now - 7 * 3600000).toISOString() }],
    },
  });
  const profile2 = await stale.addProfile({ options: { warnChat: false } });
  await stale.load();
  const run2 = await stale.call('admin', 'POST', `/servers/srv1/profiles/${profile2.id}/run`, { body: {} });
  await stale.idle();
  t.note(`запись старше 6 ч: ручной запуск → ${run2.status}`);
  assert.equal(run2.status, 200);
});

test('перезагрузка плагина посреди ручного вайпа: новый экземпляр не начинает второй вайп (К4 подменён)', async (t) => {
  useWipeStub(t, {});
  const sb = createSandbox({ now: '2026-11-19T10:00:00.000Z' });
  globalThis.__f2aWipeStub.run = k4Records(sb);
  const profile = await sb.addProfile({ nextRunAt: '2026-11-26T05:00:00.000Z', options: { warnChat: false } });
  sb.tunnel.delay(60000, { op: 'delete', path: MAP, times: 1 });
  const old = await sb.load({ enable: true });
  await sb.idle();
  const first = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.until(() => sb.tunnel.calls.some((entry) => entry.op === 'delete' && entry.path === MAP));

  // Reload: onDisable и onUnload старого экземпляра, новый импорт и onEnable.
  await sb.run(old.plugin.onDisable(sb.ctx));
  await sb.run(old.plugin.onUnload(sb.ctx));
  await loadPlugin(sb, { enable: true });
  const during = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  const list = await sb.call('admin', 'GET', '/servers/srv1/profiles');
  await sb.idle();
  const after = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: { dryRun: true } });
  await sb.idle();
  t.note(`первый → ${first.status}; после перезагрузки во время вайпа → ${during.status} «${during.body?.error}», running=${list.body.data[0].running}; после конца → ${after.status}`);
  assert.equal(first.status, 200);
  assert.equal(during.status, 409);
  assert.equal(list.body.data[0].running, true);
  assert.equal(after.status, 200);
  assert.equal(stops(sb).length, 1);
});
