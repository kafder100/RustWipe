/**
 * Исправление F2b: «сервер запущен» — только статус running
 * (находки H12a, H12b; договорённость К4).
 *
 * Что проверяем (дополнительно к тестам нашедших h12a и h12b):
 *   1) сервер после запуска сразу снова stopped — прогон неудачный сразу,
 *      без ожидания 240 с, команды после запуска не уходят;
 *   2) подъём сервера после ошибки вайпа тоже ждёт running: сервер упал при
 *      запуске — в истории ошибка, а не «сервер запущен»;
 *   3) удачный подъём после ошибки записан со статусом running.
 *
 * Запуск: node tools/review/fix-f2b-running-only.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const COMMANDS = ['say Вайп завершён'];
const NOTHING = ['/server/*/proceduralmap.9999.*.map'];

test('сервер после запуска сразу снова stopped: прогон неудачный без ожидания 240 с, команды не ушли', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.behave('srv1', { start: 'never', startMs: 5000 });
  const profile = await sb.addProfile({ options: { commandsAfter: COMMANDS, warnChat: false } });
  const startedAt = sb.clock.now();
  const run = await sb.wipe(profile);
  const tookSec = Math.round((sb.clock.now() - startedAt) / 1000);
  t.note(`прогон: ok=${run.ok}; ошибки: ${run.errors.join(' | ')}; занял ${tookSec} с`);
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('не дошёл до running')));
  assert.ok(tookSec < 60, `ждали ${tookSec} с, хотя сервер уже остановился`);
  assert.deepEqual(sb.panel.console('srv1').map((item) => item.command), [], 'команды не уходят');
});

test('подъём после ошибки ждёт running: сервер упал при запуске — в истории ошибка', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.panel.behave('srv1', { start: 'crash', startMs: 5000 });
  const profile = await sb.addProfile({ targets: NOTHING, options: { warnChat: false } });
  const run = await sb.wipe(profile);
  const restore = run.steps.find((step) => step.action === 'restore-start');
  t.note(`шаг подъёма: ok=${restore?.ok}, ${restore?.detail}; ошибки: ${run.errors.join(' | ')}`);
  assert.ok(restore, 'сервер пытались поднять');
  assert.equal(restore.ok, false, 'сервер упал при запуске — подъём не удался');
  assert.ok(run.errors.some((error) => error.startsWith('Не удалось запустить сервер после ошибки') && error.includes('crashed')));
});

test('удачный подъём после ошибки записан со статусом running', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ targets: NOTHING, options: { warnChat: false } });
  const run = await sb.wipe(profile);
  const restore = run.steps.find((step) => step.action === 'restore-start');
  t.note(`шаг подъёма: ok=${restore?.ok}, ${restore?.detail}, статус ${restore?.data?.status}`);
  assert.equal(restore?.ok, true);
  assert.equal(restore.data.status, 'running');
  assert.equal(sb.status(), 'running');
});
