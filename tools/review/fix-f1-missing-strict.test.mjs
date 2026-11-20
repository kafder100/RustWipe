/**
 * F1, находки H4b и H4c (и поломка W2 из L34-4): «нет файла» плагин искал по
 * словам во всём тексте ошибки агента (not found, missing, does not exist…).
 * Агент вставляет в текст путь, поэтому папка с «missing» в имени превращала
 * любую ошибку в «папки нет» — и папка с исключённым файлом удалялась целиком.
 * Сбой ноды «Data directory does not exist» считался «уже удалено», и вайп
 * с точными путями был «успешным», ничего не удалив. Так же по словам
 * определялось «это файл, а не папка» (is a file, not a dir…).
 *
 * Правильное поведение (ответ владельца №3: при сомнении — стоп до удаления):
 * «нет файла» — только ответ агента с кодом ОС в конце
 * «No such file or directory (os error 2)», «это файл» — только
 * «Not a directory (os error 20)». Всё остальное — настоящая ошибка:
 * в обходе исключений вайп останавливается до удаления.
 *
 * Готовые тесты нашедших — h04b-missing-word-in-path и h04c-data-dir-missing.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-missing-strict.test.mjs
 */

import assert from 'node:assert/strict';

import { deletePath, isMissingError } from '../../rust-autowipe/backend/lib/glob-walk.js';
import { createSandbox, test } from './sandbox.mjs';

test('isMissingError: только код ОС «нет такого файла» в конце ответа', () => {
  assert.equal(isMissingError('File system error: Failed to read dir /oxide/data: No such file or directory (os error 2)'), true);
  assert.equal(isMissingError('IO error: No such file or directory (os error 2)'), true);
  assert.equal(isMissingError('File system error: Failed to read dir /oxide/data/MissingItems: Too many open files (os error 24)'), false);
  assert.equal(isMissingError('File system error: Data directory does not exist: "/var/lib/catalyst"'), false);
  assert.equal(isMissingError('File system error: Cannot access path: /var/lib/catalyst/uuid/oxide'), false);
  assert.equal(isMissingError('Permission denied: Access denied: symbolic link leaves the server directory: /x/missing-backup'), false);
  assert.equal(isMissingError('Path not found: /oxide/data'), false);
  assert.equal(isMissingError('Agent file operation timed out'), false);
});

test('deletePath: «нет такого файла» — уже отсутствует, «Data directory does not exist» — ошибка', async () => {
  const server = { nodeId: 'n', uuid: 'u' };
  const answer = (error) => ({ fileTunnel: { queueRequest: async () => ({ success: false, error }) } });
  assert.deepEqual(await deletePath(answer('IO error: No such file or directory (os error 2)'), server, '/a.json'), { ok: true, missing: true });
  const failed = await deletePath(answer('File system error: Data directory does not exist: "/var/lib/catalyst"'), server, '/a.json');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Data directory does not exist/);
  const missingWord = await deletePath(answer('Permission denied: Access denied: path outside data directory (missing)'), server, '/missing.json');
  assert.equal(missingWord.ok, false, 'слово missing в тексте — не «нет файла»');
});

test('L34-4 (W2): Permission denied при чтении /server/rust — вайп не удаляет каталог вместе с исключённым cfg', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.tunnel.fail({ op: 'list', path: '/server/rust', error: 'File system error: Failed to read dir /server/rust: Permission denied (os error 13)' });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/server/*'], excludes: ['/server/*/cfg'] });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`ok=${run.ok}; ошибки: ${run.errors.join(' | ')}; delete: ${sb.tunnel.paths('delete').join(', ') || 'нет'}`);
  assert.deepEqual(sb.tree.diff(before).removed, [], 'при непонятной ошибке листинга ничего не должно удаляться');
  assert.equal(run.ok, false);
  assert.equal(sb.status(), 'running', 'сервер снова работает');
});

test('«Это файл» — тоже только по коду ОС: папка «is a file» с настоящей ошибкой не удаляется целиком', async (t) => {
  const dir = '/oxide/data/is a file';
  const sb = createSandbox({
    tree: { files: { '/RustDedicated': 1024, [`${dir}/keep.json`]: '{"keep":true}', [`${dir}/cache.json`]: '{}' } },
  });
  await sb.load();
  sb.tunnel.fail({ op: 'list', path: dir, error: `File system error: Failed to read dir ${dir}: Too many open files (os error 24)` });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], excludes: ['/oxide/data/*/keep.json'] });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`ok=${run.ok}; ошибки: ${run.errors.join(' | ')}`);
  assert.ok(sb.tree.exists(`${dir}/keep.json`), 'исключённый keep.json удалён');
  assert.deepEqual(sb.tree.diff(before).removed, []);
});

test('Настоящий «нет такого файла» и «это файл» по-прежнему работают в обходе исключений', async (t) => {
  const sb = createSandbox({
    tree: { files: { '/RustDedicated': 1024, '/oxide/data/Kits/keep.json': '{}', '/oxide/data/Kits/data.json': '{}', '/oxide/data/top.json': '{}' } },
  });
  await sb.load();
  const before = sb.tree.snapshot();
  // Точные пути: файл (агент ответит «Not a directory») и путь, которого нет.
  const profile = await sb.addProfile({
    targets: ['/oxide/data/top.json', '/oxide/data/Gone', '/oxide/data/Kits'],
    excludes: ['/oxide/data/*/keep.json', '/oxide/data/top.json/x', '/oxide/data/Gone/x'],
  });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`ok=${run.ok}; удалено: ${run.deleted.join(', ')}; пропущено: ${run.skipped.map((item) => `${item.path} (${item.reason})`).join(', ')}`);
  assert.deepEqual(sb.tree.diff(before).removed, ['/oxide/data/Kits/data.json', '/oxide/data/top.json']);
  assert.ok(run.skipped.some((item) => item.path === '/oxide/data/Gone'), 'отсутствующий путь — «уже отсутствует»');
  assert.equal(run.ok, true, JSON.stringify(run.errors));
});
