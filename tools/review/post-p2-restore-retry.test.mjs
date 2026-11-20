/**
 * После второго круга, R-5 (H10f и L33-4 «частично»): после падения панели
 * сервер, который остановил прерванный вайп, поднимался одной попыткой —
 * в onEnable. Но Catalyst включает плагины до того, как начинает принимать
 * запросы (server.ts: enablePlugin до app.listen), а агенты ещё не
 * подключены. Единственная попытка натыкалась на закрытый порт, и сервер
 * так и оставался выключенным.
 *
 * Правильное поведение: recoverInterruptedRuns помечает такой прогон
 * restorePending (время, число попыток). retryPendingRestores(ctx, now) —
 * её раз в минуту зовёт тик — пробует запуск, пока сервер stopped, не
 * приостановлен и на нём не идёт вайп. Удача — шаг в записи, пометка
 * снимается. Сервер уже запустили вручную — попыток нет. Через 60 минут
 * или после 30 попыток — отказ с причиной в истории.
 *
 * Тик здесь не нужен: подключение к тику — в index.js (отдельная правка),
 * поэтому тест зовёт retryPendingRestores сам, раз в минуту.
 *
 * Как «падает панель»: удаление .sav у агента зависает навсегда
 * (tunnel.hang), список идущих прогонов процесса очищается, загружается
 * новый экземпляр плагина. «Панель не принимает запросы» — fetch к ней
 * отвечает ECONNREFUSED (panel.fail({ network: true })).
 *
 * Запуск: node tools/review/post-p2-restore-retry.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const ACTIVE_RUNS = Symbol.for('rust-autowipe.activeRuns');
const MINUTE = 60000;

const startsAfter = (sb, seq) =>
  sb.panel.calls.filter((call) => call.seq > seq && call.method === 'POST' && call.path === '/api/servers/srv1/start');

/** Вайп остановил сервер и «умер» на удалении .sav: процесс панели упал. */
async function crashMidWipe(sb) {
  sb.tunnel.hang({ op: 'delete', path: SAV, times: 1 });
  const env = await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const { executeProfileRun } = await env.lib('wipe');
  void executeProfileRun(sb.ctx, profile, { trigger: 'manual' });
  await sb.until(() => sb.tunnel.pending().some((entry) => entry.path === SAV));
  assert.equal(sb.status(), 'stopped', 'предусловие: сервер остановил плагин');
  for (const run of sb.runs()) globalThis[ACTIVE_RUNS]?.delete(run.id);
  return profile;
}

/**
 * Новый процесс панели: onEnable → recoverInterruptedRuns. refused — панель
 * пока не принимает запросы (снять — вызвать возвращённую функцию).
 */
async function restart(sb, { refused = true } = {}) {
  const seq = sb.journal.entries.at(-1).seq;
  const undo = refused ? sb.panel.fail({ network: true }) : () => {};
  const fresh = await loadPlugin(sb);
  const wipe = await fresh.lib('wipe');
  await sb.run(wipe.recoverInterruptedRuns(sb.ctx));
  return { wipe, seq, accept: undo };
}

/** Один тик через минуту: retryPendingRestores, как её зовёт планировщик. */
async function minuteLater(sb, wipe) {
  await sb.clock.advance(MINUTE);
  assert.equal(typeof wipe.retryPendingRestores, 'function', 'в lib/wipe.js нет retryPendingRestores(ctx, now)');
  return sb.run(wipe.retryPendingRestores(sb.ctx, new Date()));
}

test('панель не принимает запросы первые 3 минуты — сервер поднят на 4-й попытке', async (t) => {
  const sb = createSandbox();
  await crashMidWipe(sb);
  const { wipe, seq, accept } = await restart(sb);
  const marked = sb.runs()[0];
  t.note(`после onEnable: status=${marked.status}, restorePending=${JSON.stringify(marked.restorePending)}`);
  assert.equal(marked.status, 'interrupted');
  assert.equal(marked.restorePending?.attempts, 1, 'прогон не помечен restorePending после неудачного запуска');
  assert.ok(marked.restorePending?.since, 'в пометке нет времени');

  await minuteLater(sb, wipe);
  await minuteLater(sb, wipe);
  assert.equal(sb.status(), 'stopped');
  assert.equal(sb.runs()[0].restorePending?.attempts, 3, 'неудачные попытки не считаются');
  accept(); // через 3 минуты панель начала принимать запросы
  const result = await minuteLater(sb, wipe);
  await sb.idle();

  const record = sb.runs()[0];
  const starts = startsAfter(sb, seq);
  t.note(`POST /start: ${starts.map((call) => call.outcome === 'done' ? call.status : call.outcome).join(', ')}; итог: ${JSON.stringify(result)}; сервер: ${sb.status()}`);
  t.note(`шаги: ${record.steps.slice(-3).map((step) => `${step.action}${step.ok ? '' : '!'} ${step.detail}`).join(' | ')}`);
  assert.equal(starts.length, 4, 'попыток запуска должно быть 4: при включении и три тика');
  assert.equal(sb.status(), 'running', 'сервер так и остался остановленным');
  assert.equal(record.restorePending, null, 'пометка не снята');
  assert.ok(record.steps.at(-1).action === 'restore-start' && record.steps.at(-1).ok, 'удача не записана в шаги');
  assert.equal(record.status, 'interrupted');

  // Дальше попыток нет.
  const seqAfter = sb.journal.entries.at(-1).seq;
  await minuteLater(sb, wipe);
  assert.equal(startsAfter(sb, seqAfter).length, 0);
});

