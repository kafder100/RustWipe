/**
 * Ревью RustWipe, гипотеза 10 (раздел 4.2), утверждение H10c:
 * панель упала посреди вайпа — после перезапуска вайп повторяется с начала.
 * nextRunAt переносится только после конца прогона, а признак «выполняется»
 * живёт в памяти. Если панель упала после команды запуска сервера (файлы уже
 * удалены, сервер поднимается на новом мире), то после перезапуска первый же
 * тик видит «просроченный» вайп в окне догона (120 мин) и делает его снова:
 * останавливает уже работающий сервер и стирает новый мир.
 *
 * Правильное поведение (ответ владельца №6 по смыслу: один плановый срок —
 * один вайп; «на одном сервере не больше одного вайпа»): вайп, который уже
 * удалил файлы и запустил сервер, после перезапуска панели не повторяется.
 *
 * Как «падает панель»: первый экземпляр плагина работает через контекст,
 * который можно «убить» (своя обёртка в этом файле — в песочнице такого нет).
 * После kill() все его обращения к панели (db, туннель, коллекции,
 * хранилище) зависают навсегда — как у упавшего процесса. Убиваем в момент,
 * когда ушла команда POST /start. Затем 10 минут панели нет, сервер
 * работает на новом мире; потом панель поднимается: новый экземпляр плагина,
 * onEnable (первый тик сразу) и ещё 5 тиков раз в минуту.
 *
 * Запуск: node tools/review/h10c-panel-crash-repeats-wipe.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, loadPlugin, test } from './sandbox.mjs';

/**
 * Контекст «процесса», который можно убить: после kill() каждый вызов к панели
 * возвращает промис, который никогда не завершится. Синхронные вещи
 * (getConfig, manifest) остаются как есть.
 */
function mortalContext(ctx) {
  let dead = false;
  const never = () => new Promise(() => {});
  const guard = (fn) => (...args) => (dead ? never() : fn(...args));
  const mortal = Object.create(ctx);
  mortal.db = {
    get servers() {
      const servers = ctx.db.servers;
      return {
        findUnique: guard((args) => servers.findUnique(args)),
        findMany: guard((args) => servers.findMany(args)),
        count: guard((args) => servers.count(args)),
        update: guard((id, data) => servers.update(id, data)),
      };
    },
  };
  mortal.fileTunnel = { queueRequest: guard((...args) => ctx.fileTunnel.queueRequest(...args)) };
  mortal.collection = (name) => {
    const real = ctx.collection(name);
    const wrapped = {};
    for (const op of ['find', 'findOne', 'insert', 'update', 'delete', 'count']) wrapped[op] = guard((...args) => real[op](...args));
    return wrapped;
  };
  mortal.getStorage = guard((key) => ctx.getStorage(key));
  mortal.setStorage = guard((key, value) => ctx.setStorage(key, value));
  mortal.emit = (...args) => (dead ? undefined : ctx.emit(...args));
  mortal.logger = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => [level, (...args) => (dead ? undefined : ctx.logger[level](...args))]),
  );
  return {
    ctx: mortal,
    kill() {
      dead = true;
    },
    get dead() {
      return dead;
    },
  };
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

test('панель упала после команды запуска сервера: после перезапуска вайп не повторяется', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  const newWorld = simulateNewWorld(sb);

  // Первый «процесс» панели: плановый тик начинает вайп.
  const mortal = mortalContext(sb.ctx);
  sb.journal.onPush((entry) => {
    if (!mortal.dead && entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/start') mortal.kill();
  });
  const old = await loadPlugin({ ctx: mortal.ctx, routes: sb.routes, tasks: sb.tasks, clock: sb.clock });
  void old.module.runTick(mortal.ctx);
  await sb.until(() => mortal.dead);
  const crashAt = sb.clock.now();

  // Панели нет 10 минут; сервер поднялся и работает на новом мире.
  await sb.clock.advance(10 * 60000);
  assert.equal(sb.status(), 'running', 'предусловие: сервер после первого вайпа работает');
  assert.ok(newWorld.length > 0, 'предусловие: сервер создал новый мир');
  const restartSeq = sb.journal.entries.at(-1).seq;

  // Панель поднялась: новый экземпляр плагина, onEnable и тики раз в минуту.
  await loadPlugin(sb, { enable: true });
  for (let minute = 0; minute < 5; minute += 1) {
    await sb.clock.advance(60000);
    await sb.tick();
  }
  await sb.idle();

  const after = sb.journal.entries.filter((entry) => entry.seq > restartSeq);
  const stops = after.filter((entry) => entry.kind === 'fetch' && entry.method === 'POST' && entry.path === '/api/servers/srv1/stop');
  const deletes = after.filter((entry) => entry.kind === 'tunnel' && entry.op === 'delete').map((entry) => entry.path);
  const lostWorld = newWorld.filter((file) => !sb.tree.exists(file));
  t.note(`панель упала в ${new Date(crashAt).toISOString().slice(11, 19)}; после перезапуска: POST /stop ${stops.length}, удаления: ${deletes.join(', ') || 'нет'}`);
  t.note(`история: ${sb.runs().map((run) => `${run.trigger} ${run.startedAt.slice(11, 19)} ok=${run.ok}`).join('; ') || 'пусто'}; статус сервера: ${sb.status()}`);

  assert.equal(stops.length, 0, 'после перезапуска панели работающий сервер снова остановлен для того же вайпа');
  assert.deepEqual(lostWorld, [], 'после перезапуска панели повторный вайп стёр новый мир');
  assert.equal(sb.status(), 'running');
});
