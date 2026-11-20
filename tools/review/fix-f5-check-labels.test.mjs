/**
 * Исполнитель F5, находка L31-4 (договорённости К4, К5 — часть вкладки).
 *
 * Проверочный прогон в интерфейсе выглядел как вайп: тост «Вайп запущен»,
 * в истории «Удалено: 2» и «Удалённые пути», а профиль с галочкой «Только
 * проверка» на карточке ничем не отличался от боевого.
 *
 * Должно: на карточке метка «только проверка» (галочка профиля или глобальная
 * проверка); итог проверки (lastCheck*) показан отдельно и не прячет ошибку
 * настоящего вайпа (lastRun*); в истории «проверка: ок» и «было бы удалено»;
 * тост — по тому, что запущено; в запросе dryRun строго true или false.
 *
 * Запуск: node tools/review/fix-f5-check-labels.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

const card = (ui, name) => ui.find((node) => node.classList.contains('rw-card') && node.textContent.includes(name));

test('L31-4: профиль с «Только проверка» помечен на карточке, боевой — нет', async () => {
  const ui = await setup({
    profiles: [
      makeProfile({ id: 'a', name: 'А: боевой' }),
      makeProfile({ id: 'b', name: 'Б: ночной', options: { stopServer: true, startServer: true, dryRun: true, commandsAfter: [] } }),
    ],
  });
  assert.ok(card(ui, 'Б: ночной').textContent.includes('только проверка'), 'нет метки у профиля с «Только проверка»');
  assert.ok(!card(ui, 'А: боевой').textContent.includes('только проверка'), 'метка у боевого профиля');
});

test('L31-4: глобальная проверка в настройках — метка на всех карточках', async () => {
  const ui = await setup({ status: makeStatus({ dryRun: true }) });
  assert.ok(card(ui, 'Еженедельный вайп').textContent.includes('только проверка'));
});

test('К4: итог проверки показан отдельно и не прячет ошибку настоящего вайпа', async () => {
  const profile = makeProfile({
    lastRunAt: '2026-11-19T02:00:00.000Z',
    lastRunStatus: 'failed',
    lastError: 'Сервер не остановился: таймаут 300 с',
    lastCheckAt: '2026-11-19T09:00:00.000Z',
    lastCheckStatus: 'ok',
    lastCheckError: null,
  });
  const ui = await setup({ profiles: [profile] });
  const text = card(ui, profile.name).textContent;
  assert.ok(text.includes('последний вайп: ошибка'), `нет итога вайпа: ${text}`);
  assert.ok(text.includes('Ошибка вайпа: Сервер не остановился'), 'ошибка ночного вайпа не видна');
  assert.ok(text.includes('Проверка: ок, 19.11.2026 09:00'), 'нет итога проверки');
});

test('L31-4: проверка в истории — «проверка: ок» и «было бы удалено»', async () => {
  const run = {
    id: 'run_c',
    profileId: 'wipe_1',
    profileName: 'Еженедельный вайп',
    trigger: 'manual',
    ok: true,
    dryRun: true,
    startedAt: '2026-11-19T09:00:00.000Z',
    deleted: ['/server/rust/a.sav', '/server/rust/a.map'],
    deletedCount: 2,
    steps: [{ at: '2026-11-19T09:00:01.000Z', action: 'delete', ok: true, detail: 'режим проверки', data: { deleted: 2 } }],
  };
  const ui = await setup({ runs: [run] });
  const row = ui.find((node) => node.tagName === 'TR' && node.parentNode?.tagName === 'TBODY');
  const cells = row.children.map((cell) => cell.textContent.trim());
  assert.equal(cells[3], 'проверка: ок');
  assert.equal(cells[4], 'было бы 2');
  assert.ok(row.textContent.includes('Было бы удалено (2)'), 'список путей подписан как удалённые');
  assert.ok(!row.textContent.includes('Удалённые пути'), 'в проверке написано «Удалённые пути»');
  const key = ui.find((node) => node.classList.contains('rw-kv-key') && node.textContent.includes('удалено'));
  assert.equal(key?.textContent, 'Было бы удалено');
});

test('К5: «Проверка» шлёт dryRun: true и пишет «Проверка запущена», боевой — dryRun: false и «Вайп запущен»', async () => {
  const runs = (ui) => ui.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/run'));
  const check = await setup();
  check.click(check.button('Проверка'), '«Проверка»');
  await check.settle();
  assert.deepEqual(runs(check)[0].body, { dryRun: true });
  assert.ok(check.toast().startsWith('Проверка запущена'), `тост: «${check.toast()}»`);

  // Пока идёт проверка, профиль занят (H16c), поэтому боевой — на свежей вкладке.
  const live = await setup();
  live.click(live.button('Вайп сейчас'), '«Вайп сейчас»');
  live.click(live.button('Вайп сейчас', live.overlays()[0]), 'подтверждения');
  await live.settle();
  assert.deepEqual(runs(live)[0].body, { dryRun: false });
  assert.ok(live.toast().startsWith('Вайп запущен'), `тост: «${live.toast()}»`);
});
