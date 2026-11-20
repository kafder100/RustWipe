/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8b.
 *
 * Что проверяем. Плагин не смотрит на права субпользователя в панели: у
 * субпользователя есть доступ к серверу (ServerAccess: server.read, console.read,
 * file.read), но нет прав file.write, server.stop и server.start. С ролями плагина
 * он всё равно создаёт профиль и запускает вайп: плагин удаляет файлы своими
 * правами туннеля и останавливает сервер ключом из настроек.
 *
 * Как должно быть — решил владелец (вопрос 17: «Нет, хватит доступа к серверу и
 * роли плагина»): так и должно работать. Без роли плагина — отказ.
 * Поэтому тест проверяет выбранное владельцем поведение: если он проходит,
 * дефекта нет («опровергнуто»).
 *
 * Запуск: node tools/review/h08b-sub-wipe-without-panel-rights.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultUsers, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const refused = (res) => res.status >= 400 && res.status < 500;

/**
 * В песочнице нет роута панели со списком доступа к серверу
 * (Catalyst routes/servers/invites.ts:39-75, GET /api/servers/:id/permissions).
 * Подставляем его ответ по записям ServerAccess пользователей песочницы, чтобы
 * исправление, которое берёт субпользователей из этого списка, тоже проверялось.
 * Ответ отдаётся любому, кто спросит (настоящая панель сначала проверяет вход).
 */
function emulateAccessList(sb, serverId = 'srv1') {
  const data = Object.values(sb.users)
    .filter((user) => user.serverAccess?.[serverId])
    .map((user) => ({
      serverId,
      userId: user.id,
      permissions: [...user.serverAccess[serverId]],
      user: { id: user.id, email: user.email, username: user.username },
    }));
  sb.panel.fail({ method: 'GET', path: `/api/servers/${serverId}/permissions`, status: 200, body: { success: true, data } });
}

test('H8b: субпользователь с доступом и ролью плагина делает вайп; без роли плагина — отказ', async (t) => {
  const users = {
    ...defaultUsers(),
    // Тот же доступ к серверу, что у sub, но без ролей плагина.
    sub2: {
      id: 'user_sub2',
      username: 'sub2',
      email: 'sub2@panel.test',
      permissions: [],
      session: 'sess_sub2',
      serverAccess: { srv1: ['server.read', 'console.read', 'file.read'] },
    },
  };
  const sb = createSandbox({ users });
  emulateAccessList(sb);
  await sb.load();
  const before = sb.tree.snapshot();
  const body = {
    name: 'Карта',
    targets: ['/server/*/proceduralmap.*.map'],
    schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
  };

  const created = await sb.call('sub', 'POST', '/servers/srv1/profiles', { body });
  const id = created.body?.data?.id;
  const run = await sb.call('sub', 'POST', `/servers/srv1/profiles/${id}/run`, { body: {} });
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const power = sb.panel.calls
    .filter((call) => call.method === 'POST' && /^\/api\/servers\/srv1\/(stop|start)$/.test(call.path))
    .map((call) => call.path.split('/').pop());

  const created2 = await sb.call('sub2', 'POST', '/servers/srv1/profiles', { body: { ...body, name: 'Без роли' } });
  const run2 = await sb.call('sub2', 'POST', `/servers/srv1/profiles/${id}/run`, { body: {} });
  await sb.idle();

  // Для понимания: сама панель этому субпользователю остановку не разрешает.
  const ownStop = await sb.run(
    fetch(`${sb.panel.base}/api/servers/srv1/stop`, {
      method: 'POST',
      headers: { cookie: 'better-auth.session_token=sess_sub' },
    }),
  );
  t.note(`sub: профиль → ${created.status}, вайп → ${run.status}; удалено [${removed.join(', ')}], питание [${power.join(', ')}]`);
  t.note(`sub2 (без роли плагина): профиль → ${created2.status}, вайп → ${run2.status}`);
  t.note(`панель: собственная остановка srv1 от sub → ${ownStop.status} (своих прав на питание у него нет)`);

  assert.deepEqual(
    {
      subCreate: created.status,
      subRun: run.status,
      removed,
      power,
      sub2CreateRefused: refused(created2),
      sub2RunRefused: refused(run2),
      removedAfterSub2: sb.tree.diff(before).removed,
    },
    {
      subCreate: 200,
      subRun: 200,
      removed: [MAP],
      power: ['stop', 'start'],
      sub2CreateRefused: true,
      sub2RunRefused: true,
      removedAfterSub2: [MAP],
    },
  );
});
