/**
 * Ревью RustWipe, гипотеза 9 (раздел 4.2), утверждение H9b.
 *
 * Что проверяем. Проверка доступа (index.js:102-106) вызывает fetch без
 * redirect: 'manual', поэтому fetch идёт по переходам. Если по адресу panelUrl
 * стоит что-то, что отвечает переходом 302 на страницу входа (вход через SSO,
 * прокси перед панелью), fetch доходит до этой страницы, получает 200 — и
 * плагин считает, что доступ есть. Сам backend Catalyst переходов не делает,
 * так что это тоже случай panelUrl не на API панели.
 *
 * Как должно быть (вопрос 19, ответ владельца «Нет, только сама панель»; по
 * умолчанию: переходы при проверке доступа не принимаются): переход — это отказ.
 * Чужой не видит статус и файлы сервера.
 *
 * Запуск: node tools/review/h09b-redirect-accepted.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const refused = (res) => res.status >= 400 && res.status < 500;

test('H9b: переход 302 на страницу входа не считается доступом к серверу', async (t) => {
  const sb = createSandbox();
  await sb.load();
  // Контроль: на обычной панели чужому отказ.
  const control = await sb.call('stranger', 'GET', '/servers/srv1/status');

  // 1) Переход на страницу входа того же адреса.
  sb.panel.setAccess('redirect-302');
  const sameStatus = await sb.call('stranger', 'GET', '/servers/srv1/status');
  const sameFiles = await sb.call('stranger', 'GET', '/servers/srv1/files', { query: { path: '/server/rust/cfg' } });
  const sameHops = sb.panel.calls.slice(-2).map((call) => `${call.path} ${call.status}`);

  // 2) Переход на страницу входа другого адреса (SSO).
  sb.panel.addOrigin('https://sso.test');
  sb.panel.setAccess('redirect-302', { loginOrigin: 'https://sso.test' });
  const ssoStatus = await sb.call('stranger', 'GET', '/servers/srv1/status');
  const ssoHops = sb.panel.calls.slice(-2).map((call) => `${call.origin}${call.path} ${call.status}${call.cookie ? ' [cookie]' : ''}`);

  t.note(`тот же адрес: шаги [${sameHops.join(' → ')}]; статус → ${sameStatus.status}, файлы → ${sameFiles.status}`);
  t.note(`SSO: шаги [${ssoHops.join(' → ')}]; статус → ${ssoStatus.status}`);

  assert.deepEqual(
    {
      controlRefused: refused(control),
      sameOriginStatusRefused: refused(sameStatus),
      sameOriginFilesRefused: refused(sameFiles),
      ssoStatusRefused: refused(ssoStatus),
    },
    { controlRefused: true, sameOriginStatusRefused: true, sameOriginFilesRefused: true, ssoStatusRefused: true },
    'переход на страницу входа дал чужому доступ к серверу',
  );
});
