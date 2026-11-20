/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8g.
 *
 * Что проверяем. Роут файлового пикера GET /servers/:id/files (index.js:379-410)
 * не требует роли плагина. Хватает любой записи доступа к серверу: панель
 * отвечает 200 на GET /api/servers/:id при любом ServerAccess
 * (Catalyst routes/servers/core.ts:1797, 1804). Плагин листает каталоги своими
 * правами туннеля. Субпользователь без права file.read (в панели список файлов
 * ему закрыт: routes/servers/files.ts:127) и без ролей плагина видит всё дерево
 * сервера.
 *
 * Как должно быть (сводка ответов владельца: «субпользователю хватает доступа к
 * серверу и роли плагина» — значит, без роли плагина действий с файлами нет):
 * такому человеку — отказ, список файлов не отдаётся.
 *
 * Запуск: node tools/review/h08g-files-without-role.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultUsers, test } from './sandbox.mjs';

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

test('H8g: субпользователь без роли плагина и без file.read не листает файлы сервера', async (t) => {
  const users = {
    ...defaultUsers(),
    peek: {
      id: 'user_peek',
      username: 'peek',
      email: 'peek@panel.test',
      permissions: [],
      session: 'sess_peek',
      serverAccess: { srv1: ['console.read'] },
    },
  };
  const sb = createSandbox({ users });
  emulateAccessList(sb);
  await sb.load();

  const root = await sb.call('peek', 'GET', '/servers/srv1/files', { query: { path: '/' } });
  const cfg = await sb.call('peek', 'GET', '/servers/srv1/files', { query: { path: '/server/rust/cfg' } });
  const seen = [...(root.body?.data?.entries ?? []), ...(cfg.body?.data?.entries ?? [])].map((entry) => entry.name);
  const asPeek = { cookie: 'better-auth.session_token=sess_peek' };
  const panelCheck = await sb.run(fetch(`${sb.panel.base}/api/servers/srv1`, { headers: asPeek }));
  t.note(`плагин: '/' → ${root.status}, '/server/rust/cfg' → ${cfg.status}; peek увидел [${seen.join(', ')}]`);
  t.note(`панель: GET /api/servers/srv1 для peek → ${panelCheck.status} (любой ServerAccess)`);

  assert.deepEqual(
    { rootRefused: refused(root), cfgRefused: refused(cfg), entriesSeen: seen.length },
    { rootRefused: true, cfgRefused: true, entriesSeen: 0 },
    'список файлов сервера отдан без роли плагина и без права на файлы',
  );
});
