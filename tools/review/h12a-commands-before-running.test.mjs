/**
 * Ревью RustWipe, гипотеза 12 (раздел 4.2), утверждение H12a:
 * после команды запуска плагин считает сервер запущенным уже на статусе
 * starting и сразу шлёт «команды после запуска» — в сервер, который ещё
 * загружается.
 *
 * Правильное поведение (ответ владельца №8): команды после запуска уходят
 * только после статуса running.
 *
 * Проверка: сервер после запуска 2 минуты висит в starting (startTimeoutSec —
 * 240 с, то есть успевает), потом становится running. Подмена панели
 * записывает, при каком статусе сервера пришла каждая команда консоли.
 *
 * Факты Catalyst v1.89.2: панель ставит starting, как только агент принял
 * команду запуска (routes/servers/power.ts), а команду консоли принимает при
 * любом статусе и сразу отвечает 202 (routes/console-stream.ts). Агент,
 * у которого контейнера ещё нет, команду теряет: «Console input failed»
 * (catalyst-agent/src/websocket_handler/console.rs, handle_console_input).
 * running агент ставит, когда контейнер запущен
 * (websocket_handler/server_lifecycle.rs), — мир Rust в этот момент ещё
 * может загружаться, но это уже выбор владельца: ждать running.
 *
 * Запуск: node tools/review/h12a-commands-before-running.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const COMMANDS = ['oxide.reload *', 'say Вайп завершён'];

test('сервер 2 минуты в starting: команды после запуска уходят только при статусе running', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.behave('srv1', { start: 'slow', startingMs: 120000 });
  const profile = await sb.addProfile({ options: { commandsAfter: COMMANDS } });

  const run = await sb.wipe(profile);
  await sb.idle();

  const sent = sb.panel.console('srv1').filter((item) => COMMANDS.includes(item.command));
  t.note(`история: ok=${run.ok}; команды: ${sent.map((item) => `«${item.command}» при ${item.status}`).join(', ') || 'нет'}`);
  t.note(`статус сервера в конце: ${sb.status()}`);

  assert.equal(sent.length, COMMANDS.length, 'сервер дошёл до running за 2 мин из 4 — все команды должны уйти');
  for (const item of sent) {
    assert.equal(item.status, 'running', `команда «${item.command}» ушла, когда сервер был в статусе ${item.status}`);
  }
});
