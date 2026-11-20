/**
 * Ревью RustWipe, гипотеза 6 (раздел 4.2 правил), утверждение H6a.
 *
 * Что проверяем: плагин ссылки не различает (у записи list нет признака ссылки —
 * rust-autowipe/backend/lib/glob-walk.js:32-43, catalyst-agent/src/file_tunnel.rs:326-349),
 * граница папки сервера — целиком на агенте. Выходит ли удаление через ссылку
 * НАРУЖУ папки сервера?
 *
 * Агент v1.89.2 (catalyst-agent/src/file_manager.rs:269-380, resolve_beneath):
 * ссылка с абсолютной целью вне /data — отказ «symbolic link leaves the server
 * directory»; «..» за корень — отказ «path outside data directory». Песочница
 * в режиме agent повторяет эти правила.
 *
 * Правильное поведение: ни при каком профиле не удаляется ничего вне папки
 * сервера (правила 3.2 и 4.1).
 *
 * Сценарий: обычное дерево сервера Rust из песочницы; в /oxide/data лежат
 * ссылка backup на /srv/backup и ссылка up на ../../../other-server (соседний
 * сервер). Junction и ссылка на файл внутри сервера убраны — их проверяют H6c и H6b.
 * Боевой вайп — только на подменах.
 *
 * Запуск: node tools/review/h06a-link-outside.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

async function wipeAround(t, { targets, excludes = [] }) {
  const sb = createSandbox();
  sb.tree.remove('/oxide/data/shared').remove('/oxide/data/cfg-link.json');
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets, excludes });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const outside = removed.filter((item) => item.startsWith('host:'));
  const linkAnswers = sb.tunnel.calls
    .filter((call) => /\/(backup|up)(\/|$)/.test(call.path))
    .map((call) => `${call.op} ${call.path} → ${call.outcome}${call.error ? `: ${call.error}` : ''}`);
  t.note(`ответы агента по ссылкам: ${linkAnswers.join(' | ') || 'запросов не было'}`);
  t.note(`удалено внутри сервера: ${removed.length - outside.length}; снаружи: ${outside.length}; прогон ok=${run.ok}`);
  assert.deepEqual(outside, [], 'удалено что-то вне папки сервера');
  assert.ok(sb.tree.hostExists('/srv/backup/world.sav'), 'цел файл в /srv/backup');
  assert.ok(sb.tree.hostExists('/var/lib/catalyst/other-server/server/rust/sv.files.270.db'), 'цел файл соседнего сервера');
}

test('H6a: пресет «Данные Oxide» удаляет ссылки наружу — снаружи ничего не стёрто', async (t) => {
  await wipeAround(t, { targets: ['/oxide/data/*'] });
});

test('H6a: маска идёт сквозь ссылку наружу — снаружи ничего не стёрто', async (t) => {
  await wipeAround(t, { targets: ['/oxide/data/*/*.sav', '/oxide/data/*/*.db'] });
});

test('H6a: с исключением плагин заглядывает в ссылку наружу — снаружи ничего не стёрто', async (t) => {
  await wipeAround(t, { targets: ['/oxide/data/*'], excludes: ['/oxide/data/*/keep.json'] });
});
