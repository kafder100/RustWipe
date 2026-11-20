/**
 * Исправление F2b: долгая остановка сервера (находка L33-2).
 *
 * Catalyst v1.89.2 держит POST /api/servers/:id/stop, пока агент не подтвердит
 * остановку, — до 60 с (routes/servers/power.ts, POWER_ACK_TIMEOUT.stop), потом
 * отвечает 200 или 202 («команда принята, итог — по статусу»). Раньше плагин
 * обрывал запрос через 20 с, считал, что сервер не останавливал, и после
 * ошибки не поднимал его.
 *
 * Что проверяем:
 *   1) остановка 50 с (ответ 200 через 50 с) — вайп проходит;
 *   2) остановка 90 с (ответ 202 через 60 с, stopped через 90 с) — вайп проходит;
 *   3) ответ на POST /stop потерян, а сервер останавливается — плагин ждёт
 *      статус stopped и делает вайп;
 *   4) вайп упал, пока сервер ещё stopping, — плагин дожидается stopped и
 *      поднимает сервер (без 409 «Cannot start server in stopping state»);
 *   5) панель отказала в остановке (409) — сервер не трогали, запуска нет.
 *
 * Запуск: node tools/review/fix-f2b-stop-timeout.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const STOP_PATH = '/api/servers/srv1/stop';
const START_PATH = '/api/servers/srv1/start';

const callsTo = (sb, path) => sb.panel.calls.filter((call) => call.method === 'POST' && call.path === path);
const describe = (sb, run) =>
  `ok=${run.ok}; ошибки: ${run.errors.join(' | ') || 'нет'}; POST /stop → ${callsTo(sb, STOP_PATH).map((call) => call.status ?? call.outcome).join(', ')}; ` +
  `POST /start → ${callsTo(sb, START_PATH).map((call) => call.status ?? call.outcome).join(', ') || 'не было'}; статус в конце: ${sb.status()}`;

async function wipeWith(t, { behavior = {}, config = {}, prepare } = {}) {
  const sb = createSandbox({ config });
  await sb.load();
  sb.panel.behave('srv1', behavior);
  if (prepare) prepare(sb);
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(describe(sb, run));
  return { sb, run, removed: sb.tree.diff(before).removed };
}

test('остановка 50 с: панель отвечает 200 через 50 с — вайп проходит, сервер снова работает', async (t) => {
  const { sb, run, removed } = await wipeWith(t, { behavior: { stopMs: 50000 } });
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.deepEqual(removed, [MAP, SAV]);
  assert.equal(sb.status(), 'running');
});

test('остановка 90 с: панель отвечает 202 через 60 с — это «принято», вайп ждёт stopped и проходит', async (t) => {
  const { sb, run, removed } = await wipeWith(t, { behavior: { stopMs: 90000 } });
  assert.equal(callsTo(sb, STOP_PATH)[0].status, 202, 'предусловие: панель ответила 202');
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.deepEqual(removed, [MAP, SAV]);
  assert.equal(sb.status(), 'running');
});

test('ответ на POST /stop потерян, а сервер останавливается: плагин ждёт stopped и делает вайп', async (t) => {
  const { sb, run, removed } = await wipeWith(t, {
    prepare(box) {
      box.panel.hang({ method: 'POST', path: STOP_PATH });
      // Команда дошла до агента, но ответа плагин не получит: сервер сам
      // уходит в stopping и через 100 с становится stopped.
      box.journal.onPush((entry) => {
        if (entry.kind === 'fetch' && entry.method === 'POST' && entry.path === STOP_PATH && entry.outcome === 'pending') {
          box.panel.setStatus('srv1', 'stopping', 'агент: остановка');
          globalThis.setTimeout(() => box.panel.setStatus('srv1', 'stopped', 'агент: сервер остановлен'), 100000);
        }
      });
    },
  });
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.deepEqual(removed, [MAP, SAV]);
  assert.equal(sb.status(), 'running');
});

test('вайп упал, пока сервер ещё stopping: плагин ждёт stopped и поднимает сервер без 409', async (t) => {
  const { sb, run, removed } = await wipeWith(t, { behavior: { stopMs: 100000 }, config: { stopTimeoutSec: 30 } });
  assert.equal(run.ok, false, 'предусловие: сервер не остановился за 30 с');
  assert.deepEqual(removed, [], 'ничего не удалено');
  const starts = callsTo(sb, START_PATH);
  assert.equal(starts.length, 1, 'одна команда запуска');
  assert.equal(starts[0].status, 200, 'запуск принят панелью, а не отклонён с 409');
  assert.equal(starts[0].serverStatus, 'stopped', 'запуск отправлен уже после остановки');
  await sb.idle();
  assert.equal(sb.status(), 'running');
});

test('панель отказала в остановке (409): сервер не трогали, запуска после ошибки нет', async (t) => {
  const { sb, run, removed } = await wipeWith(t, {
    prepare(box) {
      box.panel.fail({ method: 'POST', path: STOP_PATH, status: 409, body: { error: 'Cannot stop server in installing state.' } });
    },
  });
  assert.equal(run.ok, false);
  assert.deepEqual(removed, []);
  assert.equal(callsTo(sb, START_PATH).length, 0, 'сервер не останавливали — и запускать его не нужно');
  assert.ok(!run.steps.some((step) => step.action === 'restore-start'));
  assert.equal(sb.status(), 'running');
});
