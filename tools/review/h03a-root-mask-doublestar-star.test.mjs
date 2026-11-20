/**
 * Ревью RustWipe, гипотеза 3 (раздел 4.2), утверждение H3a:
 * запрет «нельзя удалять всё содержимое корня» обходится маской /**\/*.
 * Она совпадает со всеми записями в корне (как /*), профиль сохраняется,
 * а вайп сносит установку: RustDedicated, RustDedicated_Data, стартовые
 * скрипты, steamapps и настройки cfg.
 *
 * Правильное поведение: правило самого плагина (store.js, текст ошибки «Нельзя
 * удалять всё содержимое корня каталога сервера») — маска, равная по смыслу /*,
 * отклоняется так же, как /*. Вайп по уже сохранённому профилю с такой маской
 * (версия 1.5.6 его пропускает, после обновления он останется в базе) установку
 * не сносит.
 *
 * Запуск: node tools/review/h03a-root-mask-doublestar-star.test.mjs
 * Всё на подменах песочницы. Ссылки и junction из готового дерева убраны: с
 * ними обход «**» случайно падает на ссылке наружу и не удаляет ничего — на
 * обычном сервере без таких ссылок этого везения нет.
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const MASK = '/**/*';
const INSTALL = [
  '/RustDedicated',
  '/RustDedicated_Data/Managed/Assembly-CSharp.dll',
  '/RustDedicated_Data/globalgamemanagers',
  '/start.sh',
  '/runds.sh',
  '/steamapps/appmanifest_258550.acf',
  '/server/rust/cfg/server.cfg',
];

function treeWithoutLinks() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  return spec;
}

function postProfile(sb, targets) {
  return sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: `Цель ${targets.join(' ')}`, targets, schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
}

test(`H3a: профиль с целью ${MASK} не сохраняется — как /*`, async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const control = await postProfile(sb, ['/*']);
  assert.equal(control.status, 400, 'контроль: /* должен отклоняться');
  const res = await postProfile(sb, [MASK]);
  t.note(`/* → ${control.status}; ${MASK} → ${res.status}`);
  assert.equal(res.status, 400, `цель ${MASK} принята (ответ ${res.status}), хотя по смыслу это /*`);
  assert.equal(
    sb.profiles().some((profile) => (profile.targets || []).includes(MASK)),
    false,
    'профиль с такой целью попал в базу',
  );
});

test(`H3a: вайп по уже сохранённому профилю с ${MASK} не сносит установку`, async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  // Так профиль выглядит в базе после сохранения версией 1.5.6.
  const profile = await sb.addProfile({ targets: [MASK], excludes: [] });
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  const removed = sb.tree.diff(before).removed;
  const deleted = sb.tunnel.paths('delete');
  t.note(`удаления по туннелю: ${deleted.join(', ')}`);
  t.note(`с «диска» пропало записей: ${removed.length} из ${before.length}; прогон ok=${run.ok}`);
  const lost = INSTALL.filter((item) => !sb.tree.exists(item));
  assert.deepEqual(lost, [], `вайп по маске ${MASK} снёс установку: ${lost.join(', ')}`);
});

test('контроль (должен проходить): /* в другой записи (//*, /./*, \\*, /*/) тоже отклоняется', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const statuses = {};
  for (const variant of ['//*', '/./*', '\\*', '/*/', '/**/']) statuses[variant] = (await postProfile(sb, [variant])).status;
  t.note(JSON.stringify(statuses));
  assert.ok(Object.values(statuses).every((status) => status === 400), JSON.stringify(statuses));
});
