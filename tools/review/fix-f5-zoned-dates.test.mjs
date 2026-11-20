/**
 * Исполнитель F5, находки L31-7, L33-9, H13g: вкладка переводила все даты одним
 * смещением пояса панели «на сейчас» (status.clock.offsetMinutes). Дата по
 * другую сторону перехода на летнее или зимнее время показывалась на час
 * не так — и в карточке, и в истории, и во времени шагов.
 *
 * Должно: каждая дата — в своём поясе со смещением на саму дату. Пояс —
 * профиля (вопрос 12 владельца: пояс у каждого профиля), без него — панели.
 * Полная цепочка с настоящим backend в разных TZ — h13g-ui-dst-offset.test.mjs;
 * здесь — то, что зависит только от вкладки (пояс профиля, подпись пояса,
 * неизвестный пояс).
 *
 * Запуск: node tools/review/fix-f5-zoned-dates.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

/** Панель в Берлине, смещение взято 23.10 (летнее, +120), а даты — после 25.10. */
const berlinStatus = () =>
  makeStatus({ clock: { now: '2026-10-23T10:00:00.000Z', timezone: 'Europe/Berlin', offsetMinutes: 120, utcOffset: 'UTC+02:00' } });

const metaLine = (ui, prefix) =>
  ui.find((node) => node.tagName === 'SPAN' && node.textContent.trim().startsWith(prefix))?.textContent.trim() ?? '';

test('L33-9: «Следующий запуск» после перехода на зимнее время — 19:00 по Берлину, а не 20:00', async () => {
  const ui = await setup({
    status: berlinStatus(),
    profiles: [makeProfile({ nextRunAt: '2026-10-29T18:00:00.000Z', lastRunAt: '2026-10-22T17:00:00.000Z' })],
  });
  const next = metaLine(ui, 'Следующий запуск');
  assert.ok(next.includes('29.10.2026 19:00'), `вкладка показывает «${next}»`);
  const last = metaLine(ui, 'Последний:');
  assert.ok(last.includes('22.10.2026 19:00'), `вкладка показывает «${last}»`);
});

test('L31-7: история и время шагов — со смещением на дату прогона', async () => {
  const run = {
    id: 'run_1',
    profileId: 'wipe_1',
    profileName: 'Еженедельный вайп',
    trigger: 'schedule',
    ok: true,
    dryRun: false,
    startedAt: '2026-10-29T18:00:00.000Z',
    deletedCount: 1,
    steps: [{ at: '2026-10-29T18:00:01.250Z', action: 'stop', ok: true, detail: 'сервер остановлен', data: { ms: 5 } }],
  };
  const ui = await setup({ status: berlinStatus(), runs: [run] });
  const row = ui.find((node) => node.tagName === 'TR' && node.parentNode?.tagName === 'TBODY');
  assert.ok(row, 'нет строки истории');
  assert.ok(row.children[0].textContent.startsWith('29.10.2026 19:00'), `в истории «${row.children[0].textContent}»`);
  const clock = ui.find((node) => node.classList.contains('rw-step-clock'));
  assert.equal(clock?.textContent, '19:00:01.250');
});

test('вопрос 12: у профиля свой пояс — его даты в этом поясе, в истории пояс подписан', async () => {
  const profile = makeProfile({
    schedule: { kind: 'weekly', weekday: 4, time: '05:00', timeZone: 'Europe/Moscow' },
    nextRunAt: '2026-11-26T02:00:00.000Z',
  });
  const run = { id: 'run_2', profileId: profile.id, profileName: profile.name, trigger: 'schedule', ok: true, startedAt: '2026-11-19T02:00:00.000Z', steps: [] };
  const ui = await setup({ status: berlinStatus(), profiles: [profile], runs: [run] });
  const next = metaLine(ui, 'Следующий запуск');
  assert.ok(next.includes('26.11.2026 05:00'), `карточка показывает «${next}», а вайп в 05:00 по Москве`);
  const row = ui.find((node) => node.tagName === 'TR' && node.parentNode?.tagName === 'TBODY');
  assert.ok(row.children[0].textContent.includes('19.11.2026 05:00'), `в истории «${row.children[0].textContent}»`);
  assert.ok(row.children[0].textContent.includes('Europe/Moscow'), 'в истории не подписан пояс профиля');
});

test('неизвестный браузеру пояс — без ошибки, по смещению панели, как раньше', async () => {
  const status = makeStatus({ clock: { now: '2026-11-20T10:00:00.000Z', timezone: 'Mars/Olympus', offsetMinutes: 180 } });
  const ui = await setup({ status, profiles: [makeProfile({ nextRunAt: '2026-11-26T02:00:00.000Z' })] });
  assert.ok(metaLine(ui, 'Следующий запуск').includes('26.11.2026 05:00'));
});

test('часы в шапке — время и смещение пояса панели на сейчас', async () => {
  const ui = await setup({ status: berlinStatus() });
  const chip = ui.find((node) => node.getAttribute('data-rw-clock') !== null);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName === 'GMT+2' ? 'UTC+02:00' : 'UTC+01:00';
  assert.ok(chip.textContent.endsWith(offset), `часы в шапке: «${chip.textContent}», ожидалось смещение ${offset}`);
});
