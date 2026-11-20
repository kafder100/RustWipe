/**
 * Исправление F2b: агент перестал отвечать во время удаления (находка H11b).
 *
 * Панель снимает каждый запрос к агенту через 60 с («Agent file operation
 * timed out», catalyst-backend/src/services/file-tunnel.ts). Раньше плагин
 * ждал так каждый путь и прекращал удаление только после 50 ошибок — сервер
 * стоял до 50 минут.
 *
 * Что проверяем (дополнительно к тесту нашедшего h11b):
 *   1) 3 таймаута подряд — удаление прекращается: запросов delete ровно 3,
 *      в истории понятная причина, сервер снова работает через ~3 минуты;
 *   2) таймауты вперемешку с удачными удалениями — удаление не обрывается:
 *      агент отвечает, просто медленно.
 *
 * Запуск: node tools/review/fix-f2b-agent-timeouts.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

function sandboxWithFiles(count) {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= count; index += 1) files[`/oxide/data/Data${String(index).padStart(2, '0')}.json`] = '{}';
  return createSandbox({ tree: { files } });
}

test('3 таймаута подряд: удаление прекращается, сервер снова работает через несколько минут', async (t) => {
  const sb = sandboxWithFiles(20);
  await sb.load();
  sb.tunnel.hang({ op: 'delete', panelTimeout: true });
  const profile = await sb.addProfile({ targets: ['/oxide/data/*.json'], options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();

  const deletes = sb.tunnel.paths('delete');
  const stopped = sb.journal.entries.find((entry) => entry.kind === 'server' && entry.to === 'stopped');
  const running = sb.journal.entries.filter((entry) => entry.kind === 'server' && entry.to === 'running').at(-1);
  const downMin = (running.at - stopped.at) / 60000;
  t.note(`запросов delete: ${deletes.length}; сервер стоял ${downMin.toFixed(1)} мин; ошибки: ${run.errors.at(-1)}`);
  assert.equal(deletes.length, 3, 'после 3 таймаутов подряд удаления больше не шлют');
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.startsWith('Агент не отвечает')), 'понятная причина в истории');
  assert.equal(sb.status(), 'running');
  assert.ok(downMin < 5, `сервер стоял ${downMin.toFixed(1)} мин`);
});

test('таймауты вперемешку с удачными удалениями: удаление идёт до конца', async (t) => {
  const sb = sandboxWithFiles(6);
  await sb.load();
  sb.tunnel.hang({ op: 'delete', path: /Data0[135]\.json$/, panelTimeout: true });
  const profile = await sb.addProfile({ targets: ['/oxide/data/*.json'], options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();

  t.note(`запросов delete: ${sb.tunnel.paths('delete').length}; удалено ${run.deletedCount}; ошибок ${run.errors.length}`);
  assert.equal(sb.tunnel.paths('delete').length, 6, 'все пути пробовали удалить');
  assert.equal(run.deletedCount, 3);
  assert.ok(!run.errors.some((error) => error.startsWith('Агент не отвечает')));
  assert.equal(sb.status(), 'running');
});
