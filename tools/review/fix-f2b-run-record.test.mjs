/**
 * Исправление F2b: запись о прогоне с самого начала и восстановление после
 * падения панели (находки H14c, H14d, L33-4; договорённость К4).
 *
 * Что проверяем:
 *   1) запись о прогоне есть в истории сразу, со status 'running' и отметкой
 *      «сервер остановил плагин» (stoppedByUs);
 *   2) долгое удаление: запись не переписывается по ходу (журнал панели не
 *      растёт), но в ней уже есть начало и отметка stoppedByUs;
 *   3) панель упала посреди удаления → recoverInterruptedRuns закрывает прогон
 *      как прерванный и поднимает сервер, который остановил плагин;
 *   4) плагин перезагрузили, а процесс тот же (прогон ещё идёт) → прогон не
 *      трогаем, сервер не запускаем;
 *   5) сервер был остановлен до вайпа → после падения его не запускаем;
 *   6) начало прогона не записалось и после повторов → вайп не начат,
 *      сервер не тронут, итог записан со следующей попытки.
 *
 * Как «падает панель»: удаление .sav у агента зависает навсегда (tunnel.hang),
 * потом список идущих прогонов процесса очищается (при настоящем падении он
 * пропадает вместе с процессом) и загружается новый экземпляр плагина.
 * Список хранится в globalThis под Symbol.for('rust-autowipe.activeRuns'):
 * без очистки зависший прогон считается живым — так и есть при перезагрузке
 * плагина без падения процесса.
 *
 * Запуск: node tools/review/fix-f2b-run-record.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const ACTIVE_RUNS = Symbol.for('rust-autowipe.activeRuns');

const startsAfter = (sb, seq) =>
  sb.panel.calls.filter((call) => call.seq > seq && call.method === 'POST' && call.path === '/api/servers/srv1/start');

/** «Процесс панели упал»: прогоны прежнего экземпляра больше не идут. */
function crashProcess(sb) {
  for (const run of sb.runs()) globalThis[ACTIVE_RUNS]?.delete(run.id);
}

/** Ручной вайп, который застрял на удалении .sav (агент не отвечает). */
async function startStuckWipe(sb, overrides = {}) {
  sb.tunnel.hang({ op: 'delete', path: SAV, times: 1 });
  const env = await sb.load();
  const profile = await sb.addProfile({ ...overrides, options: { warnChat: false, ...(overrides.options || {}) } });
  const { executeProfileRun } = await env.lib('wipe');
  void executeProfileRun(sb.ctx, profile, { trigger: 'manual' });
  await sb.until(() => sb.tunnel.pending().some((entry) => entry.path === SAV));
  return profile;
}

/** Новый экземпляр плагина и восстановление, как при включении плагина. */
async function restartAndRecover(sb) {
  const fresh = await loadPlugin(sb);
  const seq = sb.journal.entries.at(-1).seq;
  const { recoverInterruptedRuns } = await fresh.lib('wipe');
  const result = await sb.run(recoverInterruptedRuns(sb.ctx));
  await sb.idle();
  return { result, seq };
}

test('запись о прогоне есть в истории сразу: status running и «сервер остановил плагин»', async (t) => {
  const sb = createSandbox();
  try {
    await startStuckWipe(sb);
    const res = await sb.call('admin', 'GET', '/servers/srv1/runs');
    assert.equal(res.status, 200);
    t.note(`история во время вайпа: ${JSON.stringify(res.body.data.map((run) => ({ status: run.status, stoppedByUs: run.stoppedByUs, trigger: run.trigger, slot: run.slot })))}`);
    assert.equal(res.body.data.length, 1, 'прогон виден в истории, пока идёт');
    const [record] = res.body.data;
    assert.equal(record.status, 'running');
    assert.equal(record.stoppedByUs, true);
    assert.equal(record.dryRun, false);
    assert.equal(record.trigger, 'manual');
    assert.equal(record.slot, null);
    assert.ok(record.startedAt);
  } finally {
    crashProcess(sb);
  }
});

