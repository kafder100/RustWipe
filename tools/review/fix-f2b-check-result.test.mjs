/**
 * Исправление F2b: итог проверки (dry-run) не затирает итог настоящего вайпа
 * (находка L31-4, часть backend; договорённость К4).
 *
 * Раньше проверка писала lastRunStatus и lastError: ночью вайп упал, утром
 * админ нажал «Проверка (dry-run)» — карточка показывала «последний: ок», а
 * ошибка ночного вайпа пропадала. Событие run-completed не говорило, что это
 * проверка.
 *
 * Что проверяем:
 *   1) после проверки итог настоящего вайпа (lastRun*, lastError) прежний,
 *      итог проверки — в lastCheckAt, lastCheckStatus, lastCheckId, lastCheckError;
 *   2) событие run-completed несёт dryRun: true у проверки и false у вайпа;
 *   3) проверка, прерванная падением панели, закрывается в lastCheck*, а не
 *      в итоге настоящего вайпа.
 *
 * Запуск: node tools/review/fix-f2b-check-result.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const ACTIVE_RUNS = Symbol.for('rust-autowipe.activeRuns');

const events = (sb) =>
  sb.journal.of('event').filter((entry) => entry.event === 'rust-autowipe:run-completed').map((entry) => entry.data);

test('ночной вайп упал, утром проверка прошла: ошибка вайпа на месте, итог проверки — отдельно', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  sb.tunnel.fail({ op: 'delete', path: SAV, error: 'Permission denied: Access denied', times: 1 });
  const night = await sb.wipe(profile);
  assert.equal(night.ok, false, 'предусловие: ночной вайп упал');
  const nightError = sb.profiles()[0].lastError;

  await sb.clock.advance(6 * 3600000);
  const check = await sb.wipe(sb.profiles()[0], { dryRun: true });
  const stored = sb.profiles()[0];
  t.note(`после проверки: lastRunStatus=${stored.lastRunStatus}, lastError=${stored.lastError}; lastCheckStatus=${stored.lastCheckStatus}, lastCheckId=${stored.lastCheckId}`);
  assert.equal(check.ok, true);
  assert.equal(check.dryRun, true);
  assert.equal(stored.lastRunStatus, 'failed', 'итог настоящего вайпа не затёрт');
  assert.equal(stored.lastRunId, night.id);
  assert.equal(stored.lastError, nightError);
  assert.equal(stored.lastCheckStatus, 'ok');
  assert.equal(stored.lastCheckId, check.id);
  assert.equal(stored.lastCheckAt, check.finishedAt);
  assert.equal(stored.lastCheckError, null);
});

test('событие run-completed говорит, проверка это или вайп', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  await sb.wipe(profile, { dryRun: true });
  await sb.wipe(profile);
  const [first, second] = events(sb);
  t.note(`события: ${JSON.stringify(events(sb))}`);
  assert.equal(first.dryRun, true);
  assert.equal(second.dryRun, false);
});

test('проверка, прерванная падением панели, закрывается в lastCheck*, итог вайпа не трогается', async (t) => {
  const sb = createSandbox();
  sb.tunnel.hang({ op: 'list', path: '/server/rust', times: 1 });
  const env = await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false }, lastRunStatus: 'ok', lastRunAt: '2026-11-12T05:00:05.000Z', lastRunId: 'run_week_ago' });
  const { executeProfileRun } = await env.lib('wipe');
  void executeProfileRun(sb.ctx, profile, { dryRun: true });
  await sb.until(() => sb.tunnel.pending().length > 0);
  for (const run of sb.runs()) globalThis[ACTIVE_RUNS]?.delete(run.id);

  const fresh = await loadPlugin(sb);
  const { recoverInterruptedRuns } = await fresh.lib('wipe');
  const result = await sb.run(recoverInterruptedRuns(sb.ctx));
  const stored = sb.profiles()[0];
  t.note(`итог: ${JSON.stringify(result)}; lastRunStatus=${stored.lastRunStatus}; lastCheckStatus=${stored.lastCheckStatus}`);
  assert.equal(result.interrupted, 1);
  assert.equal(stored.lastRunStatus, 'ok', 'итог настоящего вайпа не затёрт');
  assert.equal(stored.lastRunId, 'run_week_ago');
  assert.equal(stored.lastCheckStatus, 'failed');
  assert.equal(stored.lastCheckId, sb.runs()[0].id);
});
