/**
 * Исправление P3 (R-5, часть index.js; H10f и L33-4): тик раз в минуту
 * повторяет запуск сервера после прерванного вайпа.
 *
 * Было: сервер, который остановил вайп, прерванный падением панели, плагин
 * пробовал поднять один раз — в onEnable. Catalyst включает плагины до того,
 * как начинает принимать запросы, поэтому эта попытка проваливалась, и сервер
 * оставался выключенным. Тики её не повторяли.
 * Должно (решение координатора): повторы делает wipe.retryPendingRestores(ctx,
 * now) — часть P2 в lib/wipe.js; тик зовёт её раз в минуту, если она есть.
 * Вызов идёт в фоне и не держит предупреждения и вайпы других серверов. Пока
 * прежний вызов не закончился, новый не начинается (сервер не получит две
 * команды запуска). Вызов идёт после разбора сроков — вайп, начатый в этом же
 * тике, уже записан как идущий, — и при выключенном планировщике тоже: это не
 * вайп, а подъём сервера, который остановил сам плагин.
 *
 * retryPendingRestores в этой ветке ещё нет, поэтому lib/wipe.js для index.js
 * подменён обёрткой (хук загрузки node:module): настоящий модуль плюс
 * retryPendingRestores, которой управляет тест. Если настоящая функция уже
 * есть, обёртка подменяет и её: здесь проверяется только index.js.
 *
 * Запуск: node tools/review/post-p3-restore-retry.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const UUID2 = 'c0ffee00-0000-4000-8000-00000000b002';

// ── Подмена lib/wipe.js для index.js (только пока stub.mode задан) ─────────
//   'stub' — настоящий модуль плюс retryPendingRestores из теста;
//   'none' — модуль без retryPendingRestores (как lib/wipe.js до правки P2).
const stub = { mode: null };
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const version = /[?&]rwsandbox=(\d+)/.exec(context.parentURL || '')?.[1];
    if (!stub.mode || !version || !/\/backend\/index\.js\?/.test(context.parentURL || '')) return result;
    const file = result.url.split('?')[0];
    if (!file.endsWith('/lib/wipe.js')) return result;
    const real = JSON.stringify(`${file}?rwsandbox=${version}`);
    const source =
      stub.mode === 'stub'
        ? `export * from ${real};\n` +
          'export function retryPendingRestores(ctx, now) { return globalThis.__p3Restore(ctx, now); }\n'
        : `export { executeProfileRun, recoverInterruptedRuns } from ${real};\n`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

/** Включить подмену на время теста: restore — что делает retryPendingRestores. */
function useWipeStub(t, restore) {
  globalThis.__p3Restore = restore;
  stub.mode = restore ? 'stub' : 'none';
  t.cleanup(() => {
    stub.mode = null;
    delete globalThis.__p3Restore;
  });
}

const say = (sb, serverId) =>
  sb.panel.console(serverId).filter((item) => item.command.startsWith('say ')).map((item) => item.command.slice(4));
const restoreWarnings = (sb) =>
  sb.journal.entries.filter((entry) => entry.kind === 'log' && entry.level === 'warn' && /повторить запуск/.test(entry.msg));
const at = (sb, iso) => sb.clock.advance(Date.parse(iso) - sb.clock.now());

test('R-5: тик зовёт retryPendingRestores(ctx, now) раз в минуту — и сразу при включении плагина', async (t) => {
  const calls = [];
  useWipeStub(t, async (ctx, now) => {
    calls.push({ ctx, now: now?.toISOString?.() ?? String(now) });
  });
  const sb = createSandbox({ now: '2026-11-19T10:00:00.040Z' });
  await sb.load({ enable: true }); // onEnable сразу делает тик
  await sb.idle();
  await at(sb, '2026-11-19T10:01:00.040Z');
  await sb.tick();
  await at(sb, '2026-11-19T10:02:00.040Z');
  await sb.tick();
  await sb.idle();
  t.note(`вызовы: ${calls.map((call) => call.now).join(', ')}`);

  assert.deepEqual(
    calls.map((call) => call.now),
    ['2026-11-19T10:00:00.040Z', '2026-11-19T10:01:00.040Z', '2026-11-19T10:02:00.040Z'],
  );
  assert.ok(calls.every((call) => call.ctx === sb.ctx), 'в функцию приходит контекст плагина');
});

