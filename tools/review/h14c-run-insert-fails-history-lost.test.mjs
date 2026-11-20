/**
 * Ревью RustWipe, гипотеза 14 (раздел 4.2), утверждение H14c:
 * запись о прогоне (коллекция runs) делается один раз, в самом конце, без
 * повтора. Если эта запись не удалась (кратковременный сбой базы панели),
 * прогона нет в истории, хотя файлы удалены, а профиль при этом
 * обновляется и ссылается на прогон (lastRunId), которого нет.
 *
 * Правильное поведение (правила ревью, «высокая»: не терять данные и
 * историю; вкладка показывает историю как отчёт о вайпах): вайп, который
 * удалил файлы, виден в истории сервера и после одного сбоя записи.
 *
 * Сбой внедряется store.failWrite: первая запись в runs падает один раз.
 *
 * Запуск: node tools/review/h14c-run-insert-fails-history-lost.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

test('один сбой записи прогона: вайп, удаливший файлы, всё равно есть в истории', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T10:00:00.000Z' });
  const completed = () => sb.journal.of('event').filter((entry) => entry.event === 'rust-autowipe:run-completed').length;
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ nextRunAt: '2026-11-26T05:00:00.000Z', options: { warnChat: false } });
  await sb.load();
  sb.store.failWrite({ collection: 'runs', op: 'insert', times: 1 });

  const res = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  assert.equal(res.status, 200);
  await sb.until(() => completed() >= 1);
  await sb.idle();

  const removed = sb.tree.diff(before).removed;
  const history = await sb.call('admin', 'GET', '/servers/srv1/runs');
  const stored = sb.profiles()[0];
  t.note(`удалено: ${removed.join(', ')}; в истории: ${history.body.data.length}`);
  t.note(`профиль: lastRunStatus=${stored.lastRunStatus ?? '—'}, lastRunId=${stored.lastRunId ?? '—'} (такой прогон в истории: ${history.body.data.some((run) => run.id === stored.lastRunId) ? 'есть' : 'нет'})`);
  assert.ok(removed.length > 0, 'предусловие: вайп удалил файлы');
  assert.equal(history.status, 200);
  assert.equal(history.body.data.length, 1, 'вайп удалил файлы, а в истории сервера его нет');
});
