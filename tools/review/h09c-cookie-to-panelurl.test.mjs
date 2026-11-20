/**
 * Ревью RustWipe, гипотеза 9 (раздел 4.2), утверждение H9c.
 *
 * Что проверяем. Для проверки доступа плагин пересылает cookie пользователя
 * (и заголовок Authorization, если человек пришёл с личным ключом) на адрес
 * panelUrl из настроек (index.js:93-105, api.js:13-20). Адрес плагин не
 * проверяет: если в настройках стоит не сама панель (опечатка, другой хост,
 * http без шифрования), сессия субпользователя уходит туда. У админа и
 * владельца сервера запроса нет — у них доступ решается без панели.
 *
 * Как должно быть (вопрос 19, ответ владельца «Нет, только сама панель»; по
 * умолчанию: cookie пользователя уходят только на саму панель): на чужой
 * адрес не уходят ни cookie, ни личный ключ пользователя.
 *
 * Запуск: node tools/review/h09c-cookie-to-panelurl.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const ELSEWHERE = 'https://elsewhere.test';
const USER_KEY = 'Bearer catalyst_sub_personal_key';

test('H9c: cookie и личный ключ пользователя не уходят на адрес panelUrl, если это не панель', async (t) => {
  const seen = [];
  const sb = createSandbox({ config: { panelUrl: ELSEWHERE } });
  sb.panel.host(ELSEWHERE, (request) => {
    seen.push(request);
    return {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  });
  await sb.load();

  const withCookie = await sb.call('sub', 'GET', '/servers/srv1/status');
  const withKey = await sb.call('sub', 'GET', '/servers/srv1/status', { cookie: false, authorization: USER_KEY });

  const leaked = seen
    .filter((request) => /sess_sub/.test(request.headers.cookie ?? '') || request.headers.authorization === USER_KEY)
    .map((request) => `${request.method} ${request.url}${request.headers.cookie ? ' [cookie]' : ''}${request.headers.authorization ? ' [authorization]' : ''}`);
  t.note(`panelUrl = ${ELSEWHERE}; ответы роута: с cookie → ${withCookie.status}, с ключом → ${withKey.status}`);
  t.note(`на чужой адрес ушло: [${leaked.join(', ')}]`);

  assert.deepEqual(leaked, [], 'учётные данные пользователя ушли на адрес, который не является панелью');
});
