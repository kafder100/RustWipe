/**
 * Ревью RustWipe, гипотеза 10 (раздел 4.2), утверждение H10f — соседняя
 * настоящая проблема к H10c.
 *
 * H10c: панель упала посреди вайпа и поднялась в пределах окна догона
 * (catchUpMinutes, 120 мин) — вайп повторяется с начала. Если же панель
 * поднялась позже окна, повтора нет: тик просто переносит nextRunAt. А сервер,
 * который плагин остановил перед удалением, так и остаётся остановленным,
 * часть файлов удалена, часть нет. Признак «выполняется» и «кто остановил
 * сервер» жили только в памяти упавшего процесса.
 *
 * Правильное поведение (README: «авто-подъём сервера при ошибке после
 * остановки»; ответ владельца №7: запуск после вайпа решает галочка
 * «Запускать сервер после вайпа»): прерванный вайп — та же ошибка после
 * остановки. Когда панель снова работает, плагин поднимает сервер, который
 * остановил сам (галочка в профиле стоит).
 *
 * Как «падает панель»: удаление .sav у агента зависает навсегда
 * (tunnel.hang, один раз) — прогон первого экземпляра на этом месте
 * «умирает». Потом новый экземпляр плагина: onEnable (первый тик сразу) и
 * ещё 5 тиков раз в минуту.
 *
 * Два теста: панель поднялась через 3 часа (позже окна догона — сейчас
 * падает) и через 5 минут (в окне — сейчас сервер поднимает повторный вайп
 * из H10c; тест сторожит, чтобы исправление H10c не оставило сервер
 * остановленным и в этом случае).
 *
 * Запуск: node tools/review/h10f-crash-leaves-server-stopped.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';

async function crashMidDeleteAndRestart(t, downMinutes) {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false, startServer: true } });
  sb.tunnel.hang({ op: 'delete', path: SAV, times: 1 });

  const old = await sb.load();
  void old.module.runTick(sb.ctx);
  await sb.until(() => sb.tunnel.pending().some((entry) => entry.path === SAV));
  assert.equal(sb.status(), 'stopped', 'предусловие: плагин остановил сервер перед удалением');
  assert.equal(sb.tree.exists(MAP), false, 'предусловие: карта уже удалена');

  await sb.clock.advance(downMinutes * 60000);
  const restartSeq = sb.journal.entries.at(-1).seq;
  // Падение панели — это новый процесс: в памяти не остаётся идущих вайпов.
  // Плагин хранит их в globalThis, чтобы горячая перезагрузка посреди вайпа
  // не запускала второй (H10e), поэтому здесь список очищается явно.
  globalThis[Symbol.for('rust-autowipe.activeRuns')]?.clear();
  await loadPlugin(sb, { enable: true });
  for (let minute = 0; minute < 5; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();

  const starts = sb.journal.entries.filter(
    (entry) => entry.seq > restartSeq && entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/start',
  );
  const profile = sb.profiles()[0];
  t.note(`после перезапуска: POST /start ${starts.length}; статус сервера: ${sb.status()}; .sav на месте: ${sb.tree.exists(SAV)}`);
  t.note(`история: ${sb.runs().length ? sb.runs().map((run) => `${run.trigger} ok=${run.ok}`).join('; ') : 'пусто'}; профиль: lastSkippedAt=${profile.lastSkippedAt ?? '—'}, nextRunAt=${profile.nextRunAt}`);
  return sb;
}

test('панель упала посреди удаления и поднялась через 3 часа (позже окна догона): сервер снова запущен', async (t) => {
  const sb = await crashMidDeleteAndRestart(t, 180);
  assert.notEqual(sb.status(), 'stopped', 'сервер, остановленный прерванным вайпом, так и остался остановленным');
});

test('панель упала посреди удаления и поднялась через 5 минут (в окне догона): сервер снова запущен', async (t) => {
  const sb = await crashMidDeleteAndRestart(t, 5);
  assert.notEqual(sb.status(), 'stopped', 'сервер, остановленный прерванным вайпом, так и остался остановленным');
});
