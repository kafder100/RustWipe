/**
 * Ревью RustWipe, гипотеза 10 (раздел 4.2), утверждение H10d:
 * onDisable очищает признак «выполняется» (runningProfiles), даже пока
 * прогон идёт. Сам прогон при этом не останавливается.
 *
 * Факты Catalyst v1.89.2 (catalyst-backend/src/plugins/loader.ts):
 * disablePlugin вызывает onDisable и останавливает задачи, но модуль плагина
 * остаётся загруженным; enablePlugin снова его не импортирует (activatePlugin
 * пропускается, если plugin.backend уже есть) и вызывает onEnable. Значит,
 * после «Выключить → Включить» тот же модуль работает с пустым
 * runningProfiles, а старый вайп ещё идёт.
 *
 * Правильное поведение (ответ владельца №6: на одном сервере не больше одного
 * вайпа одновременно): пока вайп идёт, второй вайп того же профиля не
 * начинается — ни после выключения и включения плагина, ни иначе.
 * Наблюдаемое: прогоны в истории не пересекаются по времени, файлы
 * удаляются только на остановленном сервере.
 *
 * Сценарий: админ жмёт «Запустить сейчас»; удаление карты у агента идёт
 * минуту; админ выключает и включает плагин и жмёт «Запустить сейчас» ещё
 * раз (кнопка снова доступна: вкладка больше не видит, что профиль
 * выполняется). Когда сервер снова работает, «игра» создаёт новый мир.
 *
 * Запуск: node tools/review/h10d-disable-enable-clears-lock.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const MAP = '/server/rust/proceduralmap.3000.12345.270.map';

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

/** Первый раз после вайпа сервер снова работает → игра создаёт новый мир (один раз). */
function simulateNewWorld(sb) {
  const created = [];
  sb.journal.onPush((entry) => {
    if (created.length || entry.kind !== 'server' || entry.id !== 'srv1' || entry.to !== 'running') return;
    const seed = sb.panel.server('srv1').environment.WORLD_SEED;
    for (const ext of ['map', 'sav']) {
      const file = `/server/rust/proceduralmap.3000.${seed}.270.${ext}`;
      if (!sb.tree.exists(file)) {
        sb.tree.add(file, 1024);
        created.push(file);
      }
    }
  });
  return created;
}

function overlapping(runs) {
  const pairs = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const [a, b] = [runs[i], runs[j]];
      if (Date.parse(a.startedAt) < Date.parse(b.finishedAt) && Date.parse(b.startedAt) < Date.parse(a.finishedAt)) {
        pairs.push(`${a.startedAt.slice(11, 19)} и ${b.startedAt.slice(11, 19)}`);
      }
    }
  }
  return pairs;
}

test('выключили и включили плагин посреди вайпа: второй вайп того же профиля не идёт параллельно', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T10:00:00.000Z' });
  const moveTo = (iso) => sb.clock.advance(Date.parse(iso) - sb.clock.now());
  const deletes = watchDeletes(sb);
  const newWorld = simulateNewWorld(sb);
  const profile = await sb.addProfile({ nextRunAt: '2026-11-26T05:00:00.000Z', options: { warnChat: false } });
  sb.tunnel.delay(60000, { op: 'delete', path: MAP, times: 1 });
  await sb.load({ enable: true });
  await sb.idle();

  const first = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  assert.equal(first.status, 200);
  await moveTo('2026-11-19T10:00:10.000Z'); // первый вайп ждёт агента на удалении карты

  // «Выключить» и «Включить» в панели: тот же модуль, onDisable → onEnable.
  await sb.run(sb.plugin.onDisable(sb.ctx));
  sb.tasks.clear();
  await sb.run(sb.plugin.onEnable(sb.ctx));
  const status = await sb.call('admin', 'GET', '/servers/srv1/status');
  const second = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
  t.note(`вкладка после включения: running=${JSON.stringify(status.body?.data?.running)}; второй запуск: ${second.status} ${second.body?.error ?? second.body?.message ?? ''}`);

  await moveTo('2026-11-19T10:10:00.000Z');
  await sb.idle();

  const runs = sb.runs();
  const whileUp = deletes.filter((item) => item.status !== 'stopped');
  t.note(`прогоны: ${runs.map((run) => `${run.startedAt.slice(11, 19)}–${run.finishedAt.slice(11, 19)} ok=${run.ok}${run.ok ? '' : ` [${run.errors[0]}]`}`).join('; ')}`);
  t.note(`удаления: ${deletes.map((item) => `${item.path.split('/').pop()} при ${item.status}`).join(', ')}; новый мир создан: ${newWorld.length ? 'да' : 'нет'}`);
  assert.deepEqual(overlapping(runs), [], 'два вайпа одного профиля шли одновременно');
  assert.deepEqual(whileUp.map((item) => `${item.path} при ${item.status}`), [], 'файлы удалялись на работающем сервере');
});
