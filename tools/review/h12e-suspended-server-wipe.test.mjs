/**
 * Ревью RustWipe, гипотеза 12 (раздел 4.2), утверждение H12e:
 * приостановку роуты проверяют по suspendedAt (index.js, serverAccess), а сам
 * вайп — только по status === 'suspended' (wipe.js). Плановый тик suspendedAt
 * не смотрит вовсе. Если у приостановленного сервера статус не 'suspended',
 * плановый вайп удаляет его файлы через туннель (туннель приостановку не
 * проверяет).
 *
 * Факты Catalyst v1.89.2:
 *   - приостановка ставит status 'suspended' и suspendedAt одной записью
 *     (routes/servers/power.ts, POST /:serverId/suspend), смену статуса от
 *     агента панель для приостановленного сервера игнорирует
 *     (websocket/gateway.ts, server_state_update и server_state_sync);
 *   - но «В архив» и «Из архива» (routes/servers/admin-ops.ts,
 *     POST /:serverId/archive и /:serverId/restore) меняют статус, не глядя на
 *     suspendedAt и не снимая его: приостановленный сервер после архива и
 *     восстановления — status 'stopped', suspendedAt стоит;
 *   - сама панель файлы приостановленного сервера менять не даёт: файловые
 *     роуты идут через ensureServerAccess → ensureNotSuspended (423)
 *     (routes/servers/_helpers.ts).
 *
 * Правильное поведение (как в панели): пока стоит suspendedAt, вайп не идёт —
 * ничего не удалено, остановки, запуска и смены сида нет.
 *
 * Запуск: node tools/review/h12e-suspended-server-wipe.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const changesOf = (sb) =>
  sb.panel.calls
    .filter((call) => ['POST', 'PATCH'].includes(call.method) && /\/(stop|start|restart|kill|variables)$/.test(call.path))
    .map((call) => `${call.method} ${call.path} → ${call.status ?? call.outcome}`);

async function scheduledTick(t, prepare) {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  await sb.load();
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  prepare(sb);
  const before = sb.tree.snapshot();
  await sb.tick();
  await sb.idle();
  const [run] = sb.runs();
  const removed = sb.tree.diff(before).removed;
  t.note(`suspendedAt: ${sb.panel.server('srv1').suspendedAt ? 'стоит' : 'нет'}; статус до тика: ${sb.panel.history('srv1').at(-1)?.to}`);
  t.note(`история: ${run ? `ok=${run.ok}, ошибки: ${run.errors.join(' | ') || 'нет'}` : 'нет записи'}; удалено: ${removed.join(', ') || 'ничего'}`);
  t.note(`вызовы питания и переменных: ${changesOf(sb).join('; ') || 'нет'}`);
  return { sb, removed };
}

test('приостановленный сервер после «В архив» и «Из архива» (status stopped, suspendedAt стоит): плановый вайп ничего не удаляет', async (t) => {
  const { sb, removed } = await scheduledTick(t, (box) => {
    box.panel.suspend('srv1', { reason: 'не оплачен' });
    box.panel.setStatus('srv1', 'archived', 'админ: POST /archive');
    box.panel.setStatus('srv1', 'stopped', 'админ: POST /restore');
  });
  assert.deepEqual(removed, [], 'у приостановленного сервера удалены файлы');
  assert.deepEqual(sb.tunnel.paths('delete'), [], 'в туннель ушли удаления для приостановленного сервера');
});

test('контроль: приостановленный сервер со статусом suspended — плановый вайп ничего не удаляет', async (t) => {
  const { sb, removed } = await scheduledTick(t, (box) => box.panel.suspend('srv1', { reason: 'не оплачен' }));
  assert.deepEqual(removed, []);
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  assert.deepEqual(changesOf(sb), []);
});

test('контроль: ручной запуск у приостановленного сервера — роут отказывает, ничего не удалено', async () => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile();
  sb.panel.suspend('srv1');
  sb.panel.setStatus('srv1', 'stopped', 'админ: восстановлен из архива');
  const before = sb.tree.snapshot();
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.idle();
  assert.notEqual(res.status, 200, 'запуск не принят');
  assert.deepEqual(sb.tree.diff(before).removed, []);
});
