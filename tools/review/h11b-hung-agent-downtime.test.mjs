/**
 * Ревью RustWipe, гипотеза 11 (раздел 4.2 правил), утверждение H11b —
 * похожая настоящая проблема рядом с H11a.
 *
 * Таймаут есть только у панели (60 с на запрос), общего предела на вайп у плагина
 * нет. Если агент перестал отвечать уже во время удаления, плагин шлёт удаления
 * дальше одно за другим: каждое ждёт 60 с, остановка — только после 50 ошибок
 * (rust-autowipe/backend/lib/wipe.js:18, 231-248; ошибка туннеля ловится
 * в glob-walk.js:84-88). Всё это время сервер стоит.
 *
 * Правильное поведение (ответ владельца №3: при сомнении — остановиться, поднять
 * сервер, записать причину; README: «авто-подъём сервера при ошибке после
 * остановки»): после того как агент перестал отвечать, плагин быстро прекращает
 * удаление и поднимает сервер. Мерка теста: сервер стоит не дольше 10 минут —
 * это больше обычных пределов остановки (300 с) и запуска (240 с).
 *
 * Сценарий: 60 файлов в /oxide/data, агент не отвечает ни на одно удаление
 * (панель снимает каждое через 60 с). Только подмены песочницы.
 *
 * Запуск: node tools/review/h11b-hung-agent-downtime.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

test('H11b: агент не отвечает на удаление — сервер должен снова работать не позже чем через 10 минут', async (t) => {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= 60; index += 1) files[`/oxide/data/Data${String(index).padStart(2, '0')}.json`] = '{}';
  const sb = createSandbox({ tree: { files } });
  await sb.load();
  sb.tunnel.hang({ op: 'delete', panelTimeout: true });
  const profile = await sb.addProfile({ targets: ['/oxide/data/*.json'] });
  const run = await sb.wipe(profile);
  await sb.idle();

  const stopped = sb.journal.entries.find((entry) => entry.kind === 'server' && entry.to === 'stopped');
  const startCall = sb.journal.entries.find(
    (entry) => entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/start',
  );
  assert.ok(stopped && startCall, 'в журнале есть остановка и запуск');
  const downMin = Math.round((startCall.at - stopped.at) / 60000);
  const deletes = sb.tunnel.calls.filter((call) => call.op === 'delete');
  t.note(`запросов delete: ${deletes.length}, все сняты панелью: ${deletes.every((call) => call.error === 'Agent file operation timed out')}`);
  t.note(`сервер стоял ${downMin} мин; прогон ok=${run.ok}; ошибок: ${run.errors.length}; предупреждения: ${run.warnings.join(' | ') || 'нет'}`);
  assert.equal(sb.status(), 'running');
  assert.ok(downMin <= 10, `сервер стоял ${downMin} мин, пока плагин ждал зависшего агента`);
});
