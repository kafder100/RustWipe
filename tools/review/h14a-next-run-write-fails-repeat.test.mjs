/**
 * Ревью RustWipe, гипотеза 14 (раздел 4.2), утверждение H14a:
 * записи после планового вайпа идут по очереди без транзакции: прогон
 * (runs) → профиль (последний прогон, курсор сида) → nextRunAt. Если не
 * удалась запись nextRunAt, время планового запуска остаётся в прошлом, и
 * следующий тик (через минуту, в окне догона 120 мин) делает вайп ещё раз —
 * по уже работающему серверу с новым миром.
 *
 * Правильное поведение: один плановый срок — один вайп. Один сбой записи в
 * коллекцию profiles (любой из записей за прогон) не должен приводить к
 * повтору вайпа.
 *
 * Сбой внедряется store.failWrite: N-я запись в profiles за прогон падает
 * один раз (N = 1, 2, 3 — свой тест на каждую). Какие поля писала каждая
 * запись, видно в заметке теста. Когда сервер снова работает, «игра»
 * создаёт новый мир — так видно, стёр ли его повтор.
 *
 * Запуск: node tools/review/h14a-next-run-write-fails-repeat.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

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

/** Записывает, какие поля меняла каждая запись в profiles (только для заметки). */
function traceProfileWrites(sb) {
  const writes = [];
  const realCollection = sb.ctx.collection;
  sb.ctx.collection = (name) => {
    const collection = realCollection(name);
    if (name !== 'profiles') return collection;
    return {
      ...collection,
      async update(filter, data) {
        const record = { fields: Object.keys(data?.$set ?? data ?? {}).join(','), ok: true };
        writes.push(record);
        try {
          return await collection.update(filter, data);
        } catch (error) {
          record.ok = false;
          throw error;
        }
      },
    };
  };
  return writes;
}

for (const nth of [1, 2, 3]) {
  test(`сбой записи №${nth} в profiles после планового вайпа: вайп не повторяется`, async (t) => {
    const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
    const moveTo = (iso) => sb.clock.advance(Date.parse(iso) - sb.clock.now());
    const writes = traceProfileWrites(sb);
    const newWorld = simulateNewWorld(sb);
    await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
    await sb.load();
    sb.store.failWrite({ collection: 'profiles', op: 'update', nth, times: 1 });

    await sb.tick(); // 05:00 — плановый вайп
    await moveTo('2026-11-19T05:01:00.050Z');
    await sb.tick();
    await moveTo('2026-11-19T05:02:00.050Z');
    await sb.tick();
    await sb.idle();

    const stops = sb.panel.calls.filter((call) => call.method === 'POST' && call.path === '/api/servers/srv1/stop');
    const lostWorld = newWorld.filter((file) => !sb.tree.exists(file));
    t.note(`записи в profiles: ${writes.map((item, index) => `№${index + 1} ${item.fields}${item.ok ? '' : ' — СБОЙ'}`).join('; ')}`);
    t.note(`прогоны: ${sb.runs().map((run) => `${run.trigger} ${run.startedAt.slice(11, 19)} ok=${run.ok}`).join('; ')}; POST /stop: ${stops.length}`);
    assert.equal(stops.length, 1, 'за один плановый срок сервер остановлен для вайпа больше одного раза');
    assert.deepEqual(lostWorld, [], 'повторный вайп стёр новый мир');
  });
}
