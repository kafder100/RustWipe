/**
 * Исполнитель P4, регрессии R2-2 и R4-1 (в сводке — R-2).
 *
 * Запись прогона теперь появляется в истории в самом начале вайпа: status
 * 'running', поля ok ещё нет. Вкладка смотрела только на ok — и идущий вайп
 * весь прогон горел красным «ошибка» с «Удалено: 0», а у проверки было
 * «проверка: ошибка». Запись, которую закрыли после падения панели
 * (status 'interrupted'), тоже была просто «ошибка».
 *
 * Должно: значок — по status записи: running — «идёт», interrupted —
 * «прерван», ok — «успешно», failed — «ошибка»; у проверки — «проверка: …».
 * У идущего прогона в «Удалено» — «—»: итога ещё нет. Записи старых версий
 * (без status) — по ok, как раньше.
 *
 * Запуск: node tools/review/post-p4-history-status.test.mjs
 */

import assert from 'node:assert/strict';
import { find, setup, test } from './fix-f5-ui-lib.mjs';

let seq = 0;
function record(overrides = {}) {
  seq += 1;
  return {
    id: `run_${seq}`,
    profileId: 'wipe_1',
    profileName: 'Еженедельный вайп',
    serverId: 'srv1',
    trigger: 'manual',
    dryRun: false,
    startedAt: `2026-11-19T05:${String(seq).padStart(2, '0')}:00.000Z`,
    steps: [{ at: '2026-11-19T05:00:01.000Z', action: 'server', ok: true, detail: 'Rust EU #1 · статус running' }],
    ...overrides,
  };
}

/** Строки истории в том же порядке: текст значка, его цвет и столбец «Удалено». */
async function historyRows(runs) {
  const ui = await setup({ runs });
  return ui
    .findAll((node) => node.tagName === 'TR' && node.parentNode?.tagName === 'TBODY')
    .map((row) => {
      const badge = find(row, (node) => node.classList.contains('rw-badge'));
      return {
        badge: badge?.textContent.trim(),
        kind: ['ok', 'bad', 'warn'].find((name) => badge?.classList.contains(name)) || '',
        deleted: row.children[4]?.textContent.trim(),
      };
    });
}

test('R-2: идущий вайп (status running, ok ещё нет) — «идёт», а не красная «ошибка»; «Удалено» — «—»', async () => {
  const [row] = await historyRows([record({ status: 'running', stoppedByUs: true, deleted: [], deletedCount: 0 })]);
  assert.equal(row.badge, 'идёт', `значок идущего вайпа: «${row.badge}»`);
  assert.equal(row.kind, 'warn', `цвет значка идущего вайпа: «${row.kind}»`);
  assert.equal(row.deleted, '—', `у идущего вайпа в «Удалено»: «${row.deleted}»`);
});

test('R-2: идущая проверка — «проверка: идёт»', async () => {
  const [row] = await historyRows([record({ status: 'running', dryRun: true, deleted: [], deletedCount: 0 })]);
  assert.equal(row.badge, 'проверка: идёт');
  assert.equal(row.kind, 'warn');
  assert.equal(row.deleted, '—');
});

test('R-2: прогон, закрытый после падения панели (interrupted), — «прерван»; проверка — «проверка: прервана»', async () => {
  const reason = 'Прогон прерван: панель или плагин перезапустились во время вайпа. Список удалённых путей может быть неполным';
  const [wipe, check] = await historyRows([
    record({ status: 'interrupted', ok: false, finishedAt: '2026-11-19T05:30:00.000Z', deletedCount: 3, errors: [reason] }),
    record({ status: 'interrupted', ok: false, dryRun: true, finishedAt: '2026-11-19T05:31:00.000Z', deletedCount: 0, errors: [reason] }),
  ]);
  assert.equal(wipe.badge, 'прерван', `значок прерванного вайпа: «${wipe.badge}»`);
  assert.equal(wipe.kind, 'bad');
  assert.equal(wipe.deleted, '3', 'у прерванного вайпа должно быть видно, сколько успели удалить');
  assert.equal(check.badge, 'проверка: прервана', `значок прерванной проверки: «${check.badge}»`);
});

test('законченные прогоны — как раньше: «успешно», «ошибка», «проверка: ок», «проверка: ошибка»', async () => {
  const rows = await historyRows([
    record({ status: 'ok', ok: true, deletedCount: 4 }),
    record({ status: 'failed', ok: false, deletedCount: 0 }),
    record({ status: 'ok', ok: true, dryRun: true, deletedCount: 2 }),
    record({ status: 'failed', ok: false, dryRun: true, deletedCount: 0 }),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.badge, row.kind, row.deleted]),
    [
      ['успешно', 'ok', '4'],
      ['ошибка', 'bad', '0'],
      ['проверка: ок', 'ok', 'было бы 2'],
      ['проверка: ошибка', 'bad', 'было бы 0'],
    ],
  );
});

test('записи прошлых версий без status — итог по ok, как раньше', async () => {
  const rows = await historyRows([record({ ok: true, deletedCount: 5 }), record({ ok: false, deletedCount: 0 })]);
  assert.deepEqual(
    rows.map((row) => [row.badge, row.kind]),
    [
      ['успешно', 'ok'],
      ['ошибка', 'bad'],
    ],
  );
});
