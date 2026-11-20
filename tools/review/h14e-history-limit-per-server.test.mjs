/**
 * Ревью RustWipe, гипотеза 14 (раздел 4.2), утверждение H14e:
 * после каждого прогона история обрезается до 200 последних записей на весь
 * плагин (wipe.js: runs.find({}) без фильтра по серверу). Прогоны одного
 * сервера вытесняют историю других серверов.
 *
 * Правильное поведение (ответ владельца №14 «200 на каждый сервер»): у
 * каждого сервера хранится до 200 своих прогонов; вайп одного сервера не
 * удаляет историю другого.
 *
 * Запуск: node tools/review/h14e-history-limit-per-server.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = '2026-11-19T10:00:00.000Z';

/** count старых прогонов сервера: по одному в день назад от NOW. */
function oldRuns(serverId, count) {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.parse(NOW) - (count - index) * DAY).toISOString();
    return {
      id: `run_old_${serverId}_${index}`,
      profileId: `wipe_old_${serverId}`,
      profileName: 'Старый профиль',
      serverId,
      trigger: 'schedule',
      dryRun: false,
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

test('у сервера №2 ровно 200 прогонов, вайп сервера №1 не удаляет его историю', async (t) => {
  const sb = sandboxWithTwoServers(oldRuns('srv2', 200));
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  await sb.wipe(profile);
  await sb.idle();

  const first = await historyOf(sb, 'srv1');
  const second = await historyOf(sb, 'srv2');
  t.note(`после вайпа сервера №1: у сервера №1 прогонов ${first.length}, у сервера №2 — ${second.length} (было 200)`);
  assert.equal(first.length, 1, 'прогон сервера №1 записан');
  assert.equal(second.length, 200, 'вайп сервера №1 удалил историю сервера №2');
});

test('контроль: у одного сервера хранится не больше 200 прогонов', async (t) => {
  const sb = sandboxWithTwoServers(oldRuns('srv1', 200));
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();

  const first = await historyOf(sb, 'srv1');
  t.note(`у сервера №1 прогонов: ${first.length}`);
  assert.equal(first.length, 200);
  assert.ok(first.some((item) => item.id === run.id), 'новый прогон остался, удалён самый старый');
});
