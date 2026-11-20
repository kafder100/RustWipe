/**
 * Исправление F2b: история — 200 прогонов на каждый сервер
 * (находки L32-5, H14e; тест обрезки из L34-9).
 *
 * Что проверяем:
 *   1) проверки (dry-run) на сервере A не стирают историю сервера B
 *      (раньше 200 проверок на своём сервере вытесняли всю чужую историю);
 *   2) у сервера остаются 200 последних прогонов: 201-й удаляет самый
 *      старый по startedAt, остальные на месте.
 * Подмена коллекций повторяет Catalyst v1.89.2 (limit берёт новые по
 * createdAt, сортировка по startedAt — потом; _id у каждой записи свой).
 *
 * Запуск: node tools/review/fix-f2b-history-per-server.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-11-19T10:00:00.000Z';

/** count старых прогонов сервера: по одному в день назад от NOW, самый старый — первый. */
function oldRuns(serverId, count) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.parse(NOW) - (count - index) * DAY).toISOString();
    return {
      id: `run_old_${serverId}_${index}`,
      profileId: `wipe_old_${serverId}`,
      serverId,
      trigger: 'schedule',
      dryRun: false,
      status: 'ok',
      startedAt: at,
      finishedAt: at,
      ok: true,
      steps: [],
      errors: [],
      warnings: [],
      deleted: [],
      skipped: [],
      deletedCount: 0,
      _createdAt: at,
    };
  });
}

function sandboxWithTwoServers(runs) {
  return createSandbox({
    now: NOW,
    servers: [defaultServer(), defaultServer({ id: 'srv2', uuid: 'c0ffee00-0000-4000-8000-00000000a002', name: 'Rust #2' })],
    collections: { runs },
  });
}

async function historyOf(sb, serverId) {
  const res = await sb.call('admin', 'GET', `/servers/${serverId}/runs`, { query: { limit: 200 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

test('проверки (dry-run) на сервере A не стирают историю сервера B', async (t) => {
  const sb = sandboxWithTwoServers([...oldRuns('srv2', 1), ...oldRuns('srv1', 200)]);
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const checks = [];
  for (let index = 0; index < 5; index += 1) {
    checks.push(await sb.wipe(profile, { dryRun: true }));
    await sb.clock.advance(60000);
  }

  const first = await historyOf(sb, 'srv1');
  const second = await historyOf(sb, 'srv2');
  t.note(`после 5 проверок на сервере №1: у №1 прогонов ${first.length}, у №2 — ${second.length} (было 1)`);
  assert.equal(second.length, 1, 'проверки чужого сервера удалили историю сервера №2');
  assert.equal(first.length, 200, 'у сервера №1 — 200 последних');
  for (const check of checks) assert.ok(first.some((item) => item.id === check.id), 'новые проверки на месте');
  for (let index = 0; index < 5; index += 1) {
    assert.ok(!first.some((item) => item.id === `run_old_srv1_${index}`), `самый старый прогон №${index} удалён`);
  }
});

test('201-й прогон сервера удаляет ровно один — самый старый по startedAt', async (t) => {
  const sb = sandboxWithTwoServers(oldRuns('srv1', 200));
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();

  const first = await historyOf(sb, 'srv1');
  const ids = new Set(first.map((item) => item.id));
  t.note(`у сервера №1 прогонов: ${first.length}; самый старый удалён: ${!ids.has('run_old_srv1_0')}`);
  assert.equal(first.length, 200);
  assert.ok(ids.has(run.id), 'новый прогон остался');
  assert.ok(!ids.has('run_old_srv1_0'), 'удалён самый старый');
  for (let index = 1; index < 200; index += 1) assert.ok(ids.has(`run_old_srv1_${index}`), `прогон №${index} на месте`);
  assert.equal(sb.runs().length, 200, 'в коллекции ровно 200 записей');
});
