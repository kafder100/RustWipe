/**
 * Исправление F2a (находка L33-7): догон пропущенного вайпа — с отсчётом в чате.
 *
 * Было: панель лежала во время планового срока и поднялась в окне догона —
 * первый же тик останавливал сервер, на котором играют, без единого
 * «Вайп сервера через N мин» (README обещает предупреждения за 5…1 минуту).
 * Должно: сначала обычный отсчёт (wipeWarningMinutes), потом вайп — один раз;
 * следующий срок — по серии от настоящего планового срока.
 *
 * Запуск: node tools/review/fix-f2a-catchup-countdown.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const WEEKLY = { kind: 'weekly', weekday: 4, time: '19:00', timeZone: 'UTC' };
const say = (sb) => sb.panel.console('srv1').filter((item) => item.command.startsWith('say ')).map((item) => item.command.replace(/^say /, ''));
const firstStopAt = (sb) => sb.panel.calls.find((call) => call.method === 'POST' && call.path === '/api/servers/srv1/stop');

test('панель поднялась в 19:30 после срока 19:00: отсчёт 5…1 мин, вайп в 19:35, следующий — через неделю в 19:00', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T19:30:00.050Z' });
  await sb.addProfile({ schedule: WEEKLY, nextRunAt: '2026-11-19T19:00:00.000Z' });
  await sb.load({ enable: true }); // onEnable сразу делает тик
  await sb.idle();
  const afterRestart = { ...sb.profiles()[0] };
  for (let minute = 1; minute <= 5; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();
  const stop = firstStopAt(sb);
  const profile = sb.profiles()[0];
  t.note(`после подъёма: nextRunAt ${afterRestart.nextRunAt}, catchUpOf ${afterRestart.catchUpOf}; чат: ${say(sb).join(' | ')}`);
  t.note(`вайп начался ${sb.runs()[0]?.startedAt}; первая остановка: ${stop ? 'была' : 'нет'}; прогонов ${sb.runs().length}; следующий ${profile.nextRunAt}, catchUpOf ${profile.catchUpOf}`);

  assert.equal(afterRestart.nextRunAt, '2026-11-19T19:35:00.000Z');
  assert.equal(afterRestart.catchUpOf, '2026-11-19T19:00:00.000Z');
  assert.deepEqual(say(sb), [1, 2, 3, 4, 5].reverse().map((minutes) => `Вайп сервера через ${minutes} мин`));
  assert.equal(sb.runs().length, 1);
  assert.ok(Date.parse(sb.runs()[0].startedAt) >= Date.parse('2026-11-19T19:35:00.000Z'), 'вайп — после отсчёта');
  assert.equal(profile.nextRunAt, '2026-11-26T19:00:00.000Z', 'серия — от настоящего срока 19:00');
  assert.equal(profile.catchUpOf, null);
});

test('отсчёт не нужен (предупреждения у профиля выключены) — догон сразу, как раньше', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T19:30:00.050Z' });
  await sb.addProfile({ schedule: WEEKLY, nextRunAt: '2026-11-19T19:00:00.000Z', options: { warnChat: false } });
  await sb.load();
  await sb.tick();
  await sb.idle();
  t.note(`прогонов ${sb.runs().length}, чат ${say(sb).length}, следующий ${sb.profiles()[0].nextRunAt}`);
  assert.equal(sb.runs().length, 1);
  assert.equal(say(sb).length, 0);
  assert.equal(sb.profiles()[0].nextRunAt, '2026-11-26T19:00:00.000Z');
});

test('во время отсчёта догона админ запустил вайп вручную — догон второй раз не идёт', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T19:30:00.050Z' });
  const profile = await sb.addProfile({ schedule: WEEKLY, nextRunAt: '2026-11-19T19:00:00.000Z' });
  await sb.load();
  await sb.tick(); // 19:30 — отсчёт до 19:35
  await sb.clock.advance(60000);
  const manual = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.idle();
  for (let minute = 0; minute < 5; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();
  const stored = sb.profiles()[0];
  t.note(`ручной → ${manual.status}; прогоны: ${sb.runs().map((run) => run.trigger).join(', ')}; следующий ${stored.nextRunAt}, catchUpOf ${stored.catchUpOf}`);
  assert.equal(manual.status, 200);
  assert.deepEqual(sb.runs().map((run) => run.trigger), ['manual']);
  assert.equal(stored.nextRunAt, '2026-11-26T19:00:00.000Z');
  assert.equal(stored.catchUpOf, null);
});

test('время после отсчёта прошло, пока сервер был занят: вайп идёт один раз, без второго отсчёта', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T19:30:00.050Z' });
  await sb.addProfile({ schedule: WEEKLY, nextRunAt: '2026-11-19T19:00:00.000Z' });
  await sb.load();
  await sb.tick(); // 19:30 — отсчёт до 19:35
  // Панель снова недоступна до 19:38: тиков нет.
  await sb.clock.advance(Date.parse('2026-11-19T19:38:00.050Z') - sb.clock.now());
  await sb.tick();
  await sb.idle();
  t.note(`чат: ${say(sb).join(' | ')}; прогонов ${sb.runs().length}; следующий ${sb.profiles()[0].nextRunAt}`);
  assert.equal(sb.runs().length, 1);
  assert.deepEqual(say(sb), ['Вайп сервера через 5 мин']);
  assert.equal(sb.profiles()[0].nextRunAt, '2026-11-26T19:00:00.000Z');
});
