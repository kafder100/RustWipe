/**
 * Ревью RustWipe, гипотеза 4 (раздел 4.2 правил), утверждение H4a —
 * в исходном виде: ответ «Server not found» плагин считает «уже удалено»,
 * и вайп «успешен», а ничего не удалено.
 *
 * Факты Catalyst v1.89.2: через файловый туннель такого текста нет. Агент для
 * незнакомого сервера (папки сервера на ноде нет) отвечает так
 * (catalyst-agent/src/file_manager.rs: jail_base_sync 207-222,
 * resolve_beneath 346-356, list_dir 1188-1190, delete_file 1124-1128):
 *   - list последней части пути: «Failed to read dir …: No such file or directory»;
 *   - промежуточной папки нет: «Cannot access path: <путь на ноде>».
 * Песочница делает так же (это её обычный режим, без выдуманного serverNotFound).
 *
 * Правильное поведение: если на ноде нет папки сервера, вайп не записан как
 * успешный, ничего не удалено, сервер снова работает.
 *
 * Запуск: node tools/review/h04a-server-not-found.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const GHOST = 'f0f0f0f0-0000-4000-8000-0000000000ff';

async function wipeUnknownServer(t, targets) {
  // Дерево — обычный сервер Rust, но у сервера в панели другой uuid: на ноде его папки нет.
  const sb = createSandbox({ servers: [defaultServer({ uuid: GHOST })] });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets });
  const run = await sb.wipe(profile);
  await sb.idle();
  const answers = sb.tunnel.calls.map((call) => `${call.op} ${call.path} → ${call.outcome}${call.error ? `: ${call.error}` : ''}`);
  t.note(`ответы агента: ${answers.join(' | ')}`);
  t.note(`прогон: ok=${run.ok}; удалено ${run.deletedCount}; пропущено ${run.skipped.length}; ошибки: ${run.errors.join(' | ') || 'нет'}`);
  assert.ok(sb.tunnel.calls.every((call) => call.error !== 'Server not found'), 'агент не отвечает «Server not found»');
  assert.deepEqual(sb.tree.diff(before).removed, [], 'ничего не удалено');
  assert.equal(sb.status(), 'running', 'сервер снова работает');
  assert.equal(run.ok, false, 'вайп без папки сервера не должен считаться успешным');
}

test('H4a: папки сервера нет на ноде, цели — маски (пресет «Карта + блюпринты»)', async (t) => {
  await wipeUnknownServer(t, [
    '/server/*/proceduralmap.*.map',
    '/server/*/proceduralmap.*.sav',
    '/server/*/player.blueprints.*.db',
  ]);
});

test('H4a: папки сервера нет на ноде, цели — точные пути из пикера', async (t) => {
  await wipeUnknownServer(t, [
    '/server/rust/proceduralmap.3000.12345.270.map',
    '/server/rust/player.blueprints.270.db',
  ]);
});
