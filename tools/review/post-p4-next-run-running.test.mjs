/**
 * Исполнитель P4, регрессия R4-4 (в сводке — R-7).
 *
 * Backend занимает плановый срок ещё до вайпа: во время вайпа nextRunAt уже
 * указывает на следующий срок. Карточка же писала «Следующий запуск:
 * 26.11.2026 05:00 (идёт сейчас)» — будто уже идёт вайп 26.11.
 *
 * Должно: «Идёт вайп» (у проверки — «Идёт проверка») — отдельно, а у
 * следующего срока — обычный отсчёт «(через 7 дн)». «(идёт сейчас)» — только
 * если сам этот срок уже наступил (например, он пришёлся на ручной вайп).
 *
 * Запуск: node tools/review/post-p4-next-run-running.test.mjs
 */

import assert from 'node:assert/strict';
import { find, makeProfile, setup, test } from './fix-f5-ui-lib.mjs';

const DAY = 24 * 3600 * 1000;
const card = (ui) => ui.find((node) => node.classList.contains('rw-card'));
const nextLine = (ui) =>
  find(card(ui), (node) => node.tagName === 'SPAN' && node.textContent.startsWith('Следующий запуск'))?.textContent ?? '';
/** Отдельная надпись об идущем прогоне (не внутри строки «Следующий запуск»). */
const runningNote = (ui) =>
  find(card(ui), (node) => node.tagName === 'SPAN' && /^Идёт (вайп|проверка)$/.test(node.textContent.trim()))?.textContent ?? '';

function runningRecord(overrides = {}) {
  return {
    id: 'run_live',
    profileId: 'wipe_1',
    profileName: 'Еженедельный вайп',
    serverId: 'srv1',
    trigger: 'schedule',
    dryRun: false,
    status: 'running',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    steps: [],
    ...overrides,
  };
}

test('R-7: идёт плановый вайп, срок уже следующий — «Идёт вайп» отдельно, у срока обычный отсчёт', async () => {
  const ui = await setup({
    profiles: [makeProfile({ running: true, nextRunAt: new Date(Date.now() + 7 * DAY).toISOString() })],
    runs: [runningRecord()],
  });
  assert.equal(runningNote(ui), 'Идёт вайп', `нет отдельной надписи об идущем вайпе: ${card(ui).textContent}`);
  assert.ok(!nextLine(ui).includes('идёт сейчас'), `у даты следующего срока «идёт сейчас»: ${nextLine(ui)}`);
  assert.match(nextLine(ui), /^Следующий запуск: .+ \(через 7 дн\)$/);
});

test('R-7: идёт проверка — «Идёт проверка», а не «Идёт вайп»', async () => {
  const ui = await setup({
    profiles: [makeProfile({ running: true })],
    runs: [runningRecord({ dryRun: true, trigger: 'manual' })],
  });
  assert.equal(runningNote(ui), 'Идёт проверка');
  assert.match(nextLine(ui), /\(через /);
});

test('R-7: сразу после «Проверка», пока записи в истории нет, — тоже «Идёт проверка»', async () => {
  const ui = await setup();
  ui.click(ui.button('Проверка'), '«Проверка»');
  await ui.settle();
  assert.equal(runningNote(ui), 'Идёт проверка', card(ui).textContent);
  assert.ok(!nextLine(ui).includes('идёт сейчас'), nextLine(ui));
});

test('R-7: срок наступил во время ручного вайпа — «(идёт сейчас)», а не «просрочен»', async () => {
  const ui = await setup({
    profiles: [makeProfile({ running: true, nextRunAt: new Date(Date.now() - 3 * 60000).toISOString() })],
    runs: [runningRecord({ trigger: 'manual' })],
  });
  assert.equal(runningNote(ui), 'Идёт вайп');
  assert.ok(nextLine(ui).endsWith('(идёт сейчас)'), nextLine(ui));
  assert.ok(!nextLine(ui).includes('просрочен'), nextLine(ui));
});

test('прогона нет — надписи «Идёт …» нет, срок как раньше', async () => {
  const ui = await setup();
  assert.equal(runningNote(ui), '');
  assert.match(nextLine(ui), /\(через /);
});
