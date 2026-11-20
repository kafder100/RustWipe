/**
 * Исправление F3: тесты на «каждые N дней» с N ≠ 7 (находка L34-6).
 *
 * Было: единственный тест интервала брал N = 7 и точку отсчёта ровно за две
 * недели до даты проверки. Поэтому он проходил и с поломкой «точка отсчёта не
 * учитывается», и с поломкой «шаг всегда 7 дней».
 * Здесь: N = 10 и N = 3, точка отсчёта 01.11.2026, от неё до даты проверки
 * не кратно N. Обе поломки дают другие даты, и тест падает.
 *
 * Запуск: node tools/review/fix-f3-interval-step.test.mjs
 * Проверки идут у себя и ещё раз в дочерних node с TZ=UTC, Europe/Moscow и
 * America/New_York. Расчёт — чистая функция, часы не нужны.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { runNode, test } from './sandbox.mjs';
import { nextOccurrence, normalizeSchedule } from '../../rust-autowipe/backend/lib/schedule.js';

const ZONES = ['UTC', 'Europe/Moscow', 'America/New_York'];
const CHILD = process.env.RW_F3_CHILD === '1';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
function fmtLocal(value) {
  const d = new Date(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const every = (intervalDays, anchorDate, timeZone = '') =>
  normalizeSchedule({ kind: 'interval', intervalDays, time: '05:00', anchorDate, timeZone });

test('без пояса: каждые 10 дней от 01.11 — 11.11, 21.11, 01.12', () => {
  const s = every(10, '2026-11-01');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 11, 15, 12, 0))), '2026-11-21 05:00');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 11, 21, 4, 59))), '2026-11-21 05:00', 'в день серии до времени — сегодня');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 11, 21, 5, 0))), '2026-12-01 05:00', 'ровно в 05:00 — уже следующий');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 10, 20, 0, 0))), '2026-11-01 05:00', 'до точки отсчёта — сама точка отсчёта');
});

test('без пояса: каждые 3 дня от 01.11 — 16.11, затем 19.11', () => {
  const s = every(3, '2026-11-01');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 11, 15, 12, 0))), '2026-11-16 05:00');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 11, 16, 5, 0))), '2026-11-19 05:00');
  // Через конец месяца и года: 01.11 + 3k — …, 28.11, 01.12, …, 31.12, 03.01.
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 11, 29, 0, 0))), '2026-12-01 05:00');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 12, 30, 0, 0))), '2026-12-31 05:00');
  assert.equal(fmtLocal(nextOccurrence(s, local(2026, 12, 31, 5, 0))), '2027-01-03 05:00');
});

test('без пояса: точка отсчёта в будущем — первый вайп в этот день', () => {
  assert.equal(fmtLocal(nextOccurrence(every(10, '2026-12-05'), local(2026, 11, 15, 12, 0))), '2026-12-05 05:00');
});

test('с поясом профиля: те же дни в поясе Europe/Moscow', () => {
  const s10 = every(10, '2026-11-01', 'Europe/Moscow');
  const s3 = every(3, '2026-11-01', 'Europe/Moscow');
  const after = new Date('2026-11-15T09:00:00Z'); // 12:00 по Москве
  assert.equal(nextOccurrence(s10, after).toISOString(), '2026-11-21T02:00:00.000Z');
  assert.equal(nextOccurrence(s3, after).toISOString(), '2026-11-16T02:00:00.000Z');
  assert.equal(nextOccurrence(s3, new Date('2026-11-16T02:00:00Z')).toISOString(), '2026-11-19T02:00:00.000Z');
  assert.equal(nextOccurrence(every(10, '2026-12-05', 'Europe/Moscow'), after).toISOString(), '2026-12-05T02:00:00.000Z');
});

if (!CHILD) {
  for (const zone of ZONES) {
    test(
      `те же проверки при TZ=${zone}`,
      async () => {
        const result = await runNode({ file: fileURLToPath(import.meta.url), tz: zone, env: { RW_F3_CHILD: '1' } });
        assert.equal(result.code, 0, `дочерний процесс TZ=${zone} провалился:\n${result.stdout}\n${result.stderr}`);
      },
      { timeoutMs: 60000 },
    );
  }
}
