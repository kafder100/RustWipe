/**
 * Исправление F2b: остановка перед удалением под защитой тестов (находка L34-3).
 *
 * Раньше во всех тестах подмена панели сразу ставила stopped после stop.
 * Поломки «после stop принимается и running», «таймаут остановки
 * игнорируется», «приостановленный сервер не отменяет вайп» проходили все
 * тесты. Ожидание в плагине идёт по таймерам (опрос раз в 2 с, до 300 с) —
 * здесь оно проходит на поддельных часах песочницы мгновенно.
 *
 * Что проверяем:
 *   1) панель приняла stop, а сервер так и работает (running) — вайп
 *      отменён, ничего не удалено, запускать нечего;
 *   2) сервер висит в stopping — это не «остановлен»: по таймауту вайп
 *      отменён, ничего не удалено;
 *   3) сервер приостановлен (status suspended и suspendedAt) — отказ до
 *      остановки: ни питания, ни туннеля, ни переменных;
 *   4) приостановка стоит, а статус stopped (после «В архив» → «Из архива»),
 *      в том числе для проверки (dry-run), — тот же отказ;
 *   5) роут запуска у приостановленного сервера отвечает 403.
 *
 * Запуск: node tools/review/fix-f2b-stop-guards.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const STOP_PATH = '/api/servers/srv1/stop';
const panelChanges = (sb) =>
  sb.panel.calls
    .filter((call) => ['POST', 'PATCH'].includes(call.method) && /\/(stop|start|restart|kill|variables)$/.test(call.path))
    .map((call) => `${call.method} ${call.path}`);

async function wipe(t, { prepare, overrides = {} } = {}) {
  const sb = createSandbox();
  await sb.load();
  if (prepare) prepare(sb);
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ ...overrides, options: { warnChat: false, ...(overrides.options || {}) } });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`ok=${run.ok}; ошибки: ${run.errors.join(' | ')}; вызовы панели: ${panelChanges(sb).join(', ') || 'нет'}; статус: ${sb.status()}`);
  return { sb, run, removed: sb.tree.diff(before).removed };
}

test('панель приняла stop, а сервер так и работает: вайп отменён, ничего не удалено', async (t) => {
  const { sb, run, removed } = await wipe(t, {
    prepare: (box) => box.panel.fail({ method: 'POST', path: STOP_PATH, status: 200, body: { success: true, acked: true } }),
  });
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.startsWith('Сервер не остановился')));
  assert.deepEqual(removed, []);
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  assert.equal(sb.status(), 'running');
});

test('сервер висит в stopping: это не «остановлен» — вайп отменён по таймауту, ничего не удалено', async (t) => {
  const { sb, run, removed } = await wipe(t, { prepare: (box) => box.panel.behave('srv1', { stop: 'never' }) });
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.startsWith('Сервер не остановился') && error.includes('stopping')));
  assert.deepEqual(removed, []);
  assert.deepEqual(sb.tunnel.paths('delete'), []);
});

test('сервер приостановлен (suspended): отказ до остановки — ни питания, ни туннеля', async (t) => {
  const { sb, run } = await wipe(t, { prepare: (box) => box.panel.suspend('srv1', { reason: 'не оплачен' }) });
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('приостановлен')));
  assert.deepEqual(panelChanges(sb), []);
  assert.deepEqual(sb.tunnel.calls, [], 'туннель не трогали');
});

for (const dryRun of [false, true]) {
  test(`приостановка стоит, а статус stopped${dryRun ? ', проверка (dry-run)' : ''}: тот же отказ`, async (t) => {
    const { sb, run } = await wipe(t, {
      overrides: { options: { dryRun } },
      prepare: (box) => {
        box.panel.suspend('srv1', { reason: 'не оплачен' });
        box.panel.setStatus('srv1', 'stopped', 'админ: «В архив» → «Из архива»');
      },
    });
    assert.equal(run.ok, false);
    assert.ok(run.errors.some((error) => error.includes('приостановлен')));
    assert.deepEqual(panelChanges(sb), []);
    assert.deepEqual(sb.tunnel.calls, [], 'туннель не трогали');
  });
}

test('роут запуска у приостановленного сервера отвечает 403, вайп не начинается', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  sb.panel.suspend('srv1', { reason: 'не оплачен' });
  sb.panel.setStatus('srv1', 'stopped', 'админ: восстановлен из архива');
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  await sb.idle();
  t.note(`ответ: ${res.status} ${res.body?.error ?? ''}`);
  assert.equal(res.status, 403);
  assert.equal(sb.runs().length, 0);
  assert.deepEqual(sb.tunnel.calls, []);
});
