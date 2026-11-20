/**
 * Ревью RustWipe, гипотеза 2 (раздел 4.2 правил), утверждение H2b.
 *
 * Что проверяем: в обходе исключений кончился предел глубины (8 уровней ниже
 * найденного пути). Тогда папка уходит на удаление целиком, хотя глубже в ней
 * лежит исключённый файл. Отметки «список обрезан» при этом нет.
 *
 * Правильное поведение: исключённый файл остаётся на месте на любой глубине
 * (README: исключения — список «не удалять»; ответ владельца №3
 * «Строго выбранные файлы»).
 *
 * Сценарий: цель — всё в /oxide/data; исключён один файл, выбранный в пикере,
 * на 10 уровней ниже папки плагина: /oxide/data/Deep/a/b/c/d/e/f/g/h/i/j/keep.json.
 * Контроль: такой же файл на 5 уровней ниже (предел не достигается).
 * Случай редкий: у данных Oxide обычно 1–3 уровня.
 * Боевой вайп — только на подменах песочницы.
 *
 * Запуск: node tools/review/h02b-depth-limit-exclude.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

async function wipeDeep(t, levels) {
  const deepDir = `/oxide/data/Deep/${'abcdefghij'.slice(0, levels).split('').join('/')}`;
  const keep = `${deepDir}/keep.json`;
  const sb = createSandbox({
    tree: {
      files: {
        '/RustDedicated': 1024,
        [keep]: '{"keep":true}',
        [`${deepDir}/cache.json`]: '{}',
        '/oxide/data/Deep/top.json': '{}',
        '/oxide/data/Kits.json': '{}',
      },
    },
  });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], excludes: [keep] });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`исключён: ${keep}`);
  t.note(`удалено: ${removed.length} записей; keep.json ${sb.tree.exists(keep) ? 'на месте' : 'УДАЛЁН'}; прогон ok=${run.ok}; предупреждения: ${run.warnings.join(' | ') || 'нет'}`);
  t.note(`запросы delete: ${sb.tunnel.paths('delete').join(', ')}`);
  return { sb, keep };
}

test('H2b контроль: исключённый файл на 5 уровней ниже папки плагина остаётся', async (t) => {
  const { sb, keep } = await wipeDeep(t, 5);
  assert.equal(sb.tree.exists(keep), true);
});

test('H2b: исключённый файл на 10 уровней ниже папки плагина тоже должен остаться', async (t) => {
  const { sb, keep } = await wipeDeep(t, 10);
  assert.equal(sb.tree.exists(keep), true, `вайп удалил исключённый файл ${keep}`);
});
