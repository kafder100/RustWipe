/**
 * Ревью RustWipe, гипотеза 2 (раздел 4.2 правил), утверждение H2c.
 *
 * Что проверяем: раскрытие путей упёрлось в предел (250 запросов list или
 * 500 путей), плагин это заметил, но вайп всё равно удаляет найденную часть,
 * запускает сервер и пишет прогон как успешный — с одним предупреждением.
 * Получается половина вайпа: часть файлов удалена, часть осталась.
 *
 * Правильное поведение (ответ владельца №3 «Строго выбранные файлы» и текст
 * вопроса «по умолчанию»: при сомнении вайп останавливается до удаления, сервер
 * поднимается, в истории причина): при исчерпанном пределе ничего не удалено,
 * сервер снова работает, прогон записан как неудачный.
 *
 * Сценарии (без исключений, только предел):
 *   1) 260 папок плагинов, цель — json-файлы в каждой папке → предел листингов;
 *   2) 600 файлов в /oxide/data, цель — всё в /oxide/data → предел 500 путей.
 * Боевой вайп — только на подменах песочницы.
 *
 * Запуск: node tools/review/h02c-limit-keeps-deleting.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

function treeWith(files) {
  return { files: { '/RustDedicated': 1024, '/server/rust/cfg/server.cfg': 'x', ...files } };
}

async function wipeAndCheck(t, { files, targets }) {
  const sb = createSandbox({ tree: treeWith(files) });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const deletes = sb.tunnel.paths('delete').length;
  t.note(`запросов list: ${sb.tunnel.paths('list').length}; запросов delete: ${deletes}; удалено записей: ${removed.length}`);
  t.note(`прогон: ok=${run.ok}; ошибки: ${run.errors.join(' | ') || 'нет'}; предупреждения: ${run.warnings.join(' | ') || 'нет'}`);
  t.note(`статус сервера после вайпа: ${sb.status()}`);
  assert.equal(deletes, 0, `при исчерпанном пределе вайп удалил ${removed.length} записей`);
  assert.equal(sb.status(), 'running', 'сервер должен снова работать');
  assert.equal(run.ok, false, 'прогон должен быть записан как неудачный, с причиной');
}

test('H2c: предел листингов (260 папок) — вайп должен остановиться до удаления', async (t) => {
  const files = {};
  for (let index = 1; index <= 260; index += 1) {
    files[`/oxide/data/Plugin${String(index).padStart(3, '0')}/data.json`] = '{}';
  }
  await wipeAndCheck(t, { files, targets: ['/oxide/data/*/*.json'] });
});

test('H2c: предел 500 путей (600 файлов) — вайп должен остановиться до удаления', async (t) => {
  const files = {};
  for (let index = 1; index <= 600; index += 1) {
    files[`/oxide/data/Data${String(index).padStart(3, '0')}.json`] = '{}';
  }
  await wipeAndCheck(t, { files, targets: ['/oxide/data/*'] });
});
