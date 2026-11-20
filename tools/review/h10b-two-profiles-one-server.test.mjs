/**
 * Ревью RustWipe, гипотеза 10 (раздел 4.2), утверждение H10b:
 * блокировка «уже выполняется» стоит на профиль, а не на сервер. Два профиля
 * одного сервера (например, «Карта» и «Чертежи») могут вайпать сервер
 * одновременно: второй видит сервер остановленным первым, удаляет своё и
 * запускает сервер, пока первый ещё удаляет файлы.
 *
 * Правильное поведение (ответ владельца №6): на одном сервере одновременно
 * не больше одного вайпа, даже из разных профилей. Как этого добиться (отказ
 * или очередь), тест не решает. Он проверяет наблюдаемое:
 *   - прогоны одного сервера в истории не пересекаются по времени;
 *   - каждый файл удаляется, пока сервер остановлен.
 *
 * Удаление карты у первого профиля нарочно медленное (агент отвечает через
 * 20–90 с), чтобы второй вайп пришёлся на середину первого.
 *
 * Запуск: node tools/review/h10b-two-profiles-one-server.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';
const BLUEPRINTS = '/server/rust/player.blueprints.270.db';
const FAR = '2026-11-26T05:00:00.000Z';

/** Статус сервера в момент, когда агент выполнил каждое удаление. */
function watchDeletes(sb) {
  const done = [];
  sb.journal.onPush((entry) => {
    if (entry.kind === 'tunnel' && entry.op === 'delete' && entry.outcome === 'ok' && !done.some((item) => item.seq === entry.seq)) {
      done.push({ seq: entry.seq, path: entry.path, status: sb.status() });
    }
  });
  return done;
}

function overlapping(runs) {
  const pairs = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const [a, b] = [runs[i], runs[j]];
      if (Date.parse(a.startedAt) < Date.parse(b.finishedAt) && Date.parse(b.startedAt) < Date.parse(a.finishedAt)) {
        pairs.push(`${a.profileName} и ${b.profileName}`);
      }
    }
  }
  return pairs;
}

const describeRuns = (runs) =>
  runs
    .map((run) => `${run.profileName} (${run.trigger}) ${run.startedAt.slice(11, 19)}–${run.finishedAt.slice(11, 19)} ok=${run.ok}${run.ok ? '' : ` [${run.errors[0]}]`}`)
    .join('; ');

async function setup() {
  const sb = createSandbox({ now: '2026-11-19T10:00:00.000Z' });
  const moveTo = (iso) => sb.clock.advance(Date.parse(iso) - sb.clock.now());
  const deletes = watchDeletes(sb);
  const a = await sb.addProfile({ name: 'Карта', targets: [MAP], nextRunAt: FAR, options: { warnChat: false } });
  return { sb, moveTo, deletes, a };
}

function check(t, sb, deletes) {
  const runs = sb.runs().filter((run) => run.serverId === 'srv1');
  const whileUp = deletes.filter((item) => item.status !== 'stopped');
  t.note(`прогоны: ${describeRuns(runs)}`);
  t.note(`удаления: ${deletes.map((item) => `${item.path.split('/').pop()} при ${item.status}`).join(', ')}`);
  assert.deepEqual(overlapping(runs), [], 'два вайпа одного сервера шли одновременно');
  assert.deepEqual(whileUp.map((item) => `${item.path} при ${item.status}`), [], 'файлы удалялись на работающем сервере');
}

test('два ручных запуска разных профилей одного сервера: вайпы не идут одновременно', async (t) => {
  const { sb, moveTo, deletes, a } = await setup();
  const b = await sb.addProfile({ name: 'Чертежи', targets: [BLUEPRINTS], nextRunAt: FAR, options: { warnChat: false } });
  sb.tunnel.delay(20000, { op: 'delete', path: MAP, times: 1 });
  await sb.load();

  const first = await sb.call('admin', 'POST', `/servers/srv1/profiles/${a.id}/run`, { body: {} });
  assert.equal(first.status, 200);
  await moveTo('2026-11-19T10:00:06.000Z'); // первый вайп удаляет карту
  const second = await sb.call('admin', 'POST', `/servers/srv1/profiles/${b.id}/run`, { body: {} });
  t.note(`второй запуск во время первого: ${second.status} ${second.body?.error ?? second.body?.message ?? ''}`);
  await moveTo('2026-11-19T10:10:00.000Z');
  await sb.idle();

  check(t, sb, deletes);
});

test('ручной вайп одного профиля и плановый другого профиля того же сервера: не одновременно', async (t) => {
  const { sb, moveTo, deletes, a } = await setup();
  await sb.addProfile({ name: 'Чертежи', targets: [BLUEPRINTS], nextRunAt: '2026-11-19T10:01:00.000Z', options: { warnChat: false } });
  sb.tunnel.delay(90000, { op: 'delete', path: MAP, times: 1 });
  await sb.load({ enable: true });
  await sb.idle();

  const first = await sb.call('admin', 'POST', `/servers/srv1/profiles/${a.id}/run`, { body: {} });
  assert.equal(first.status, 200);
  await moveTo('2026-11-19T10:01:00.050Z');
  await sb.tick(); // cron: время планового вайпа «Чертежей», ручной вайп «Карты» ещё удаляет
  await moveTo('2026-11-19T10:10:00.000Z');
  await sb.idle();

  check(t, sb, deletes);
});
