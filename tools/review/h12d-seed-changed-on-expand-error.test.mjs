/**
 * Ревью RustWipe, гипотеза 12 (раздел 4.2), утверждение H12d — соседняя
 * настоящая проблема к H12c.
 *
 * H12c (нечего удалять, а сид меняется) владелец выбрал сам (ответ №9).
 * Но тот же порядок «сначала сид, потом раскрытие путей» бьёт и по другому
 * случаю: раскрытие путей падает с ошибкой (здесь — пресет «Данные Oxide» на
 * сервере без папки /oxide, агент отвечает «Cannot access path»). Вайп
 * прерывается до удаления, в истории — ошибка, но WORLD_SEED уже переписан:
 * сервер поднимается с новой картой и старыми файлами.
 *
 * Правильное поведение (ответ №3 по умолчанию: «при сомнении вайп
 * останавливается до удаления, сервер поднимается»; README: «ошибка ...
 * прерывает вайп до удаления и поднимает сервер обратно»): если вайп отменён
 * до удаления из-за ошибки, сервер возвращается таким, каким был, —
 * переменные карты не меняются. Ответ №9 касается только случая «ничего не
 * нашлось», а не ошибки.
 *
 * Запуск: node tools/review/h12d-seed-changed-on-expand-error.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, rustServerTree, test } from './sandbox.mjs';

/** Сервер Rust без Oxide (например, на Carbon): папки /oxide нет совсем. */
function treeWithoutOxide() {
  const spec = rustServerTree();
  spec.files = Object.fromEntries(Object.entries(spec.files).filter(([name]) => !name.startsWith('/oxide/')));
  return spec;
}

test('раскрытие путей упало (нет папки /oxide): вайп отменён до удаления — сид не меняется', async (t) => {
  const sb = createSandbox({ tree: treeWithoutOxide() });
  await sb.load();
  const before = sb.tree.snapshot();
  const seedBefore = sb.panel.server('srv1').environment.WORLD_SEED;
  const profile = await sb.addProfile({
    targets: ['/server/*/proceduralmap.*.map', '/server/*/proceduralmap.*.sav', '/oxide/data/*'],
    map: { seed: { mode: 'fixed', value: 777 }, size: { mode: 'keep' } },
  });

  const run = await sb.wipe(profile);
  await sb.idle();

  const seedAfter = sb.panel.server('srv1').environment.WORLD_SEED;
  const patches = sb.panel.calls.filter((call) => call.method === 'PATCH' && call.path === '/api/servers/srv1/variables');
  t.note(`история: ok=${run.ok}, ошибки: ${run.errors.join(' | ')}`);
  t.note(`удалено: ${sb.tree.diff(before).removed.length}; WORLD_SEED: ${seedBefore} → ${seedAfter}; PATCH /variables: ${patches.length}; статус: ${sb.status()}`);

  assert.equal(run.ok, false, 'предусловие: раскрытие путей должно упасть');
  assert.deepEqual(sb.tree.diff(before).removed, [], 'предусловие: вайп прерван до удаления');
  assert.equal(seedAfter, seedBefore, 'вайп отменён до удаления — карта не должна меняться');
});
