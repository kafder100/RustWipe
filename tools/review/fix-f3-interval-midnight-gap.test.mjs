/**
 * Исправление F3: «каждые N дней» через перевод часов в полночь (находка H13b,
 * узкий край, найденный перепроверкой).
 *
 * В поясах America/Nuuk и America/Scoresbysund весной часы переводят в субботу
 * в 23:00 сразу на 00:00 воскресенья. Пояс у профиля не задан — время считается
 * в поясе панели по правилам Date: несуществующее «сб 23:30» становится
 * «вс 00:30». Было: следующий день серии считался от этого воскресенья, и
 * «каждые 7 дн., 23:30» навсегда уходил с субботы на воскресенье, а «каждый
 * день, 23:30» терял вайп воскресенья.
 * Должно быть: дни серии считаются от точки отсчёта — один сдвинутый запуск,
 * дальше прежний день недели и ни одного пропуска.
 *
 * Запуск: node tools/review/fix-f3-interval-midnight-gap.test.mjs
 * Проверки идут в дочерних node с TZ=America/Nuuk и America/Scoresbysund
 * (пояс панели — это пояс процесса). Часы не нужны: расчёт — чистая функция.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { runNode, test } from './sandbox.mjs';
import { nextOccurrence, normalizeSchedule } from '../../rust-autowipe/backend/lib/schedule.js';

const ZONES = ['America/Nuuk', 'America/Scoresbysund'];
const CHILD = process.env.RW_F3_CHILD === '1';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
function fmtLocal(value) {
  const d = new Date(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Цепочка запусков: каждый следующий — сразу после предыдущего (как тик после вайпа). */
function chain(schedule, from, count) {
  const out = [];
  let after = from;
  for (let index = 0; index < count; index += 1) {
    const next = nextOccurrence(schedule, after);
    out.push(fmtLocal(next));
    after = new Date(next.getTime() + 60000);
  }
  return out;
}

if (CHILD) {
  test('предусловие: в этом поясе «сб 28.03.2026 23:30» нет — Date даёт вс 00:30', () => {
    assert.equal(fmtLocal(local(2026, 3, 28, 23, 30)), '2026-03-29 00:30');
  });

  test('«каждые 7 дн., 23:30» от субботы: после перевода часов — снова суббота', () => {
    const schedule = normalizeSchedule({ kind: 'interval', intervalDays: 7, time: '23:30', anchorDate: '2026-03-14' });
    assert.deepEqual(chain(schedule, local(2026, 3, 20, 12, 0), 5), [
      '2026-03-21 23:30',
      '2026-03-29 00:30', // сб 28.03 23:30 нет: запуск сразу после перевода часов
      '2026-04-04 23:30',
      '2026-04-11 23:30',
      '2026-04-18 23:30',
    ]);
  });

  test('«каждый день, 23:30»: после перевода часов ни один день не пропущен', () => {
    const schedule = normalizeSchedule({ kind: 'interval', intervalDays: 1, time: '23:30', anchorDate: '2026-03-01' });
    assert.deepEqual(chain(schedule, local(2026, 3, 27, 12, 0), 4), [
      '2026-03-27 23:30',
      '2026-03-29 00:30', // это запуск субботы 28.03
      '2026-03-29 23:30', // воскресенье на месте
      '2026-03-30 23:30',
    ]);
  });

  test('«каждые 3 дн., 23:45»: серия от точки отсчёта не съезжает через перевод часов', () => {
    // 28.03 — день серии (07.03 + 21 день).
    const schedule = normalizeSchedule({ kind: 'interval', intervalDays: 3, time: '23:45', anchorDate: '2026-03-07' });
    assert.deepEqual(chain(schedule, local(2026, 3, 26, 0, 0), 3), ['2026-03-29 00:45', '2026-03-31 23:45', '2026-04-03 23:45']);
  });

  test('контроль: с поясом профиля серия и так держится (момент перевода часов)', () => {
    const zone = process.env.TZ;
    const schedule = normalizeSchedule({ kind: 'interval', intervalDays: 7, time: '23:30', anchorDate: '2026-03-14', timeZone: zone });
    assert.deepEqual(chain(schedule, local(2026, 3, 20, 12, 0), 3), ['2026-03-21 23:30', '2026-03-29 00:00', '2026-04-04 23:30']);
  });
} else {
  for (const zone of ZONES) {
    test(
      `TZ=${zone}`,
      async () => {
        const result = await runNode({ file: fileURLToPath(import.meta.url), tz: zone, env: { RW_F3_CHILD: '1' } });
        assert.equal(result.code, 0, `дочерний процесс TZ=${zone} провалился:\n${result.stdout}\n${result.stderr}`);
      },
      { timeoutMs: 60000 },
    );
  }
}
