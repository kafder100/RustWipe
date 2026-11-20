/**
 * Ревью RustWipe, гипотеза 14 (раздел 4.2), утверждение H14d:
 * запись о прогоне появляется только в самом конце вайпа. Если панель (или
 * плагин) перезапустилась посреди вайпа, в истории нет никакого следа этого
 * вайпа: сервер был остановлен, часть файлов удалена, а история об этом
 * молчит. Повтор после перезапуска (H10c) пишет только себя: карту,
 * удалённую до падения, история не показывает нигде.
 *
 * Правильное поведение (правила ревью: при сбое на любом шаге видно, что
 * осталось на диске и в истории; «высокая» — не терять историю): прерванный
 * вайп виден в истории сервера после перезапуска (как прерванный).
 *
 * Как «падает панель»: удаление .sav у агента зависает навсегда
 * (tunnel.hang, один раз) — прогон первого экземпляра на этом месте
 * «умирает». Через 5 минут новый экземпляр плагина: onEnable и ещё 5 тиков.
 *
 * Запуск: node tools/review/h14d-restart-midwipe-no-history.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';

test('перезапуск посреди вайпа: прерванный вайп виден в истории', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  sb.tunnel.hang({ op: 'delete', path: SAV, times: 1 });

  const old = await sb.load();
  void old.module.runTick(sb.ctx);
  await sb.until(() => sb.tunnel.pending().some((entry) => entry.path === SAV));
  const crashAt = sb.clock.now();
  assert.equal(sb.tree.exists(MAP), false, 'предусловие: до падения вайп успел удалить карту');

  await sb.clock.advance(5 * 60000);
  await loadPlugin(sb, { enable: true });
  for (let minute = 0; minute < 5; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();

  const res = await sb.call('admin', 'GET', '/servers/srv1/runs');
  assert.equal(res.status, 200);
  const runs = res.body.data;
  t.note(`упал в ${new Date(crashAt).toISOString().slice(11, 19)}; история: ${runs.map((run) => `${run.trigger} ${run.startedAt.slice(11, 19)} ok=${run.ok}, удалено: ${run.deleted.join(', ') || '—'}`).join('; ') || 'пусто'}`);
  const interrupted = runs.filter((run) => Date.parse(run.startedAt) <= crashAt);
  assert.ok(interrupted.length > 0, 'вайп, начатый до перезапуска и удаливший карту, не виден в истории');
});
