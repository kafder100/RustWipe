/**
 * Исправление F2a (находка L33-1): выключатель schedulerEnabled действует сразу.
 *
 * Панель Catalyst при сохранении настроек плагина только вызывает setConfig —
 * без перезапуска плагина (routes/plugins.ts v1.89.2). Было: выключатель
 * проверялся только в onEnable — выключенный в настройках планировщик всё
 * равно вайпал по расписанию, а включённый не работал до перезапуска, хотя
 * вкладка показывала обратное. Должно: тик сам читает выключатель каждый раз.
 *
 * Запуск: node tools/review/fix-f2a-scheduler-toggle.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const power = (sb) => sb.panel.calls.filter((call) => call.method === 'POST' && /\/(stop|start)$/.test(call.path)).length;

test('выключили в настройках — плановый вайп и предупреждения не идут; включили — идут без перезапуска', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T04:57:00.050Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z' });
  await sb.load({ enable: true });
  await sb.idle();

  await sb.ctx.setConfig('schedulerEnabled', false);
  const status = await sb.call('admin', 'GET', '/servers/srv1/status');
  for (const at of ['2026-11-19T04:58:00.050Z', '2026-11-19T04:59:00.050Z', '2026-11-19T05:00:00.050Z']) {
    await sb.clock.advance(Date.parse(at) - sb.clock.now());
    await sb.tick();
  }
  await sb.idle();
  const off = { runs: sb.runs().length, power: power(sb), say: sb.panel.console('srv1').length };

  await sb.ctx.setConfig('schedulerEnabled', true);
  // Включили в 05:01: срок прошёл, а отсчёта не было — догон с отсчётом, вайп в 05:06.
  for (let minute = 1; minute <= 6; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();
  const sayOn = sb.panel.console('srv1').length - off.say;
  t.note(`вкладка: schedulerEnabled=${status.body.data.schedulerEnabled}; выключен: ${JSON.stringify(off)}; включили: предупреждений ${sayOn}, прогонов ${sb.runs().length}, питание ${power(sb)}`);

  assert.equal(status.body.data.schedulerEnabled, false);
  // Первый тик onEnable был ещё при включённом планировщике — одно предупреждение «через 3 мин» могло уйти раньше.
  assert.deepEqual({ runs: off.runs, power: off.power }, { runs: 0, power: 0 });
  assert.ok(off.say <= 1, `после выключения ушли предупреждения: ${off.say}`);
  assert.equal(sayOn, 5, 'после включения — обычный отсчёт');
  assert.equal(sb.runs().length, 1, 'после включения пропущенный в окне догона вайп идёт');
  assert.equal(power(sb), 2);
});

test('плагин включён при выключенном планировщике: задача всё равно стоит и начинает работать после включения', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z', config: { schedulerEnabled: false } });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load({ enable: true });
  await sb.idle();
  const tasks = sb.tasks.size;
  const before = sb.runs().length;
  await sb.ctx.setConfig('schedulerEnabled', true);
  await sb.clock.advance(60000);
  await sb.tick(); // это задача, которую поставил onEnable (sb.tasks), а не прямой вызов runTick
  await sb.idle();
  t.note(`задач после onEnable: ${tasks}; прогонов до включения ${before}, после ${sb.runs().length}`);
  assert.equal(tasks, 1);
  assert.equal(before, 0);
  assert.equal(sb.runs().length, 1);
});
