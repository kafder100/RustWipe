/**
 * Исполнитель F5, находка L31-2 (договорённость К5, часть вкладки).
 *
 * Вкладка Б открыта заранее; во вкладке А путь убрали и сохранили. Вкладка Б
 * сохраняла свой старый черновик целиком — убранный путь молча возвращался.
 *
 * Должно (К5): PUT несёт expectedUpdatedAt — updatedAt, который видел редактор.
 * Если профиль изменился, backend отвечает 409 { code: 'PROFILE_CHANGED' }:
 * вкладка не закрывает редактор, не теряет черновик, говорит, что случилось,
 * и даёт перечитать профиль. Подмена backend здесь — по договорённости К5.
 *
 * Запуск: node tools/review/fix-f5-stale-save.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, setup, test } from './fix-f5-ui-lib.mjs';

const CHANGED = { success: false, code: 'PROFILE_CHANGED', error: 'Профиль изменён в другом месте. Обновите вкладку.' };

/** PUT как в К5: версия разошлась — 409, иначе сохраняем и меняем updatedAt. */
function handlePut(request, state) {
  if (request.method !== 'PUT' || !/\/profiles\/[^/]+$/.test(request.path)) return undefined;
  const current = state.profiles[0];
  if (request.body?.expectedUpdatedAt && request.body.expectedUpdatedAt !== current.updatedAt) {
    return { status: 409, json: CHANGED };
  }
  state.profiles[0] = { ...current, ...request.body, updatedAt: '2026-11-03T10:00:00.000Z' };
  return { status: 200, json: { success: true, data: state.profiles[0] } };
}

const puts = (ui) => ui.requests.filter((request) => request.method === 'PUT');

test('L31-2: сохранение несёт expectedUpdatedAt — версию, которую видел редактор', async () => {
  const ui = await setup({ profiles: [makeProfile({ updatedAt: '2026-11-01T10:00:00.000Z' })], handle: handlePut });
  ui.click(ui.button('Изменить'), '«Изменить»');
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
  assert.equal(puts(ui).length, 1, 'PUT не ушёл');
  assert.equal(puts(ui)[0].body.expectedUpdatedAt, '2026-11-01T10:00:00.000Z');
  assert.ok(!ui.modal(), 'после удачного сохранения редактор не закрылся');
});

test('L31-2: профиль изменили в другой вкладке — 409, редактор открыт, черновик цел, понятный текст', async () => {
  const ui = await setup({
    profiles: [makeProfile({ targets: ['/server/rust/*.sav', '/oxide/data/*'], updatedAt: '2026-11-01T10:00:00.000Z' })],
    handle: handlePut,
  });
  ui.click(ui.button('Изменить'), '«Изменить»');
  // Тем временем во вкладке А путь /oxide/data/* убрали и сохранили.
  ui.state.profiles[0] = { ...ui.state.profiles[0], targets: ['/server/rust/*.sav'], updatedAt: '2026-11-02T10:00:00.000Z' };
  ui.type(ui.input((node) => node.getAttribute('type') === 'time'), '06:00');
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();

  assert.equal(puts(ui).length, 1);
  assert.equal(puts(ui)[0].body.expectedUpdatedAt, '2026-11-01T10:00:00.000Z');
  assert.deepEqual(ui.state.profiles[0].targets, ['/server/rust/*.sav'], 'старый черновик затёр чужую правку');
  assert.ok(ui.modal(), 'редактор закрылся после 409');
  assert.ok(ui.text().includes('Профиль изменили в другом месте'), 'в редакторе нет объяснения');
  assert.ok(/изменён в другом месте/.test(ui.toast()), `тост: «${ui.toast()}»`);
  assert.equal(ui.input((node) => node.getAttribute('type') === 'time').value, '06:00', 'черновик потерян');

  // «Загрузить новую версию» — редактор с данными вкладки А, следующее сохранение проходит.
  ui.click(ui.button('Загрузить новую версию'), '«Загрузить новую версию»');
  await ui.settle();
  assert.ok(ui.modal(), 'редактор не открылся заново');
  assert.ok(!ui.text().includes('/oxide/data/*'), 'в новом черновике остался убранный путь');
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
  assert.equal(puts(ui).length, 2);
  assert.equal(puts(ui)[1].body.expectedUpdatedAt, '2026-11-02T10:00:00.000Z');
  assert.deepEqual(puts(ui)[1].body.targets, ['/server/rust/*.sav']);
  assert.ok(!ui.modal(), 'после удачного сохранения редактор не закрылся');
});
