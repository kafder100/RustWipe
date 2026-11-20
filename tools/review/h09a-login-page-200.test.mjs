/**
 * Ревью RustWipe, гипотеза 9 (раздел 4.2), утверждение H9a.
 *
 * Что проверяем. Доступ к серверу плагин проверяет запросом
 * GET {panelUrl}/api/servers/:id с cookie пользователя и верит любому ответу
 * с кодом 2xx (index.js:102-106, `return response.ok`). Если panelUrl указывает
 * не на API панели (на страницу приложения, на вход через SSO и т. п.), там на
 * любой путь отвечает страница входа с кодом 200 — и доступ получает любой.
 * На стандартной установке API панели так не отвечает (там 401/403/404 JSON),
 * поэтому это случай неверного panelUrl.
 *
 * Как должно быть (вопрос 19, ответ владельца «Нет, только сама панель»; по
 * умолчанию: доступ — по разобранному ответу панели, а не по коду 200):
 * страница входа не даёт доступа. Чужой не видит статус и файлы, не создаёт
 * профиль, файлы остаются на месте.
 *
 * Запуск: node tools/review/h09a-login-page-200.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const refused = (res) => res.status >= 400 && res.status < 500;

test('H9a: ответ 200 со страницей входа не считается доступом к серверу', async (t) => {
  const sb = createSandbox();
  await sb.load();
  // Контроль: на обычной панели (ответ 403 JSON) чужому отказ.
  const control = await sb.call('stranger', 'GET', '/servers/srv1/status');
  // panelUrl ведёт не на API: на все запросы отвечает страница входа с кодом 200.
  sb.panel.setAccess('login-200', { scope: 'all' });
  // Сервер выключен (например, на ночь) — плагину не нужно его останавливать.
  sb.panel.setStatus('srv1', 'stopped');
  const before = sb.tree.snapshot();

  const status = await sb.call('stranger', 'GET', '/servers/srv1/status');
  const files = await sb.call('stranger', 'GET', '/servers/srv1/files', { query: { path: '/server/rust/cfg' } });
  const created = await sb.call('stranger', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Чужой', targets: ['/server/rust/cfg/*'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  const id = created.body?.data?.id;
  const run = id ? await sb.call('stranger', 'POST', `/servers/srv1/profiles/${id}/run`, { body: {} }) : null;
  await sb.idle();

  const check = sb.panel.calls.findLast((call) => call.method === 'GET' && call.path === '/api/servers/srv1');
  const removed = sb.tree.diff(before).removed;
  const seen = (files.body?.data?.entries ?? []).map((entry) => entry.name);
  t.note(`проверка доступа: панель ответила ${check?.status} ${check?.contentType}`);
  t.note(`чужой: статус → ${status.status}, файлы → ${files.status} [${seen.join(', ')}], профиль → ${created.status}, вайп → ${run?.status ?? '—'}`);
  t.note(`удалено [${removed.join(', ')}]`);

  assert.deepEqual(
    {
      controlRefused: refused(control),
      statusRefused: refused(status),
      filesRefused: refused(files),
      createRefused: refused(created),
      removed,
    },
    { controlRefused: true, statusRefused: true, filesRefused: true, createRefused: true, removed: [] },
    'страница входа с кодом 200 дала чужому доступ к серверу',
  );
});
