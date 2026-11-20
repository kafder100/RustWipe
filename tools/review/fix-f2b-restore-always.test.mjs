/**
 * Исправление F2b: после неудачного вайпа сервер, который остановил плагин,
 * поднимается всегда (находка L31-8; договорённость К4).
 *
 * Галочка «Запускать сервер после вайпа» (options.startServer) — про запуск
 * после удачного вайпа. Раньше при выключенной галочке сервер оставался
 * выключенным и после ошибки, хотя руководство и README обещают поднять его.
 *
 * Что проверяем (у всех профилей галочка запуска снята):
 *   1) вайп прервался до удаления (удалять нечего) — сервер поднят;
 *   2) удаление с ошибками — сервер поднят;
 *   3) удачный вайп — сервер остаётся остановленным (галочка работает);
 *   4) сервер остановил админ, вайп упал — сервер не запускаем (не мы его
 *      останавливали; ответ владельца №7).
 *
 * Запуск: node tools/review/fix-f2b-restore-always.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const NO_START = { startServer: false, warnChat: false };
const starts = (sb) => sb.panel.calls.filter((call) => call.method === 'POST' && call.path === '/api/servers/srv1/start');

async function wipe(t, { overrides = {}, prepare } = {}) {
  const sb = createSandbox();
  await sb.load();
  if (prepare) prepare(sb);
  const profile = await sb.addProfile({ ...overrides, options: { ...NO_START, ...(overrides.options || {}) } });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`ok=${run.ok}; шаги: ${run.steps.map((step) => `${step.action}${step.ok ? '' : '!'}`).join(' → ')}; POST /start: ${starts(sb).length}; статус: ${sb.status()}`);
  return { sb, run };
}

test('запуск выключен, вайп прервался до удаления: сервер, остановленный плагином, поднят', async (t) => {
  const { sb, run } = await wipe(t, { overrides: { targets: ['/server/*/proceduralmap.9999.*.map'] } });
  assert.equal(run.ok, false);
  assert.ok(run.steps.some((step) => step.action === 'restore-start' && step.ok));
  assert.equal(starts(sb).length, 1);
  assert.equal(sb.status(), 'running');
});

test('запуск выключен, удаление с ошибками: сервер, остановленный плагином, поднят', async (t) => {
  const { sb, run } = await wipe(t, {
    prepare: (box) => box.tunnel.fail({ op: 'delete', path: SAV, error: 'Permission denied: Access denied' }),
  });
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes(SAV)));
  assert.ok(run.steps.some((step) => step.action === 'restore-start' && step.ok));
  assert.equal(sb.status(), 'running');
});

test('запуск выключен, вайп удался: сервер остаётся остановленным', async (t) => {
  const { sb, run } = await wipe(t);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.equal(starts(sb).length, 0);
  assert.equal(sb.status(), 'stopped');
});

test('сервер остановил админ, вайп упал: сервер не запускаем', async (t) => {
  const { sb, run } = await wipe(t, {
    overrides: { targets: ['/server/*/proceduralmap.9999.*.map'] },
    prepare: (box) => box.panel.setStatus('srv1', 'stopped', 'админ остановил сервер'),
  });
  assert.equal(run.ok, false);
  assert.equal(starts(sb).length, 0);
  assert.equal(sb.status(), 'stopped');
});
