/**
 * Ревью RustWipe, гипотеза 6 (раздел 4.2 правил), утверждение H6c — junction.
 *
 * В исходном виде (junction Windows) неприменимо: агент Catalyst собирается
 * только под Unix (catalyst-agent/src/file_manager.rs:2, use std::os::unix…).
 * Похожее на Linux — точка монтирования (bind mount) внутри папки сервера,
 * которую сделал админ ноды. Агент такую папку ссылкой не считает: в list она
 * обычная папка (file_manager.rs:1216-1227), при delete — remove_dir_all без
 * проверки границы диска (file_manager.rs:1128-1132).
 *
 * Что можно проверить без настоящего агента и ядра — это и проверяется:
 *   1) по ответу list плагин не может отличить точку монтирования от папки;
 *   2) сам плагин не обращается ни к чему вне папки своего сервера: в каждом
 *      запросе туннеля uuid этого сервера и путь внутри него.
 * Что сделает remove_dir_all с точкой монтирования, зависит от ядра и
 * стандартной библиотеки Rust, а не от кода Catalyst; модель песочницы (junction
 * как bind mount: содержимое снаружи стирается, затем EBUSY) — допущение, поэтому
 * её итог только печатается заметкой.
 *
 * Запуск: node tools/review/h06c-junction-mount.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

test('H6c: точку монтирования плагин видит как папку и сам не выходит за папку сервера', async (t) => {
  const sb = createSandbox();
  sb.tree.remove('/oxide/data/cfg-link.json');
  await sb.load();
  const before = sb.tree.snapshot();

  const listing = await sb.call('owner', 'GET', '/servers/srv1/files', { query: { path: '/oxide/data' } });
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  const mount = listing.body.data.entries.find((entry) => entry.name === 'shared');
  const plain = listing.body.data.entries.find((entry) => entry.name === 'Kits');
  t.note(`запись точки монтирования: ${JSON.stringify(mount)}`);
  assert.deepEqual(
    Object.keys(mount).sort(),
    Object.keys(plain).sort(),
    'у записи нет поля, которого нет у обычной папки',
  );
  assert.equal(mount.isDirectory, true, 'точка монтирования показана как обычная папка');

  const profile = await sb.addProfile({ targets: ['/oxide/data/*'] });
  const run = await sb.wipe(profile);
  await sb.idle();
  const server = sb.panel.server('srv1');
  const foreign = sb.tunnel.calls.filter(
    (call) => call.uuid !== server.uuid || String(call.rawPath).split('/').includes('..') || !call.path.startsWith('/'),
  );
  assert.deepEqual(foreign, [], 'плагин послал запрос не к своему серверу или с выходом наверх');

  const sharedAnswer = sb.tunnel.calls.find((call) => call.op === 'delete' && call.path === '/oxide/data/shared');
  const removedOutside = sb.tree.diff(before).removed.filter((item) => item.startsWith('host:'));
  t.note(`плагин отправил: delete /oxide/data/shared → ${sharedAnswer?.outcome}${sharedAnswer?.error ? `: ${sharedAnswer.error}` : ''}`);
  t.note(`модель песочницы (допущение, не исходник Catalyst): снаружи удалено ${removedOutside.join(', ') || 'ничего'}; прогон ok=${run.ok}`);
});
