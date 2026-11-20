/**
 * Ревью RustWipe, гипотеза 4 (раздел 4.2 правил), утверждение H4b —
 * похожая настоящая проблема рядом с H4a.
 *
 * Плагин решает «нет файла» поиском слов (not found, no such file, does not exist,
 * enoent, missing, не найден) во ВСЁМ тексте ошибки агента
 * (rust-autowipe/backend/lib/glob-walk.js:16-17, 28-30, 59). А агент вставляет
 * в текст путь: «File system error: Failed to read dir <путь>: <ошибка ОС>»
 * (catalyst-agent/src/file_manager.rs:1190; текст уходит в панель как есть —
 * catalyst-agent/src/file_tunnel.rs:346). Значит, у папки с таким словом в имени
 * любая ошибка чтения выглядит как «папки нет».
 *
 * Сценарий: цель — всё в /oxide/data, исключение — keep.json в каждой папке.
 * Чтение одной папки один раз срывается настоящей ошибкой ОС («Too many open
 * files»). Папка MissingItems — плагин считает её пустой и удаляет целиком
 * вместе с keep.json. Контроль — та же ошибка у папки ItemsCache: плагин
 * останавливает вайп до удаления.
 *
 * Правильное поведение (ответ владельца №3; «непонятный ответ агента» —
 * сомнение): исключённый keep.json остаётся, исход не зависит от имени папки.
 * Боевой вайп — только на подменах песочницы.
 *
 * Запуск: node tools/review/h04b-missing-word-in-path.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const EXCLUDE = '/oxide/data/*/keep.json';

async function wipeWithListError(t, folder) {
  const dir = `/oxide/data/${folder}`;
  const sb = createSandbox({
    tree: {
      files: {
        '/RustDedicated': 1024,
        [`${dir}/keep.json`]: '{"keep":true}',
        [`${dir}/items.json`]: '{}',
        '/oxide/data/Kits/keep.json': '{"keep":true}',
        '/oxide/data/Kits/players.json': '{}',
      },
    },
  });
  await sb.load();
  sb.tunnel.fail({
    op: 'list',
    path: dir,
    times: 1,
    error: `File system error: Failed to read dir ${dir}: Too many open files (os error 24)`,
  });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], excludes: [EXCLUDE] });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`удалено: ${sb.tree.diff(before).removed.join(', ') || 'ничего'}`);
  t.note(`прогон: ok=${run.ok}; ошибки: ${run.errors.join(' | ') || 'нет'}; статус сервера: ${sb.status()}`);
  return { sb, keep: `${dir}/keep.json` };
}

test('H4b контроль: ошибка чтения папки ItemsCache — keep.json на месте', async (t) => {
  const { sb, keep } = await wipeWithListError(t, 'ItemsCache');
  assert.equal(sb.tree.exists(keep), true);
});

test('H4b: та же ошибка у папки MissingItems — keep.json тоже должен остаться', async (t) => {
  const { sb, keep } = await wipeWithListError(t, 'MissingItems');
  assert.equal(sb.tree.exists(keep), true, `вайп удалил исключённый ${keep}: ошибку агента принял за «нет папки»`);
});