test('сервер уже запустили вручную — попыток нет, пометка снята', async (t) => {
  const sb = createSandbox();
  await crashMidWipe(sb);
  const { wipe, accept } = await restart(sb);
  accept();
  sb.panel.setStatus('srv1', 'running', 'админ запустил сервер вручную');
  const seq = sb.journal.entries.at(-1).seq;
  await minuteLater(sb, wipe);
  await minuteLater(sb, wipe);
  const record = sb.runs()[0];
  t.note(`POST /start после ручного запуска: ${startsAfter(sb, seq).length}; последний шаг: ${record.steps.at(-1).detail}`);
  assert.equal(startsAfter(sb, seq).length, 0, 'плагин запускал уже работающий сервер');
  assert.equal(record.restorePending, null);
  assert.equal(sb.status(), 'running');
});

test('на сервере идёт другой вайп — попытки нет, пока он не кончится', async (t) => {
  const sb = createSandbox();
  await crashMidWipe(sb);
  const { wipe, accept } = await restart(sb);
  accept();
  // Новый вайп того же сервера (сервер стоит — он его не останавливает) застрял на удалении.
  sb.tunnel.hang({ op: 'delete', path: '/oxide/data/Kits.json', times: 1 });
  const other = await sb.addProfile({ targets: ['/oxide/data/Kits.json'], options: { warnChat: false, startServer: false } });
  void wipe.executeProfileRun(sb.ctx, other, { trigger: 'manual' });
  await sb.until(() => sb.tunnel.pending().some((entry) => entry.path === '/oxide/data/Kits.json'));
  const seq = sb.journal.entries.at(-1).seq;
  await minuteLater(sb, wipe);
  const pendingRun = sb.runs().find((run) => run.status === 'interrupted');
  t.note(`POST /start во время чужого вайпа: ${startsAfter(sb, seq).length}; пометка: ${JSON.stringify(pendingRun.restorePending)}`);
  assert.equal(startsAfter(sb, seq).length, 0, 'сервер запускали посреди удаления другого вайпа');
  assert.ok(pendingRun.restorePending, 'пометку сняли, хотя сервер не запускали');
  for (const run of sb.runs()) globalThis[ACTIVE_RUNS]?.delete(run.id);
});

test('срок вышел: 30 неудачных попыток — отказ с причиной в истории, дальше попыток нет', async (t) => {
  const sb = createSandbox();
  await crashMidWipe(sb);
  const { wipe, seq, accept } = await restart(sb);
  for (let minute = 1; minute <= 35; minute += 1) await minuteLater(sb, wipe);
  const record = sb.runs()[0];
  const starts = startsAfter(sb, seq).length;
  t.note(`POST /start: ${starts}; ошибки: ${JSON.stringify(record.errors.slice(-1))}`);
  assert.equal(starts, 30, 'попыток должно быть 30');
  assert.equal(record.restorePending, null, 'пометка не снята после отказа');
  assert.ok(record.errors.some((error) => /не запущен/.test(error) && /вручную/.test(error)), 'в истории нет причины отказа');
  assert.equal(record.steps.at(-1).ok, false);
  accept();
  await minuteLater(sb, wipe);
  assert.equal(startsAfter(sb, seq).length, 30, 'после отказа запуск всё ещё пробуется');
  assert.equal(sb.status(), 'stopped');
});

test('срок вышел: тик не звал повтор больше часа — отказ без попытки, причина в истории', async (t) => {
  const sb = createSandbox();
  await crashMidWipe(sb);
  const { wipe, seq, accept } = await restart(sb);
  accept();
  await sb.clock.advance(60 * MINUTE);
  await minuteLater(sb, wipe);
  const record = sb.runs()[0];
  t.note(`POST /start: ${startsAfter(sb, seq).length}; ошибки: ${JSON.stringify(record.errors.slice(-1))}`);
  assert.equal(startsAfter(sb, seq).length, 1, 'кроме попытки при включении плагина, запусков быть не должно');
  assert.equal(record.restorePending, null);
  assert.ok(record.errors.some((error) => /вручную/.test(error)));
});

test('без пометок retryPendingRestores не читает историю каждую минуту (журнал панели не растёт)', async (t) => {
  const sb = createSandbox();
  const env = await sb.load();
  const wipe = await env.lib('wipe');
  const seq = sb.journal.entries.at(-1).seq;
  for (let minute = 1; minute <= 5; minute += 1) await minuteLater(sb, wipe);
  const reads = sb.journal.entries.filter((entry) => entry.seq > seq && entry.kind === 'db' && entry.table === 'runs');
  t.note(`чтений коллекции runs за 5 минут: ${reads.length}`);
  assert.ok(reads.length <= 1, `журнал панели растёт: ${reads.length} чтений за 5 минут`);
});
