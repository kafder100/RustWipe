/**
 * Исполнитель P4, находка L33-8 (часть вкладки).
 *
 * Backend записывает пропущенный плановый вайп в профиль (lastSkippedAt,
 * lastSkipReason) и отдаёт эти поля в GET …/profiles, но вкладка их не
 * показывала: пропуск был виден только в ответе API и в журнале панели.
 *
 * Должно: в карточке профиля строка «Пропущен: <дата> — <причина>»; дата —
 * в поясе профиля, как остальные даты карточки. Полей нет — строки нет.
 *
 * Запуск: node tools/review/post-p4-skip-card.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, setup, test } from './fix-f5-ui-lib.mjs';

const REASON =
  'Плановый вайп пропущен: срок прошёл 180 мин назад, а догонять можно не дольше 120 мин (настройка catchUpMinutes)';
const cardText = (ui) => ui.find((node) => node.classList.contains('rw-card'))?.textContent ?? '';

test('L33-8: пропущенный вайп виден в карточке — дата и причина', async () => {
  const ui = await setup({
    profiles: [makeProfile({ lastSkippedAt: '2026-11-19T05:15:00.000Z', lastSkipReason: REASON })],
  });
  assert.ok(cardText(ui).includes(`Пропущен: 19.11.2026 05:15 — ${REASON}`), cardText(ui));
});

test('L33-8: дата пропуска — в поясе профиля, как другие даты карточки', async () => {
  const profile = makeProfile({ lastSkippedAt: '2026-11-19T05:15:00.000Z', lastSkipReason: REASON });
  profile.schedule = { ...profile.schedule, timeZone: 'Europe/Moscow' };
  const ui = await setup({ profiles: [profile] });
  assert.ok(cardText(ui).includes('Пропущен: 19.11.2026 08:15 — '), cardText(ui));
});

test('L33-8: причины нет — только дата', async () => {
  const ui = await setup({ profiles: [makeProfile({ lastSkippedAt: '2026-11-19T05:15:00.000Z', lastSkipReason: null })] });
  assert.ok(cardText(ui).includes('Пропущен: 19.11.2026 05:15'), cardText(ui));
  assert.ok(!cardText(ui).includes('Пропущен: 19.11.2026 05:15 —'), cardText(ui));
});

test('пропусков не было (полей нет) — строки «Пропущен» нет', async () => {
  const ui = await setup();
  assert.ok(!cardText(ui).includes('Пропущен'), cardText(ui));
});
