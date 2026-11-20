/**
 * Исполнитель P4, регрессия R4-5 (в сводке — R-8).
 *
 * У профиля выключено «Останавливать сервер», сервер работает. Окно «Вайп
 * сейчас» писало «Сервер не останавливается…», «Удалятся файлы и папки…»,
 * «После вайпа сервер запустится». На деле вайп на работающем сервере
 * сразу отказывает («удалять файлы на живом сервере нельзя») и ничего не
 * удаляет.
 *
 * Должно: текст — по настройкам профиля. Остановка выключена — «если сервер
 * работает, вайп не начнётся»; запуск выключен — «после вайпа сервер не
 * запустится». Обычный профиль — как раньше.
 *
 * Запуск: node tools/review/post-p4-run-dialog.test.mjs
 */

import assert from 'node:assert/strict';
import { findAll, makeProfile, setup, test } from './fix-f5-ui-lib.mjs';

/** Открыть окно «Вайп сейчас» и вернуть его пункты (запрос на вайп не уходит). */
async function dialogItems(options) {
  const profile = makeProfile();
  profile.options = { ...profile.options, ...options };
  const ui = await setup({ profiles: [profile] });
  ui.click(ui.button('Вайп сейчас'), '«Вайп сейчас»');
  const overlay = ui.overlays()[0];
  assert.ok(overlay, 'окно подтверждения не открылось');
  assert.equal(ui.requests.filter((request) => request.path.endsWith('/run')).length, 0, 'вайп ушёл без подтверждения');
  return findAll(overlay, (node) => node.tagName === 'LI').map((node) => node.textContent);
}

const has = (items, part) => items.some((item) => item.includes(part));

test('R-8: остановка выключена — окно говорит, что на работающем сервере вайп не начнётся', async () => {
  const items = await dialogItems({ stopServer: false });
  assert.ok(has(items, 'если сервер работает, вайп не начнётся'), items.join(' | '));
  assert.ok(!has(items, 'Сервер не останавливается'), `осталось старое обещание: ${items.join(' | ')}`);
  assert.ok(!has(items, 'остановится, игроков отключит'), items.join(' | '));
});

test('R-8: запуск выключен — «после вайпа сервер не запустится»', async () => {
  const items = await dialogItems({ startServer: false });
  assert.ok(has(items, 'после вайпа сервер не запустится'), items.join(' | '));
  assert.ok(!has(items, 'После вайпа сервер запустится'), items.join(' | '));
});

test('обычный профиль — как раньше: остановит, удалит, запустит', async () => {
  const items = await dialogItems({});
  assert.ok(has(items, 'остановится, игроков отключит'), items.join(' | '));
  assert.ok(has(items, 'Удалятся файлы и папки'), items.join(' | '));
  assert.ok(has(items, 'Вернуть удалённое нельзя'), items.join(' | '));
  assert.ok(has(items, 'После вайпа сервер запустится'), items.join(' | '));
});

test('профиль «только проверка» — как раньше: ничего не удалится', async () => {
  const items = await dialogItems({ dryRun: true, stopServer: false });
  assert.ok(has(items, 'ничего не удалится, сервер не остановится'), items.join(' | '));
});
