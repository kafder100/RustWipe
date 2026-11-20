/**
 * Ревью RustWipe, гипотеза 12 (раздел 4.2), утверждение H12b:
 * плагин засчитывает запуск по статусу starting. Если сервер так и не
 * становится running (завис в загрузке или упал при запуске), история пишет
 * «успешно», а команды после запуска всё равно уходят.
 *
 * Правильное поведение (ответ владельца №8): если running не дождались за
 * startTimeoutSec — команды не уходят, в истории ошибка.
 *
 * Факты Catalyst v1.89.2: неудачный запуск агент сообщает статусом error,
 * падение процесса — crashed (catalyst-agent/src/websocket_handler/
 * server_lifecycle.rs); панель до этого уже показывает starting. Плагин
 * смотрит статус один раз сразу после команды запуска и видит starting.
 *
 * Запуск: node tools/review/h12b-not-running-is-success.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const COMMANDS = ['oxide.reload *', 'say Вайп завершён'];

async function wipeWithStart(t, behavior) {
  const sb = createSandbox();
  await sb.load();
  sb.panel.behave('srv1', behavior);
  const profile = await sb.addProfile({ options: { commandsAfter: COMMANDS } });
  await sb.wipe(profile);
  await sb.idle();
  const res = await sb.call('admin', 'GET', '/servers/srv1/runs');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [last] = res.body.data;
  const sent = sb.panel.console('srv1').filter((item) => COMMANDS.includes(item.command));
  t.note(
    `история: ok=${last?.ok}, ошибки: ${(last?.errors || []).join(' | ') || 'нет'}; ` +
      `команды: ${sent.map((item) => `«${item.command}» при ${item.status}`).join(', ') || 'не ушли'}; ` +
      `статус сервера в конце: ${sb.status()}`,
  );
  return { last, sent };
}

test('сервер завис в starting дольше startTimeoutSec: в истории ошибка, команды не уходят', async (t) => {
  const { last, sent } = await wipeWithStart(t, { start: 'stuck' });
  assert.ok(last, 'прогон должен быть в истории');
  assert.equal(last.ok, false, 'сервер так и не стал running — прогон не может считаться успешным');
  assert.deepEqual(sent, [], 'команды после запуска не должны уходить в незапущенный сервер');
});

test('сервер упал при загрузке (starting → crashed): в истории ошибка, команды не уходят', async (t) => {
  const { last, sent } = await wipeWithStart(t, { start: 'crash', startMs: 5000 });
  assert.ok(last, 'прогон должен быть в истории');
  assert.equal(last.ok, false, 'сервер упал при запуске — прогон не может считаться успешным');
  assert.deepEqual(sent, [], 'команды после запуска не должны уходить в сервер, который не дошёл до running');
});
