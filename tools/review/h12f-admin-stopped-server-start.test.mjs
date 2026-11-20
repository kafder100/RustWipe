/**
 * Ревью RustWipe, гипотеза 12 (раздел 4.2), утверждение H12f:
 * сервер, который админ остановил намеренно, после вайпа запускается.
 *
 * Правильное поведение (ответ владельца №7): запуск после вайпа решает
 * галочка профиля «Запускать сервер после вайпа» (options.startServer).
 * Галочка снята — сервер, остановленный админом, остаётся остановленным;
 * галочка стоит — сервер запускается (так хочет владелец). Тест проверяет
 * обе стороны выбора; проходит — значит, гипотеза как дефект опровергнута.
 *
 * Запуск: node tools/review/h12f-admin-stopped-server-start.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const starts = (sb) => sb.panel.calls.filter((call) => call.method === 'POST' && call.path === '/api/servers/srv1/start');

async function wipeStoppedServer(startServer) {
  const sb = createSandbox();
  await sb.load();
  sb.panel.setStatus('srv1', 'stopped', 'админ остановил сервер');
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ options: { startServer } });
  const run = await sb.wipe(profile);
  await sb.idle();
  return { sb, run, removed: sb.tree.diff(before).removed };
}

test('галочка «Запускать сервер после вайпа» снята: остановленный админом сервер остаётся остановленным', async (t) => {
  const { sb, run, removed } = await wipeStoppedServer(false);
  t.note(`история: ok=${run.ok}; удалено: ${removed.join(', ')}; POST /start: ${starts(sb).length}; статус: ${sb.status()}`);
  assert.deepEqual(removed, [MAP, SAV], 'вайп прошёл');
  assert.equal(starts(sb).length, 0, 'команды запуска не было');
  assert.equal(sb.status(), 'stopped');
});

test('галочка стоит: сервер после вайпа запускается (выбор владельца)', async (t) => {
  const { sb, run, removed } = await wipeStoppedServer(true);
  t.note(`история: ok=${run.ok}; удалено: ${removed.join(', ')}; POST /start: ${starts(sb).length}; статус: ${sb.status()}`);
  assert.deepEqual(removed, [MAP, SAV], 'вайп прошёл');
  assert.equal(starts(sb).length, 1, 'одна команда запуска');
  assert.equal(sb.status(), 'running');
});
