/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8a.
 *
 * Что проверяем. У человека в глобальной роли есть серверное право (например,
 * server.read из готовой роли «User» Catalyst) и роли плагина. Он не владелец
 * сервера, не субпользователь и не админ. Панель всё равно отвечает ему 200 на
 * GET /api/servers/:id любого сервера (Catalyst v1.89.2: lib/server-access.ts:67-71,
 * routes/servers/core.ts:1818-1825). Плагин считает этот ответ доступом.
 *
 * Как должно быть (ответы владельца: вайп запускают админы и владельцы серверов,
 * субпользователю хватает доступа к серверу и роли плагина): такому человеку —
 * отказ. Профиль на чужом сервере не создаётся, вайп не запускается, файлы
 * не удаляются, сервер не останавливается.
 *
 * Запуск: node tools/review/h08a-global-role-wipes-any-server.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultUsers, test } from './sandbox.mjs';

const PLUGIN_ROLES = ['rust-autowipe.manage', 'rust-autowipe.run'];
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

test('H8a: чужой с глобальным server.read и ролями плагина не может вайпнуть сервер', async (t) => {
  const users = {
    ...defaultUsers(),
    // Как роль «User» Catalyst (permission-vocabulary.ts: user → ['server.read']) плюс роли плагина.
    viewer: {
      id: 'user_viewer',
      username: 'viewer',
      email: 'viewer@panel.test',
      permissions: ['server.read', ...PLUGIN_ROLES],
      session: 'sess_viewer',
    },
  };
  const sb = createSandbox({ users });
  emulateAccessList(sb);
  await sb.load();
  const before = sb.tree.snapshot();

  // Для понимания: что о сервере srv1 думает сама панель.
  const asViewer = { cookie: 'better-auth.session_token=sess_viewer' };
  const listRes = await sb.run(fetch(`${sb.panel.base}/api/servers`, { headers: asViewer }));
  const listed = (await listRes.json()).data.map((server) => server.id);
  const detailRes = await sb.run(fetch(`${sb.panel.base}/api/servers/srv1`, { headers: asViewer }));
  t.note(`панель: в списке серверов у viewer [${listed.join(', ')}], GET /api/servers/srv1 → ${detailRes.status}`);

  // Профиль владельца сервера уже есть.
  const ownerProfile = await sb.addProfile({ name: 'Карта владельца' });

  const created = await sb.call('viewer', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Чужой вайп',
      targets: ['/oxide/**', '/server/rust/cfg/*'],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
    },
  });
  const run = await sb.call('viewer', 'POST', `/servers/srv1/profiles/${ownerProfile.id}/run`, { body: {} });
  await sb.idle();
  // Контроль: у «чужого» из песочницы только роли плагина, без серверного права, — ему отказ.
  const strangerRun = await sb.call('stranger', 'POST', `/servers/srv1/profiles/${ownerProfile.id}/run`, { body: {} });

  const removed = sb.tree.diff(before).removed;
  const power = sb.panel.calls
    .filter((call) => call.method === 'POST' && /^\/api\/servers\/srv1\/(stop|start|restart|kill)$/.test(call.path))
    .map((call) => call.path.split('/').pop());
  t.note(`плагин: создание профиля → ${created.status}, запуск чужого профиля → ${run.status}`);
  t.note(`итог: удалено ${removed.length} записей [${removed.join(', ')}], питание: [${power.join(', ')}]`);

  assert.deepEqual(
    {
      strangerRefused: refused(strangerRun),
      createRefused: refused(created),
      runRefused: refused(run),
      removed,
      power,
    },
    { strangerRefused: true, createRefused: true, runRefused: true, removed: [], power: [] },
    'человек без прав на чужой сервер создал профиль и запустил вайп через плагин',
  );
});
