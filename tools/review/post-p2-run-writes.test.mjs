/**
 * После второго круга, R-10 (регрессия R2-4): запись прогона целиком
 * переписывалась после смены карты, после удаления и каждые 10 с во время
 * удаления — до 500 путей и все шаги каждый раз. Catalyst хранит каждый
 * вызов коллекции вместе с данными в своём журнале (pluginActionAudit),
 * который никто не чистит: на вайп 300 файлов — около 106 КБ вместо 10 КБ.
 *
 * Правильное поведение: запись прогона пишется в начале, когда плагин
 * останавливает сервер (отметка stoppedByUs — по ней сервер поднимут после
 * падения панели), и в конце. Итоговая запись — полная, как раньше.
 *
 * Запуск: node tools/review/post-p2-run-writes.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, rustServerTree, test } from './sandbox.mjs';

/** Сервер Rust и 300 файлов в /oxide/data/Players — вайп идёт несколько минут. */
function bigTree() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && (value.link !== undefined || value.junction !== undefined)) delete spec.files[key];
  }
  for (let index = 1; index <= 300; index += 1) spec.files[`/oxide/data/Players/p${index}.json`] = '{}';
  return spec;
}

const runWrites = (sb) =>
  sb.journal.entries
    .filter((entry) => entry.kind === 'db' && entry.table === 'runs' && ['insert', 'update'].includes(entry.op))
    .map((entry) => entry.op);

test('вайп 300 файлов (каждое удаление — 0,5 с): запись прогона — 3 раза: начало, остановка, конец', async (t) => {
  const sb = createSandbox({ tree: bigTree() });
  await sb.load();
  sb.tunnel.delay(500, { op: 'delete' });
  const profile = await sb.addProfile({
    targets: ['/oxide/data/Players/*.json'],
    map: { seed: { mode: 'random' }, size: { mode: 'keep' } },
    options: { warnChat: false },
  });
  const run = await sb.wipe(profile);
  await sb.idle();
  const writes = runWrites(sb);
  const [record] = sb.runs();
  t.note(`прогон: ok=${run.ok}, удалено ${run.deletedCount}, ${Math.round(run.durationMs / 1000)} с; записи прогона: ${writes.join(', ')}`);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.equal(run.deletedCount, 300);
  assert.deepEqual(writes, ['insert', 'update', 'update'], 'запись прогона переписывается по ходу — журнал панели растёт');
  // Итоговая запись — полная, как раньше.
  assert.equal(record.status, 'ok');
  assert.equal(record.deleted.length, 300);
  assert.ok(record.seed, 'в итоговой записи нет сида');
  assert.deepEqual(
    record.steps.map((step) => step.action),
    ['server', 'stop', 'stop', 'expand', 'map', 'delete', 'start', 'start'],
  );
});

test('сервер уже остановлен: запись прогона — 2 раза, начало и конец', async (t) => {
  const sb = createSandbox({ tree: bigTree() });
  await sb.load();
  sb.panel.setStatus('srv1', 'stopped', 'админ остановил сервер');
  const profile = await sb.addProfile({ targets: ['/oxide/data/Players/*.json'], options: { warnChat: false, startServer: false } });
  const run = await sb.wipe(profile);
  await sb.idle();
  const writes = runWrites(sb);
  t.note(`записи прогона: ${writes.join(', ')}`);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.deepEqual(writes, ['insert', 'update']);
  assert.equal(sb.runs()[0].deletedCount, 300);
});
