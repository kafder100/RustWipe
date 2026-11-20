/**
 * Исправление F2a: правка профиля во время прогона и версия профиля.
 *
 *  - L31-2: вкладка, открытая раньше, не возвращает молча пути, убранные в
 *    другой вкладке: PUT с устаревшим expectedUpdatedAt — 409 PROFILE_CHANGED
 *    (договорённость К5); без expectedUpdatedAt PUT работает, как раньше;
 *  - L31-6, L33-6: правка во время вайпа — 409 PROFILE_RUNNING, а после
 *    прогона расписание и nextRunAt — те, что сохранил человек, их ничто
 *    не перетирает;
 *  - L33-3: тик перечитывает профиль перед вайпом: выключенный или удалённый,
 *    пока тик обходил другие профили, профиль файлы не стирает.
 *
 * Запуск: node tools/review/fix-f2a-edit-during-run.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';

test('L31-2: устаревшая вкладка получает 409 и не возвращает убранный путь', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const created = await sb.call('admin', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Карта',
      targets: ['/server/*/proceduralmap.*.sav', '/oxide/data/*'],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
    },
  });
  const card = created.body.data;
  // Вкладка А убирает /oxide/data/*, вкладка Б открыта раньше и меняет только время.
  await sb.clock.advance(1000);
  const tabA = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { ...card, targets: ['/server/*/proceduralmap.*.sav'], expectedUpdatedAt: card.updatedAt },
  });
  const tabB = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { ...card, schedule: { ...card.schedule, time: '06:00' }, expectedUpdatedAt: card.updatedAt },
  });
  const stored = sb.profiles()[0];
  t.note(`вкладка А → ${tabA.status}; вкладка Б → ${tabB.status} ${tabB.body?.code} «${tabB.body?.error}»; targets ${JSON.stringify(stored.targets)}, время ${stored.schedule.time}`);

  assert.equal(tabA.status, 200);
  assert.equal(tabB.status, 409);
  assert.equal(tabB.body.code, 'PROFILE_CHANGED');
  assert.equal(tabB.body.error, 'Профиль изменён в другом месте. Обновите вкладку.');
  assert.deepEqual(stored.targets, ['/server/*/proceduralmap.*.sav']);
  assert.equal(stored.schedule.time, '05:00');

  // Свежая версия — сохраняется; запрос без expectedUpdatedAt (старый клиент) — тоже.
  const fresh = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { schedule: { ...card.schedule, time: '06:00' }, expectedUpdatedAt: tabA.body.data.updatedAt },
  });
  const legacy = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, { body: { name: 'Карта (старый клиент)' } });
  t.note(`свежая версия → ${fresh.status}; без версии → ${legacy.status}`);
  assert.equal(fresh.status, 200);
  assert.equal(legacy.status, 200);
});

test('L31-6, L33-6: правка во время планового вайпа — 409; после прогона сохраняется новое расписание', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  const profile = await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  sb.tunnel.delay(60000, { op: 'delete', path: MAP, times: 1 });
  await sb.load();
  const tick = sb.module.runTick(sb.ctx);
  await sb.until(() => sb.tunnel.calls.some((entry) => entry.op === 'delete' && entry.path === MAP));

  const monday = { kind: 'weekly', weekday: 1, time: '05:00' };
  const during = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${profile.id}`, { body: { schedule: monday } });
  const removeDuring = await sb.call('admin', 'DELETE', `/servers/srv1/profiles/${profile.id}`);
  await sb.run(tick);
  await sb.idle();
  const after = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${profile.id}`, { body: { schedule: monday } });
  const savedNext = sb.profiles()[0].nextRunAt;
  await sb.clock.advance(60000);
  await sb.tick();
  await sb.idle();
  const stored = sb.profiles()[0];
  t.note(`во время вайпа: PUT → ${during.status} ${during.body?.code}, DELETE → ${removeDuring.status}; после: PUT → ${after.status}, nextRunAt ${stored.nextRunAt} (день ${new Date(stored.nextRunAt).getDay()})`);

  assert.equal(during.status, 409);
  assert.equal(during.body.code, 'PROFILE_RUNNING');
  assert.equal(removeDuring.status, 409);
  assert.equal(after.status, 200);
  assert.equal(stored.schedule.weekday, 1);
  assert.equal(stored.nextRunAt, savedNext, 'nextRunAt после правки ничто не перетёрло');
  assert.equal(new Date(stored.nextRunAt).getDay(), 1, 'следующий вайп — в понедельник, как в новом расписании');
});

test('L33-3: профиль, выключенный или удалённый, пока тик занят другим, файлы не стирает', async (t) => {
  const uuid2 = 'c0ffee00-0000-4000-8000-00000000b002';
  const uuid3 = 'c0ffee00-0000-4000-8000-00000000c003';
  const sb = createSandbox({
    now: '2026-11-19T05:00:00.050Z',
    servers: [
      defaultServer({ id: 'srv1', name: 'Rust #1' }),
      defaultServer({ id: 'srv2', uuid: uuid2, name: 'Rust #2' }),
      defaultServer({ id: 'srv3', uuid: uuid3, name: 'Rust #3' }),
    ],
  });
  sb.tree.addHost(`/var/lib/catalyst/${uuid2}/server/rust/proceduralmap.3000.1.270.map`, 10);
  sb.tree.addHost(`/var/lib/catalyst/${uuid3}/server/rust/proceduralmap.3000.1.270.map`, 10);
  const slot = '2026-11-19T05:00:00.000Z';
  const targets = ['/server/rust/proceduralmap.*.map'];
  const b = await sb.addProfile({ serverId: 'srv2', name: 'B', targets, nextRunAt: slot, options: { warnChat: false } });
  const c = await sb.addProfile({ serverId: 'srv3', name: 'C', targets, nextRunAt: slot, options: { warnChat: false } });
  // A добавлен последним: тик обходит профили с новых, A — первый.
  await sb.addProfile({ serverId: 'srv1', name: 'A', targets, nextRunAt: slot, options: { warnChat: false } });
  // Пока тик проверяет сервер A (панель отвечает 10 с), админ выключает B и удаляет C.
  sb.panel.delay(10000, { method: 'GET', path: '/api/servers/srv1', times: 1 });
  await sb.load();

  const tick = sb.module.runTick(sb.ctx);
  await sb.until(() => sb.panel.calls.some((call) => call.path === '/api/servers/srv1' && call.outcome === 'pending'));
  const off = await sb.call('admin', 'PUT', `/servers/srv2/profiles/${b.id}`, { body: { enabled: false } });
  const removed = await sb.call('admin', 'DELETE', `/servers/srv3/profiles/${c.id}`);
  await sb.run(tick);
  await sb.idle();

  const runs = sb.runs().map((run) => run.profileName);
  const stops = sb.panel.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/stop')).map((call) => call.path.split('/')[3]);
  t.note(`выключить B → ${off.status}, удалить C → ${removed.status}; прогоны [${runs.join(', ')}], остановлены [${stops.join(', ')}]`);
  assert.equal(off.status, 200);
  assert.equal(removed.status, 200);
  assert.deepEqual(runs, ['A']);
  assert.deepEqual(stops, ['srv1']);
});
