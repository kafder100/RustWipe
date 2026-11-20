/**
 * F1, находка L34-4: тесты выбора файлов не замечали поломок, после которых
 * удаляется не то. Пять поломок проходили все проверки tools/test.mjs:
 *   G3 — маска сегмента без якорей: «*.sav» брала и «….sav.bak»;
 *   S1 — из проверки профиля выпадало «/**»;
 *   G6 — исключение с «**» переставало защищать вложенное;
 *   W2 — любая ошибка листинга считалась пустым каталогом;
 *   W8 — схлопывание путей по префиксу без «/»: /x/Kits поглощал /x/Kits.json.
 *
 * S1 проверяет fix-f1-root-masks, G6 — fix-f1-exclude-doublestar,
 * W2 — fix-f1-missing-strict. Здесь — G3 и W8. tools/test.mjs не тронут
 * (это файл другого исполнителя).
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-selection-guards.test.mjs
 */

import assert from 'node:assert/strict';

import { matchPath, segmentMatcher } from '../../rust-autowipe/backend/lib/glob.js';
import { createSandbox, test } from './sandbox.mjs';

const WORLD = '/server/rust/proceduralmap.3000.12345.270';

test('L34-4 (G3): маска совпадает с именем целиком, а не с его началом или концом', () => {
  assert.equal(segmentMatcher('*.sav').test('proceduralmap.1.sav'), true);
  assert.equal(segmentMatcher('*.sav').test('proceduralmap.1.sav.bak'), false, '«*.sav» взяла «.sav.bak»');
  assert.equal(segmentMatcher('proceduralmap.*').test('old.proceduralmap.1.sav'), false, 'маска совпала с серединой имени');
  assert.equal(segmentMatcher('a?c').test('abcd'), false);
  assert.equal(segmentMatcher('cfg').test('cfg.old'), false);
  assert.equal(matchPath('/server/*/cfg', '/server/rust/cfg2'), false);
});

test('L34-4 (G3): вайп по маске proceduralmap.*.sav не трогает .sav.bak и .sav.1', async (t) => {
  const sb = createSandbox({
    tree: {
      files: {
        '/RustDedicated': 1024,
        [`${WORLD}.sav`]: 2097152,
        [`${WORLD}.sav.1`]: 2097152,
        [`${WORLD}.sav.bak`]: 'ручная копия',
        [`/server/rust/old.${WORLD.split('/').pop()}.sav.txt`]: 'заметка',
      },
    },
  });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/server/*/proceduralmap.*.sav'] });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`удалено: ${removed.join(', ')}; ok=${run.ok}`);
  assert.deepEqual(removed, [`${WORLD}.sav`]);
});

test('L34-4 (W8): цели /oxide/data/Kits и /oxide/data/Kits.json — удаляются обе', async (t) => {
  const sb = createSandbox({
    tree: {
      files: {
        '/RustDedicated': 1024,
        '/oxide/data/Kits/players.json': '{}',
        '/oxide/data/Kits.json': '{}',
        '/oxide/data/KitsExtra.json': '{}',
      },
    },
  });
  await sb.load();
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const expansion = await sb.run(expandTargets(sb.ctx, server, ['/oxide/data/Kits', '/oxide/data/Kits.json', '/oxide/data/Kits*.json']));
  t.note(`пути: ${expansion.paths.join(', ')}`);
  assert.deepEqual(expansion.paths, ['/oxide/data/Kits', '/oxide/data/Kits.json', '/oxide/data/KitsExtra.json']);
  const profile = await sb.addProfile({ targets: ['/oxide/data/Kits', '/oxide/data/Kits.json'] });
  await sb.wipe(profile);
  await sb.idle();
  assert.equal(sb.tree.exists('/oxide/data/Kits.json'), false, '/oxide/data/Kits.json «поглощён» каталогом Kits и не удалён');
  assert.equal(sb.tree.exists('/oxide/data/Kits'), false);
  assert.ok(sb.tree.exists('/oxide/data/KitsExtra.json'));
});
