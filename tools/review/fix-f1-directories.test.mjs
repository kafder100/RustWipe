/**
 * F1, договорённость К2 (к находке H5b у F2a и F5): предпросмотр показывал
 * каталог одной строкой, без пометки, а вайп удаляет его целиком со всем
 * содержимым. Чтобы вкладка могла это сказать, раскрытие путей отдаёт
 * directories — какие из итоговых путей — каталоги (по листингу агента).
 *
 * Проверяем: каталоги из масок и точные пути-каталоги попадают в
 * directories, файлы — нет; каталог, в который плагин зашёл из-за
 * исключения, в итоговых путях не стоит и в directories тоже.
 * Сам роут предпросмотра отдаёт поле правкой F2a.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-directories.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, test } from './sandbox.mjs';

function tree() {
  return {
    files: {
      '/RustDedicated': 1024,
      '/oxide/data/Kits/keep.json': '{}',
      '/oxide/data/Kits/players.json': '{}',
      '/oxide/data/Clans/clans.json': '{}',
      '/oxide/data/Kits.json': '{}',
      '/oxide/logs/today.txt': 'log',
    },
  };
}

async function expand(t, targets, excludes = []) {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const result = await sb.run(expandTargets(sb.ctx, server, targets, excludes));
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`пути: ${result.paths.join(', ')}; каталоги: ${JSON.stringify(result.directories)}`);
  return result;
}

test('К2: каталоги из маски — в directories, файлы — нет', async (t) => {
  const result = await expand(t, ['/oxide/data/*']);
  assert.deepEqual(result.directories, ['/oxide/data/Clans', '/oxide/data/Kits']);
  assert.ok(result.paths.includes('/oxide/data/Kits.json'));
});

test('К2: точный путь-каталог — в directories, точный путь-файл — нет', async (t) => {
  const result = await expand(t, ['/oxide/logs', '/oxide/data/Kits.json']);
  assert.deepEqual(result.directories, ['/oxide/logs']);
});

test('К2: каталог, в который зашли из-за исключения, — не в итоговых путях и не в directories', async (t) => {
  const result = await expand(t, ['/oxide/data/*'], ['/oxide/data/Kits/keep.json']);
  assert.equal(result.paths.includes('/oxide/data/Kits'), false);
  assert.deepEqual(result.directories, ['/oxide/data/Clans']);
  assert.ok(result.directories.every((path) => result.paths.includes(path)));
});
