/**
 * Ревью RustWipe, гипотеза 10 (раздел 4.2), утверждение H10a:
 * ручной запуск («Запустить сейчас») не сдвигает время планового запуска
 * (nextRunAt). Если плановое время наступило, пока шёл ручной вайп, то сразу
 * после него на следующем тике пройдёт ещё один — плановый — вайп.
 *
 * Правильное поведение (ответ владельца №6 «Да, пропустить плановый»): ручной
 * вайп прошёл, а плановое время уже наступило или наступило во время
 * прогона — плановый вайп пропускается, время переносится на следующий срок.
 *
 * Сценарий: плановый вайп в 05:00. В 04:59:50 админ жмёт «Запустить сейчас»;
 * сервер останавливается 15 с, поэтому в 05:00 ручной вайп ещё идёт.
 * Планировщик тикает в 05:00 и в 05:01, как cron «* * * * *». Когда сервер
 * снова работает, «игра» создаёт новый мир (новые .map и .sav) — так видно,
 * стёр ли его лишний вайп.
 *
 * Запуск: node tools/review/h10a-manual-run-then-scheduled.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const stopsOf = (sb) => sb.panel.calls.filter((call) => call.method === 'POST' && call.path === '/api/servers/srv1/stop');

/**
 * Первый раз после вайпа сервер снова работает → игра создаёт мир под текущий
 * сид (как Rust при старте без сохранения). Один раз: так видно, стёр ли этот
 * мир следующий вайп.
 */
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

test('плановое время наступило во время ручного вайпа: второго (планового) вайпа нет', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T04:59:00.000Z' });
  const moveTo = (iso) => sb.clock.advance(Date.parse(iso) - sb.clock.now());
  sb.panel.behave('srv1', { stopMs: 15000 });
  const profile = await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load({ enable: true });
  await sb.idle();
  const newWorld = simulateNewWorld(sb);

  await moveTo('2026-11-19T04:59:50.000Z');
  const res = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  assert.equal(res.status, 200, `ручной запуск не принят: ${JSON.stringify(res.body)}`);

  await moveTo('2026-11-19T05:00:00.050Z');
  await sb.tick(); // ручной вайп ещё идёт (сервер останавливается)
  await moveTo('2026-11-19T05:01:00.050Z');
  await sb.tick(); // ручной вайп уже закончился, сервер работает на новом мире
  await sb.idle();

  const runs = sb.runs();
  const nextRunAt = sb.profiles()[0].nextRunAt;
  const lostWorld = newWorld.filter((file) => !sb.tree.exists(file));
  t.note(`прогоны: ${runs.map((run) => `${run.trigger} ${run.startedAt.slice(11, 19)}–${run.finishedAt.slice(11, 19)} ok=${run.ok}`).join('; ')}`);
  t.note(`POST /stop: ${stopsOf(sb).length}; новый мир после ручного вайпа стёрт: ${lostWorld.join(', ') || 'нет'}; nextRunAt: ${nextRunAt}`);

  assert.ok(runs.some((run) => run.trigger === 'manual' && run.ok), 'предусловие: ручной вайп прошёл');
  assert.ok(newWorld.length > 0, 'предусловие: после ручного вайпа сервер создал новый мир');
  assert.equal(stopsOf(sb).length, 1, 'сервер должен останавливаться для вайпа один раз, а не дважды');
  assert.deepEqual(lostWorld, [], 'новый мир после ручного вайпа не должен стираться плановым');
  assert.equal(runs.length, 1, 'плановый вайп после ручного должен быть пропущен');
  assert.ok(Date.parse(nextRunAt) > sb.clock.now(), 'время планового запуска перенесено на следующий срок');
});