test('R-5: попытка подъёма зависла — вайп другого сервера и предупреждения идут; новая попытка — только после конца прежней', async (t) => {
  const calls = [];
  let release = null;
  useWipeStub(t, (_ctx, now) => {
    calls.push(now.toISOString());
    // Первая попытка висит (панель не отвечает), пока тест её не отпустит.
    if (calls.length === 1) return new Promise((resolve) => (release = resolve));
    return undefined;
  });
  const sb = createSandbox({
    now: '2026-11-19T05:00:00.040Z',
    servers: [defaultServer({ id: 'srv1', name: 'Rust #1' }), defaultServer({ id: 'srv2', uuid: UUID2, name: 'Rust #2' })],
  });
  await sb.addProfile({ serverId: 'srv1', name: 'A', nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.addProfile({ serverId: 'srv2', name: 'B', nextRunAt: '2026-11-19T05:03:00.000Z' });
  await sb.load();

  const first = sb.module.runTick(sb.ctx); // 05:00 — вайп A, отсчёт B, попытка подъёма висит
  await sb.until(() => sb.runs().some((run) => run.serverId === 'srv1' && run.finishedAt));
  const runA = sb.runs().find((run) => run.serverId === 'srv1');
  const afterFirst = calls.length;
  await at(sb, '2026-11-19T05:01:00.040Z');
  await sb.tick(); // попытка ещё висит — новой нет, отсчёт B идёт
  const whileHanging = calls.length;
  const chat = say(sb, 'srv2');
  release?.();
  await sb.run(first);
  await at(sb, '2026-11-19T05:02:00.040Z');
  await sb.tick(); // прежняя попытка закончилась — новая
  await sb.idle();
  t.note(`вайп A: ok=${runA?.ok}, конец ${runA?.finishedAt}; чат srv2: ${chat.join(' | ')}; попытки: ${calls.join(', ')}`);

  assert.equal(runA?.ok, true, 'вайп сервера srv1 прошёл, пока попытка подъёма висела');
  assert.deepEqual(chat, ['Вайп сервера через 3 мин', 'Вайп сервера через 2 мин'], 'отсчёт в чате идёт каждую минуту');
  assert.equal(afterFirst, 1, 'тик позвал retryPendingRestores');
  assert.equal(whileHanging, 1, 'пока прежняя попытка не закончилась, новая не начинается');
  assert.deepEqual(calls, ['2026-11-19T05:00:00.040Z', '2026-11-19T05:02:00.040Z']);
});

test('R-5: повтор запуска начинается после разбора сроков — вайп этого тика уже записан как идущий', async (t) => {
  let sb = null;
  let seen = null;
  useWipeStub(t, async () => {
    seen = sb.runs().filter((run) => run.status === 'running').map((run) => run.serverId);
  });
  sb = createSandbox({ now: '2026-11-19T05:00:00.040Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load();
  await sb.tick();
  await sb.idle();
  t.note(`во время вызова идут прогоны на серверах: ${JSON.stringify(seen)}; прогонов всего ${sb.runs().length}`);
  assert.deepEqual(seen, ['srv1'], 'retryPendingRestores видит, что на srv1 уже идёт вайп, и его сервер не тронет');
  assert.equal(sb.runs().length, 1);
});

test('R-5: ошибка в retryPendingRestores — строка в журнале панели; тик и следующий вызов идут', async (t) => {
  let calls = 0;
  useWipeStub(t, () => {
    calls += 1;
    throw new Error('панель не ответила');
  });
  const sb = createSandbox({ now: '2026-11-19T05:00:00.040Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load();
  await sb.tick();
  await at(sb, '2026-11-19T05:01:00.040Z');
  await sb.tick();
  await sb.idle();
  t.note(`вызовов ${calls}; строк в журнале ${restoreWarnings(sb).length}: ${restoreWarnings(sb)[0]?.msg}; прогонов ${sb.runs().length}`);
  assert.equal(calls, 2);
  assert.equal(restoreWarnings(sb).length, 2);
  assert.equal(sb.runs().length, 1, 'плановый вайп прошёл');
  assert.equal(sb.runs()[0].ok, true);
});

test('R-5: планировщик выключен — ни вайпов, ни предупреждений, а повтор запуска идёт', async (t) => {
  let calls = 0;
  useWipeStub(t, async () => {
    calls += 1;
  });
  const sb = createSandbox({ now: '2026-11-19T05:00:00.040Z', config: { schedulerEnabled: false } });
  await sb.addProfile({ name: 'A', nextRunAt: '2026-11-19T05:00:00.000Z' });
  await sb.addProfile({ name: 'B', nextRunAt: '2026-11-19T05:03:00.000Z' });
  await sb.load();
  await sb.tick();
  await sb.idle();
  t.note(`вызовов ${calls}; прогонов ${sb.runs().length}; чат: ${say(sb, 'srv1').length}`);
  assert.equal(sb.runs().length, 0);
  assert.equal(say(sb, 'srv1').length, 0);
  assert.equal(calls, 1);
});

test('без retryPendingRestores в lib/wipe.js тик работает, как раньше, и журнал не засоряется', async (t) => {
  useWipeStub(t, null);
  const sb = createSandbox({ now: '2026-11-19T05:00:00.040Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load({ enable: true });
  await sb.idle();
  await at(sb, '2026-11-19T05:01:00.040Z');
  await sb.tick();
  await sb.idle();
  t.note(`прогонов ${sb.runs().length}; строк про повтор запуска ${restoreWarnings(sb).length}`);
  assert.equal(sb.runs().length, 1);
  assert.equal(sb.runs()[0].ok, true);
  assert.equal(restoreWarnings(sb).length, 0);
});
