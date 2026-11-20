/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8d.
 *
 * Что проверяем. Кнопка «Определить из шаблона» зовёт роут map-variables.
 * Плагин читает переменные шаблона ключом из настроек и отдаёт во вкладку все
 * значения (index.js:344-366), в том числе пароль RCON. Вкладке нужны только
 * имена переменных и какие из них сид и размер.
 *
 * Как должно быть (ответ владельца на вопрос 18: «Нет, только сид и размер»):
 * значения — только у сида и размера, у остальных переменных — одни имена.
 * Пароля RCON в ответе нет.
 *
 * Запуск: node tools/review/h08d-map-variables-values.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultUsers, test } from './sandbox.mjs';

const SECRET = 'rcon-sandbox-secret'; // значение RCON_PASS у srv1 в песочнице
const ALL_NAMES = ['SERVER_HOSTNAME', 'WORLD_SEED', 'WORLD_SIZE', 'MAX_PLAYERS', 'RCON_PASS'];
const isMapVar = (name) => /SEED|SIZE/i.test(name);
const hasValue = (item) =>
  ['value', 'default', 'current'].some((key) => item[key] !== undefined && item[key] !== null && String(item[key]) !== '');

test('H8d: map-variables не отдаёт значения переменных, кроме сида и размера', async (t) => {
  const users = {
    ...defaultUsers(),
    // Субпользователь с одним console.read и ролью плагина «управление».
    helper: {
      id: 'user_helper',
      username: 'helper',
      email: 'helper@panel.test',
      permissions: ['rust-autowipe.manage'],
      session: 'sess_helper',
      serverAccess: { srv1: ['console.read'] },
    },
  };
  const sb = createSandbox({ users });
  await sb.load();

  const res = await sb.call('owner', 'GET', '/servers/srv1/map-variables');
  const variables = res.body?.data?.variables ?? [];
  const withValues = variables.filter((item) => !isMapVar(item.name) && hasValue(item)).map((item) => item.name);
  t.note(`владелец: map-variables → ${res.status}; значения есть у [${withValues.join(', ')}]; пароль RCON в ответе: ${res.text.includes(SECRET)}`);

  // Для понимания: тот же ответ получает субпользователь с одним console.read.
  const helperRes = await sb.call('helper', 'GET', '/servers/srv1/map-variables');
  const asHelper = { cookie: 'better-auth.session_token=sess_helper' };
  const panelVars = await sb.run(fetch(`${sb.panel.base}/api/servers/srv1/variables`, { headers: asHelper }));
  const panelServer = await sb.run(fetch(`${sb.panel.base}/api/servers/srv1`, { headers: asHelper }));
  const panelServerText = await panelServer.text();
  t.note(
    `helper (console.read): map-variables → ${helperRes.status}, пароль в ответе: ${helperRes.text.includes(SECRET)}; ` +
      `панель: GET /variables → ${panelVars.status}, GET /api/servers/srv1 → ${panelServer.status}, пароль в нём: ${panelServerText.includes(SECRET)}`,
  );

  assert.deepEqual(
    {
      status: res.status,
      names: variables.map((item) => item.name),
      detected: res.body?.data?.detected,
      otherVarsWithValues: withValues,
      rconSecretInResponse: res.text.includes(SECRET),
    },
    {
      status: 200,
      names: ALL_NAMES,
      detected: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
      otherVarsWithValues: [],
      rconSecretInResponse: false,
    },
    'роут отдал значения переменных шаблона, кроме сида и размера',
  );
});
