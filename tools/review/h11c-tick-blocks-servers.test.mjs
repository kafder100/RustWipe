/**
 * Ревью RustWipe, гипотеза 11 (раздел 4.2 правил), утверждение H11c.
 *
 * Что проверяем: тик планировщика последовательный и с флагом «занят»
 * (rust-autowipe/backend/index.js:553-556, 572-612): пока идёт вайп одного
 * сервера, следующие тики сразу выходят. У других серверов не уходят
 * предупреждения в чат и не начинается плановый вайп.
 *
 * Правильное поведение (README: предупреждения «за 5, 4, 3, 2 и 1 минуту до
 * планового вайпа»; у каждого профиля своё расписание; задача панели
 * «каждую минуту»): вайп сервера А не мешает серверу Б — все 5 предупреждений
 * уходят, вайп Б начинается в своё время (не позже 2 минут).
 *
 * Сценарии (сервер А на ноде node1, сервер Б на ноде node2):
 *   - контроль: у А всё быстро;
 *   - агент А перестал отвечать на удаление (панель снимает запрос через 60 с,
 *     см. H11b), вайп Б назначен через 10 минут после А;
 *   - сбоя нет, просто А долго сохраняет мир при остановке (4 минуты, предел
 *     ожидания остановки — 300 с), вайп Б назначен через 5 минут после А.
 * Cron панели эмулируется вызовом тика раз в минуту виртуального времени.
 * Только подмены песочницы.
 *
 * Запуск: node tools/review/h11c-tick-blocks-servers.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const UUID_A = 'c0ffee00-0000-4000-8000-00000000a001';
const UUID_B = 'c0ffee00-0000-4000-8000-00000000b002';

async function twoServers(t, { agentAHangs = false, slowStopA = false, planBMinutes }) {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= 60; index += 1) files[`/oxide/data/A${String(index).padStart(2, '0')}.json`] = '{}';
  const sb = createSandbox({
    tree: { uuid: UUID_A, files },
    servers: [
      defaultServer({ id: 'srv1', uuid: UUID_A, nodeId: 'node1', name: 'Rust A' }),
      defaultServer({ id: 'srv2', uuid: UUID_B, nodeId: 'node2', name: 'Rust B' }),
    ],
    nodes: ['node1', 'node2'],
  });
  sb.tree.addHost(`/var/lib/catalyst/${UUID_B}/oxide/data/B01.json`, '{}');
  await sb.load();
  if (agentAHangs) sb.tunnel.hang({ op: 'delete', nodeId: 'node1', panelTimeout: true });
  // Панель сразу отвечает на POST /stop, а сервер останавливается 4 минуты.
  if (slowStopA) sb.panel.behave('srv1', { stopMs: 240000, stopAckMs: 0 });

  const t0 = sb.clock.now();
  const planB = new Date(t0 + planBMinutes * 60000).toISOString();
  await sb.addProfile({
    serverId: 'srv1',
    targets: ['/oxide/data/*.json'],
    nextRunAt: new Date(t0).toISOString(),
    options: { warnChat: false },
  });
  const profileB = await sb.addProfile({ serverId: 'srv2', targets: ['/oxide/data/*.json'], nextRunAt: planB });

  // Cron панели: тик каждую минуту, не дожидаясь предыдущего.
  const ticks = [sb.module.runTick(sb.ctx)];
  for (let minute = 1; minute <= 70; minute += 1) {
    await sb.clock.advance(60000);
    ticks.push(sb.module.runTick(sb.ctx));
  }
  await sb.run(Promise.all(ticks));
  await sb.idle();

  const runB = sb.runs().find((run) => run.profileId === profileB.id);
  const lateB = runB ? Math.round((Date.parse(runB.startedAt) - Date.parse(planB)) / 60000) : null;
  const warningsB = sb.panel.console('srv2').filter((item) => item.command.startsWith('say '));
  const runA = sb.runs().find((run) => run.serverId === 'srv1');
  t.note(`вайп А: ${runA ? `${Math.round(runA.durationMs / 60000)} мин, ok=${runA.ok}` : 'не записан'}`);
  t.note(`вайп Б: ${runB ? `начался с опозданием ${lateB} мин` : 'не начался за 70 минут'}; предупреждений в чат Б: ${warningsB.length} из 5 (${warningsB.map((item) => item.command.replace(/^say /, '')).join(' | ') || '—'})`);
  assert.equal(warningsB.length, 5, `серверу Б ушло ${warningsB.length} предупреждений из 5`);
  assert.ok(runB && lateB <= 2, `вайп Б опоздал на ${lateB} мин`);
}

test('H11c контроль: у сервера А всё быстро — у сервера Б 5 предупреждений и вайп вовремя', async (t) => {
  await twoServers(t, { planBMinutes: 10 });
});

test('H11c: агент сервера А завис — предупреждения и вайп сервера Б всё равно должны идти вовремя', async (t) => {
  await twoServers(t, { agentAHangs: true, planBMinutes: 10 });
});

test('H11c: сервер А долго останавливается (4 мин, без сбоя) — у сервера Б всё равно 5 предупреждений', async (t) => {
  await twoServers(t, { slowStopA: true, planBMinutes: 5 });
});
