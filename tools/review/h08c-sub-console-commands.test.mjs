/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8c.
 *
 * Что проверяем. В профиле есть «команды после запуска». Плагин шлёт их в
 * консоль сервера ключом из настроек (wipe.js:286-295), не глядя, кто их задал.
 * Субпользователь без права console.write (в панели ему консоль закрыта) с ролями
 * плагина задаёт любую команду, например ownerid (выдать себе админку в игре),
 * и после вайпа она уходит в консоль.
 *
 * Как должно быть — по решению владельца (вопрос 17 и сводка заказчика:
 * «субпользователю хватает доступа к серверу и роли плагина»): так и работает,
 * отдельное право на консоль не нужно. Тест проверяет это поведение; если он
 * проходит, дефекта по решению владельца нет. Про консоль владельца прямо не
 * спрашивали — риск вынесен в вопрос владельцу.
 *
 * Запуск: node tools/review/h08c-sub-console-commands.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const COMMAND = 'ownerid 76561198000000001 "sub" "через плагин"';

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

test('H8c: команда после запуска от субпользователя без console.write уходит в консоль', async (t) => {
  const sb = createSandbox();
  emulateAccessList(sb);
  await sb.load();

  const created = await sb.call('sub', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Карта и команда',
      targets: ['/server/*/proceduralmap.*.map'],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
      options: { commandsAfter: [COMMAND] },
    },
  });
  const id = created.body?.data?.id;
  const run = await sb.call('sub', 'POST', `/servers/srv1/profiles/${id}/run`, { body: {} });
  await sb.idle();
  const sent = sb.panel.console('srv1').map((item) => item.command);

  // Для понимания: сама панель этому субпользователю консоль не открывает.
  const own = await sb.run(
    fetch(`${sb.panel.base}/api/servers/srv1/console/command`, {
      method: 'POST',
      headers: { cookie: 'better-auth.session_token=sess_sub', 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'say проверка' }),
    }),
  );
  t.note(`sub: профиль → ${created.status}, вайп → ${run.status}; в консоль ушло [${sent.join(' | ')}]`);
  t.note(`панель: собственная команда sub в консоль → ${own.status}`);

  assert.deepEqual(
    { create: created.status, run: run.status, commandSent: sent.includes(COMMAND) },
    { create: 200, run: 200, commandSent: true },
  );
});
