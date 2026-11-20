/**
 * Ревью RustWipe, гипотеза 10 (раздел 4.2), утверждение H10e:
 * перезагрузка плагина (обновление из маркетплейса, «Reload») посреди
 * планового вайпа. Старый вайп продолжает идти (отмены нет), а новый
 * экземпляр плагина ничего о нём не знает: блокировки только в памяти
 * модуля, nextRunAt ещё не перенесён. Первый же тик нового экземпляра
 * (onEnable делает его сразу) начинает второй вайп того же сервера
 * параллельно первому.
 *
 * Факты Catalyst v1.89.2 (catalyst-backend/src/plugins/loader.ts,
 * reloadPlugin): unloadPlugin (onDisable, onUnload, задачи остановлены) →
 * loadPlugin (новый импорт модуля, «?reload=…») → enablePlugin → onEnable.
 * Идущие промисы старого модуля никто не отменяет.
 *
 * Правильное поведение (ответ владельца №6): на одном сервере одновременно
 * не больше одного вайпа. Наблюдаемое: прогоны не пересекаются по времени,
 * файлы удаляются только на остановленном сервере.
 *
 * Запуск: node tools/review/h10e-reload-starts-second-wipe.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';

function watchDeletes(sb) {
  const done = [];
  sb.journal.onPush((entry) => {
    if (entry.kind === 'tunnel' && entry.op === 'delete' && entry.outcome === 'ok' && !done.some((item) => item.seq === entry.seq)) {
      done.push({ seq: entry.seq, path: entry.path, status: sb.status() });
    }
  });
  return done;
}

/** Первый раз после вайпа сервер снова работает → игра создаёт новый мир (один раз). */
function simulateNewWorld(sb) {
  const created = [];
  sb.journal.onPush((entry) => {
    if (created.length || entry.kind !== 'server' || entry.id !== 'srv1' || entry.to !== 'running') return;
    const seed = sb.panel.server('srv1').environment.WORLD_SEED;
    for (const ext of ['map', 'sav']) {
      const file = `/server/rust/proceduralmap.3000.${seed}.270.${ext}`;
      if (!sb.tree.exists(file)) {
        sb.tree.add(file, 1024);
        created.push(file);
      }
    }
  });
  return created;
}

function overlapping(runs) {
  const pairs = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const [a, b] = [runs[i], runs[j]];
      if (Date.parse(a.startedAt) < Date.parse(b.finishedAt) && Date.parse(b.startedAt) < Date.parse(a.finishedAt)) {
        pairs.push(`${a.startedAt.slice(11, 19)} и ${b.startedAt.slice(11, 19)}`);
      }
    }
  }
  return pairs;
}

test('перезагрузка плагина посреди планового вайпа: второй вайп сервера не начинается', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  const deletes = watchDeletes(sb);
  const newWorld = simulateNewWorld(sb);
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  sb.tunnel.delay(60000, { op: 'delete', path: MAP, times: 1 });

  // Старый экземпляр: плановый тик начал вайп, агент минуту удаляет карту.
  const old = await sb.load();
  void old.module.runTick(sb.ctx);
  await sb.until(() => sb.tunnel.calls.some((entry) => entry.op === 'delete' && entry.path === MAP));

  // Reload: onDisable и onUnload старого, затем новый импорт и onEnable.
  await sb.run(old.plugin.onDisable(sb.ctx));
  await sb.run(old.plugin.onUnload(sb.ctx));
  await loadPlugin(sb, { enable: true });
  for (let minute = 0; minute < 5; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();

  const runs = sb.runs();
  const whileUp = deletes.filter((item) => item.status !== 'stopped');
  t.note(`прогоны: ${runs.map((run) => `${run.trigger} ${run.startedAt.slice(11, 19)}–${run.finishedAt.slice(11, 19)} ok=${run.ok}${run.ok ? '' : ` [${run.errors[0]}]`}`).join('; ')}`);
  t.note(`удаления: ${deletes.map((item) => `${item.path.split('/').pop()} при ${item.status}`).join(', ')}; новый мир создан: ${newWorld.length ? 'да' : 'нет'}`);
  assert.deepEqual(overlapping(runs), [], 'два вайпа одного сервера шли одновременно');
  assert.deepEqual(whileUp.map((item) => `${item.path} при ${item.status}`), [], 'файлы удалялись на работающем сервере');
});
