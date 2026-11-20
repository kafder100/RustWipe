/**
 * Ревью RustWipe, гипотеза 6 (раздел 4.2 правил), утверждение H6b —
 * похожая настоящая проблема рядом с H6a: наружу удаление не выходит, но
 * ссылка ВНУТРИ папки сервера уводит удаление из выбранной папки.
 *
 * Агент v1.89.2 разрешает путь вместе с последней ссылкой и удаляет её ЦЕЛЬ,
 * а сама ссылка остаётся (catalyst-agent/src/file_manager.rs:1124-1136:
 * resolve_path, затем symlink_metadata уже цели, remove_dir_all или remove_file).
 * Абсолютную цель /data/… агент переносит в корень сервера (там же, 316-326) —
 * так ссылки создаются внутри контейнера. В list ссылка видна как обычный файл
 * или папка (file_manager.rs:1216-1228), плагин ссылку не отличает.
 *
 * Правильное поведение (ответ владельца №3 «Строго выбранные файлы»; README:
 * исключения — «не удалять»): вайп не удаляет ничего вне выбранных путей и
 * ничего из исключённого.
 *
 * Сценарии (дерево сервера Rust из песочницы, junction убран — его проверяет H6c):
 *   1) /oxide/data/cfg-link.json — ссылка на ../../server/rust/cfg/server.cfg;
 *      цель — json-файлы в /oxide/data, исключение — папка cfg;
 *   2) /oxide/data/maps — ссылка на /data/server/rust; пресет «Данные Oxide».
 * Боевой вайп — только на подменах песочницы.
 *
 * Запуск: node tools/review/h06b-link-inside-target.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, rustServerTree, test } from './sandbox.mjs';

async function wipe(t, { withDataLink = false, targets, excludes = [] }) {
  const sb = createSandbox({ tree: rustServerTree({ withDataLink }) });
  sb.tree.remove('/oxide/data/shared');
  // Во втором сценарии причина должна быть одна — ссылка maps.
  if (withDataLink) sb.tree.remove('/oxide/data/cfg-link.json');
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets, excludes });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const outsideChosen = removed.filter((item) => !item.startsWith('/oxide/data/'));
  t.note(`запросы delete: ${sb.tunnel.paths('delete').join(', ')}`);
  t.note(`удалено вне /oxide/data: ${outsideChosen.length} — ${outsideChosen.slice(0, 4).join(', ')}${outsideChosen.length > 4 ? ', …' : ''}`);
  t.note(`прогон: ok=${run.ok}; ссылки после вайпа: ${sb.tree.snapshot().filter((item) => item.includes(' -> ')).join(', ')}`);
  return { sb, outsideChosen };
}

test('H6b: ссылка на файл внутри сервера — исключённый server.cfg не должен удаляться', async (t) => {
  const { sb, outsideChosen } = await wipe(t, { targets: ['/oxide/data/*.json'], excludes: ['/server/*/cfg'] });
  assert.equal(sb.tree.exists('/server/rust/cfg/server.cfg'), true, 'удалён исключённый /server/rust/cfg/server.cfg');
  assert.deepEqual(outsideChosen, []);
});

test('H6b: ссылка /data/… на папку мира — пресет «Данные Oxide» не должен трогать /server/rust', async (t) => {
  const { sb, outsideChosen } = await wipe(t, { withDataLink: true, targets: ['/oxide/data/*'] });
  assert.equal(sb.tree.exists('/server/rust/cfg/server.cfg'), true, 'вместе с /server/rust удалён и server.cfg');
  assert.deepEqual(outsideChosen, [], 'удалено вне выбранной папки /oxide/data');
});
