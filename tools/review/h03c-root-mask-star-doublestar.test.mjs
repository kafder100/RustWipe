/**
 * Ревью RustWipe, гипотеза 3 (раздел 4.2), утверждение H3c:
 * запрет обходится маской /*\/** (и /**\/**). Она выбирает все каталоги корня,
 * как запрещённая /**: RustDedicated_Data, server (вместе с cfg), steamapps,
 * oxide, carbon. Профиль сохраняется, вайп стирает данные игры.
 *
 * Правильное поведение: как у /** — профиль отклоняется; вайп по уже
 * сохранённому профилю (версия 1.5.6 его пропускает) установку не сносит.
 *
 * Запуск: node tools/review/h03c-root-mask-star-doublestar.test.mjs
 * Всё на подменах песочницы. Ссылки и junction из готового дерева убраны: с
 * ними обход «**» случайно падает на ссылке наружу и не удаляет ничего.
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const MASK = '/*/**';
const ALSO = ['/**/**'];
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

test(`H3c: профиль с целью ${MASK} (и ${ALSO.join(', ')}) не сохраняется — как /**`, async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const control = await postProfile(sb, ['/**']);
  assert.equal(control.status, 400, 'контроль: /** должен отклоняться');
  const statuses = {};
  for (const mask of [MASK, ...ALSO]) statuses[mask] = (await postProfile(sb, [mask])).status;
  t.note(`/** → ${control.status}; ${JSON.stringify(statuses)}`);
  const accepted = Object.entries(statuses).filter(([, status]) => status !== 400).map(([mask]) => mask);
  assert.deepEqual(accepted, [], `цели приняты, хотя по смыслу это /**: ${accepted.join(', ')}`);
});

test(`H3c: вайп по уже сохранённому профилю с ${MASK} не сносит установку`, async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const profile = await sb.addProfile({ targets: [MASK], excludes: [] });
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  t.note(`удаления по туннелю: ${sb.tunnel.paths('delete').join(', ')}`);
  t.note(`с «диска» пропало записей: ${sb.tree.diff(before).removed.length}; прогон ok=${run.ok}`);
  const lost = INSTALL.filter((item) => !sb.tree.exists(item));
  assert.deepEqual(lost, [], `вайп по маске ${MASK} снёс установку: ${lost.join(', ')}`);
});
