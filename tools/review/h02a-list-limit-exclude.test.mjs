/**
 * Ревью RustWipe, гипотеза 2 (раздел 4.2 правил), утверждение H2a.
 *
 * Что проверяем: в обходе исключений кончился предел листингов (250 запросов
 * list на один прогон). После этого list() молча отдаёт пустой список, и папка,
 * внутри которой лежит исключённый файл, удаляется целиком — «как пустая».
 *
 * Правильное поведение: исключённые файлы остаются на месте при любом числе
 * папок (README: исключения — список «не удалять»; ответ владельца №3
 * «Строго выбранные файлы»: при сомнении лишнего не удалять).
 *
 * Сценарий: сервер с большим Oxide — 260 папок плагинов в /oxide/data,
 * в каждой keep.json (исключён) и data.json. Профиль: цель — всё в /oxide/data,
 * исключение — keep.json в каждой папке (шаблон EXCLUDE ниже).
 * Боевой вайп — только на подменах песочницы.
 * Контроль: те же настройки на 20 папках (предел не достигается).
 *
 * Запуск: node tools/review/h02a-list-limit-exclude.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const EXCLUDE = '/oxide/data/*/keep.json';

function oxideTree(folders) {
  const files = {
    '/RustDedicated': 1024,
    '/server/rust/cfg/server.cfg': 'server.hostname "Rust"\n',
  };
  for (let index = 1; index <= folders; index += 1) {
    const name = `Plugin${String(index).padStart(3, '0')}`;
    files[`/oxide/data/${name}/keep.json`] = '{"keep":true}';
    files[`/oxide/data/${name}/data.json`] = '{}';
  }
  return { files };
}

async function wipeWithExclude(t, folders) {
  const sb = createSandbox({ tree: oxideTree(folders) });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], excludes: [EXCLUDE] });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const lostKeep = removed.filter((item) => item.endsWith('/keep.json'));
  const lists = sb.tunnel.paths('list').length;
  t.note(`папок: ${folders}; запросов list: ${lists}; удалено записей: ${removed.length}; удалено исключённых keep.json: ${lostKeep.length}`);
  t.note(`прогон: ok=${run.ok}; предупреждения: ${run.warnings.join(' | ') || 'нет'}`);
  if (lostKeep.length) t.note(`например: ${lostKeep.slice(0, 2).join(', ')}`);
  return { sb, run, lostKeep };
}

test('H2a контроль: 20 папок — исключённые keep.json на месте', async (t) => {
  const { lostKeep } = await wipeWithExclude(t, 20);
  assert.deepEqual(lostKeep, []);
});

test('H2a: 260 папок — после предела листингов исключённые keep.json всё равно должны остаться', async (t) => {
  const { lostKeep } = await wipeWithExclude(t, 260);
  assert.deepEqual(lostKeep, [], `вайп удалил исключённые файлы (${lostKeep.length} шт.)`);
});