test('долгое удаление: запись о прогоне не переписывается по ходу — есть начало и отметка остановки', async (t) => {
  // R-10: каждую запись коллекции панель хранит в своём журнале вместе с
  // данными, поэтому во время удаления запись прогона не переписывается.
  const sb = createSandbox();
  try {
    sb.tunnel.delay(30000, { op: 'delete', path: MAP, times: 1 });
    await startStuckWipe(sb);
    const [record] = sb.runs();
    const writes = sb.journal.entries
      .filter((entry) => entry.kind === 'db' && entry.table === 'runs' && ['insert', 'update'].includes(entry.op))
      .map((entry) => entry.op);
    t.note(`записи прогона за 30 с удаления: ${writes.join(', ')}; status=${record.status}, stoppedByUs=${record.stoppedByUs}`);
    assert.deepEqual(writes, ['insert', 'update'], 'запись прогона переписывается во время удаления');
    assert.equal(record.status, 'running');
    assert.equal(record.stoppedByUs, true, 'нет отметки «сервер остановил плагин» — после падения сервер не поднимут');
  } finally {
    crashProcess(sb);
  }
});

test('панель упала посреди удаления: прогон закрыт как прерванный, сервер поднят', async (t) => {
  const sb = createSandbox();
  const profile = await startStuckWipe(sb);
  assert.equal(sb.status(), 'stopped', 'предусловие: сервер остановлен плагином');
  assert.equal(sb.tree.exists(MAP), false, 'предусловие: карта уже удалена');

  crashProcess(sb);
  await sb.clock.advance(5 * 60000);
  const { result, seq } = await restartAndRecover(sb);

  const [record] = sb.runs();
  const stored = sb.profiles().find((item) => item.id === profile.id);
  t.note(`итог: ${JSON.stringify(result)}; запись: status=${record.status}, ok=${record.ok}; шаги: ${record.steps.map((step) => `${step.action}${step.ok ? '' : '!'}`).join(' → ')}`);
  t.note(`профиль: lastRunStatus=${stored.lastRunStatus}, lastError=${stored.lastError}`);
  assert.deepEqual(result, { interrupted: 1, started: 1 });
  assert.equal(record.status, 'interrupted');
  assert.equal(record.ok, false);
  assert.ok(record.errors.some((error) => error.includes('прерван')));
  assert.ok(record.steps.some((step) => step.action === 'restore-start' && step.ok));
  assert.equal(startsAfter(sb, seq).length, 1, 'одна команда запуска');
  assert.equal(sb.status(), 'running');
  assert.equal(stored.lastRunStatus, 'failed');
  assert.equal(stored.lastRunId, record.id);
});

test('плагин перезагрузили, а прогон ещё идёт в том же процессе: его не трогаем, сервер не запускаем', async (t) => {
  const sb = createSandbox();
  try {
    await startStuckWipe(sb);
    const { result, seq } = await restartAndRecover(sb);
    t.note(`итог: ${JSON.stringify(result)}; статус сервера: ${sb.status()}`);
    assert.deepEqual(result, { interrupted: 0, started: 0 });
    assert.equal(sb.runs()[0].status, 'running');
    assert.equal(startsAfter(sb, seq).length, 0, 'сервер не запускали посреди чужого удаления');
    assert.equal(sb.status(), 'stopped');
  } finally {
    crashProcess(sb);
  }
});

test('сервер был остановлен до вайпа: после падения панели его не запускают', async (t) => {
  const sb = createSandbox();
  sb.panel.setStatus('srv1', 'stopped', 'админ остановил сервер');
  await startStuckWipe(sb);
  assert.equal(sb.runs()[0].stoppedByUs, false, 'предусловие: плагин сервер не останавливал');
  crashProcess(sb);
  const { result, seq } = await restartAndRecover(sb);
  t.note(`итог: ${JSON.stringify(result)}; статус сервера: ${sb.status()}`);
  assert.deepEqual(result, { interrupted: 1, started: 0 });
  assert.equal(sb.runs()[0].status, 'interrupted');
  assert.equal(startsAfter(sb, seq).length, 0);
  assert.equal(sb.status(), 'stopped');
});

test('начало прогона не записалось и после повторов: вайп не начат, сервер не тронут', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.store.failWrite({ collection: 'runs', op: 'insert', times: 3 });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();

  const power = sb.panel.calls.filter((call) => call.method === 'POST' && /\/(stop|start)$/.test(call.path));
  t.note(`прогон: ok=${run.ok}; ошибки: ${run.errors.join(' | ')}; вызовы питания: ${power.length}; в истории: ${sb.runs().length}`);
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('вайп не начат')));
  assert.equal(power.length, 0, 'сервер не останавливали');
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  assert.deepEqual(sb.tree.diff(before).removed, []);
  assert.equal(sb.status(), 'running');
  assert.equal(sb.runs().length, 1, 'итог прогона записан со следующей попытки');
  assert.equal(sb.runs()[0].ok, false);
});
