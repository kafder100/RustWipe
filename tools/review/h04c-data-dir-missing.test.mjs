/**
 * Ревью RustWipe, гипотеза 4 (раздел 4.2 правил), утверждение H4c —
 * похожая настоящая проблема рядом с H4a: сбой на уровне ноды принят за «нет файла».
 *
 * Если у агента пропала папка данных (например, диск с серверами не смонтирован),
 * на ЛЮБОЙ запрос он отвечает
 *   File system error: Data directory does not exist: "/var/lib/catalyst"
 * (catalyst-agent/src/file_manager.rs:207-214, вызывается из resolve_path 972-980
 * перед каждым list и delete). В тексте есть «does not exist» — плагин считает
 * это «нет файла» (rust-autowipe/backend/lib/glob-walk.js:16-17, 82): точные пути
 * пишутся как «уже отсутствует», и вайп записан как успешный, хотя ничего не удалено
 * и файлы сервера никуда не делись.
 *
 * Правильное поведение (ответ владельца №3; непонятный ответ агента — сомнение):
 * прогон записан как неудачный с причиной, сервер снова работает.
 *
 * Сценарий: профиль с точными путями (так их добавляет файловый пикер), агент
 * отвечает текстом выше на все запросы. Боевой вайп — только на подменах.
 *
 * Запуск: node tools/review/h04c-data-dir-missing.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const AGENT_ERROR = 'File system error: Data directory does not exist: "/var/lib/catalyst"';

async function wipeWithoutDataDir(t, targets) {
  const sb = createSandbox();
  await sb.load();
  sb.tunnel.fail({ op: 'all', error: AGENT_ERROR });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`прогон: ok=${run.ok}; удалено ${run.deletedCount}; пропущено: ${run.skipped.map((item) => `${item.path} (${item.reason})`).join(', ') || 'нет'}`);
  t.note(`ошибки: ${run.errors.join(' | ') || 'нет'}; статус сервера: ${sb.status()}; на диске изменений: ${sb.tree.diff(before).removed.length}`);
  return { sb, run };
}

test('H4c: у агента нет папки данных, цели — точные пути: вайп не должен быть «успешным»', async (t) => {
  const { sb, run } = await wipeWithoutDataDir(t, [
    '/server/rust/player.blueprints.270.db',
    '/server/rust/proceduralmap.3000.12345.270.sav',
  ]);
  assert.equal(sb.status(), 'running', 'сервер снова работает');
  assert.equal(run.ok, false, 'прогон записан как успешный, хотя агент не дал удалить ни одного файла');
});

test('H4c (для сравнения): то же с масками — прогон неудачный, но с причиной «проверьте маски»', async (t) => {
  const { run } = await wipeWithoutDataDir(t, ['/server/*/player.blueprints.*.db']);
  assert.equal(run.ok, false);
});
