/**
 * Исполнитель F5, находка L31-19: одно слово для разного, внутренние названия
 * на экране, ошибка шага повторена ниже строкой «✕ …».
 *
 * Должно: «Источник» вместо столбца «Запуск» (шаг «Запуск сервера» — это
 * другое), «История прогонов», одно слово «проверка» вместо dry-run и
 * «режима проверки», без имён прав и переменных шаблона в подсказках,
 * ошибка шага — один раз.
 *
 * Запуск: node tools/review/fix-f5-texts.test.mjs
 */

import assert from 'node:assert/strict';
import { makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

const RUN = {
  id: 'run_1',
  profileId: 'wipe_1',
  profileName: 'Еженедельный вайп',
  trigger: 'schedule',
  ok: false,
  dryRun: false,
  startedAt: '2026-11-19T02:00:00.000Z',
  errors: ['Сервер не остановился: таймаут 300 с'],
  steps: [
    { at: '2026-11-19T02:00:00.000Z', action: 'start', ok: true, detail: 'сервер запущен', data: { started: true } },
    {
      at: '2026-11-19T02:05:00.000Z',
      action: 'error',
      ok: false,
      detail: 'Сервер не остановился: таймаут 300 с',
      data: { message: 'Сервер не остановился: таймаут 300 с' },
    },
  ],
};

test('L31-19: история — «История прогонов», столбец «Источник», шаг «Запуск сервера»', async () => {
  const ui = await setup({ runs: [RUN] });
  assert.ok(ui.text().includes('История прогонов'));
  const heads = ui.findAll((node) => node.tagName === 'TH').map((node) => node.textContent);
  assert.ok(heads.includes('Источник'), `столбцы: ${heads.join(', ')}`);
  assert.ok(!heads.includes('Запуск'), 'столбец «Запуск» путается с шагом запуска сервера');
  const labels = ui.findAll((node) => node.classList.contains('rw-step-label')).map((node) => node.textContent);
  assert.ok(labels.includes('Запуск сервера'), `шаги: ${labels.join(', ')}`);
});

test('L31-19: ошибка шага не повторяется строкой «✕ …»', async () => {
  const ui = await setup({ runs: [RUN] });
  const repeats = ui.findAll((node) => node.classList.contains('rw-step-detail') && node.textContent.startsWith('✕ '));
  assert.equal(repeats.length, 0, 'ошибка шага повторена ниже');
});

test('L31-19: ошибка без своего шага по-прежнему видна', async () => {
  const run = { ...RUN, errors: ['Не удалось запустить сервер после ошибки: 503'] };
  const ui = await setup({ runs: [run] });
  assert.ok(ui.text().includes('✕ Не удалось запустить сервер после ошибки: 503'));
});

test('L31-19: одно слово «проверка», без dry-run, имён прав и переменных шаблона', async () => {
  const ui = await setup({ status: makeStatus({ dryRun: true }) });
  assert.ok(ui.text().includes('Только проверки: вайпы ничего не удаляют'), 'нет пометки о глобальной проверке');
  assert.ok(ui.button('Проверка'), 'нет кнопки «Проверка»');
  ui.click(ui.button('Изменить'), '«Изменить»');
  const text = ui.text();
  for (const word of ['dry-run', 'Режим проверки', 'server.startup', 'console.write', '{{WORLD_SEED}}', 'rust-autowipe.']) {
    assert.ok(!text.includes(word), `на экране «${word}»`);
  }
  assert.ok(text.includes('Только проверка: ничего не удалять и не останавливать сервер'));
});
