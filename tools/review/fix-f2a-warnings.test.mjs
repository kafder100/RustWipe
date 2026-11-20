/**
 * Исправление F2a: предупреждения в чат и их состояние во вкладке.
 *
 *  - H15a, H15b: отсчёт «Вайп через N мин» уходит только перед настоящим
 *    вайпом — не у профиля в режиме проверки и не при глобальном dryRun
 *    (ответ владельца №15);
 *  - H15c, договорённость К7: GET …/status показывает состояние
 *    предупреждений только этого сервера. index.js вызывает
 *    getWarningState(server.id) — в этой ветке warnings.js ещё общий на все
 *    серверы (часть F3), поэтому здесь он подменён: проверяем, что спрашивают
 *    именно этот сервер, а чужое состояние вкладка не получает в любом случае.
 *
 * Запуск: node tools/review/fix-f2a-warnings.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

// ── Подмена lib/warnings.js для index.js (только пока stub.warnings задан) ─
const stub = { warnings: null };
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const version = /[?&]rwsandbox=(\d+)/.exec(context.parentURL || '')?.[1];
    if (!stub.warnings || !version || !/\/backend\/index\.js\?/.test(context.parentURL || '')) return result;
    const file = result.url.split('?')[0];
    if (!file.endsWith('/lib/warnings.js')) return result;
    const real = JSON.stringify(`${file}?rwsandbox=${version}`);
    const source =
      `export * from ${real};\n` +
      'export function getWarningState(serverId) { return globalThis.__f2aWarnStub(serverId); }\n';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

const UUID2 = 'c0ffee00-0000-4000-8000-00000000b002';
const twoServers = () => [defaultServer({ id: 'srv1' }), defaultServer({ id: 'srv2', uuid: UUID2, name: 'Rust #2', ownerId: 'user_admin' })];

test('профиль в режиме проверки и глобальный dryRun: ни одного предупреждения; боевой профиль — пять', async (t) => {
  const counts = {};
  for (const [name, config, options] of [
    ['боевой', {}, { dryRun: false }],
    ['проверка у профиля', {}, { dryRun: true }],
    ['глобальный dryRun', { dryRun: true }, { dryRun: false }],
  ]) {
    const sb = createSandbox({ now: '2026-11-19T04:54:00.050Z', config });
    await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options });
    await sb.load();
    for (let minute = 0; minute < 6; minute += 1) {
      await sb.tick();
      await sb.clock.advance(60000);
    }
    counts[name] = sb.panel.console('srv1').filter((item) => item.command.startsWith('say ')).length;
    sb.restore();
  }
  t.note(JSON.stringify(counts));
  assert.deepEqual(counts, { боевой: 5, 'проверка у профиля': 0, 'глобальный dryRun': 0 });
});

test('К7: статус спрашивает состояние своего сервера и не показывает чужое', async (t) => {
  const asked = [];
  const states = {
    srv1: { at: '2026-11-19T00:00:00.000Z', ok: true, serverId: 'srv1', text: 'Вайп сервера через 5 мин' },
    srv2: { at: '2026-11-19T00:00:00.000Z', ok: false, serverId: 'srv1', error: 'чужое состояние' },
  };
  globalThis.__f2aWarnStub = (serverId) => {
    asked.push(serverId);
    return states[serverId] ?? null;
  };
  stub.warnings = true;
  t.cleanup(() => {
    stub.warnings = null;
    delete globalThis.__f2aWarnStub;
  });
  const sb = createSandbox({ servers: twoServers() });
  await sb.load();
  const own = await sb.call('admin', 'GET', '/servers/srv1/status');
  const other = await sb.call('admin', 'GET', '/servers/srv2/status');
  t.note(`спросили: ${JSON.stringify(asked)}; srv1 → ${JSON.stringify(own.body.data.wipeWarning.state)}; srv2 → ${JSON.stringify(other.body.data.wipeWarning.state)}`);
  assert.deepEqual(asked, ['srv1', 'srv2']);
  assert.deepEqual(own.body.data.wipeWarning.state, states.srv1);
  assert.equal(other.body.data.wipeWarning.state, null, 'состояние с чужим serverId вкладка не получает');
});

test('«Тест предупреждения» на своём сервере виден в его вкладке, а во вкладке соседа — нет', async (t) => {
  const sb = createSandbox({ servers: twoServers() });
  await sb.load();
  const sent = await sb.call('admin', 'POST', '/servers/srv1/warn-test');
  const own = await sb.call('admin', 'GET', '/servers/srv1/status');
  const other = await sb.call('admin', 'GET', '/servers/srv2/status');
  t.note(`тест → ${sent.status}; srv1: ${own.body.data.wipeWarning.state?.text}; srv2: ${JSON.stringify(other.body.data.wipeWarning.state)}`);
  assert.equal(sent.status, 200);
  assert.equal(own.body.data.wipeWarning.state?.serverId, 'srv1');
  assert.equal(other.body.data.wipeWarning.state, null);
});
