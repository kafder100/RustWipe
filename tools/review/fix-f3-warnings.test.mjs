/**
 * Исправление F3: предупреждения в чате (находки H15a, H15b, H15c,
 * договорённость К7, часть warnings.js).
 *
 *   - Перед проверочным прогоном (dry-run профиля или глобальный dryRun)
 *     отсчёт в чат не уходит: вайпа не будет (ответ владельца №15).
 *   - Последняя попытка отправки хранится по серверам: getWarningState(serverId)
 *     отдаёт только состояние этого сервера. В хранилище — свой ключ;
 *     прежнее общее состояние читается один раз — для его сервера.
 *
 * Запуск: node tools/review/fix-f3-warnings.test.mjs
 * Панель (консоль сервера) и часы — подмены песочницы, в сеть ничего не уходит.
 */

import assert from 'node:assert/strict';

import { createSandbox, defaultServer, test } from './sandbox.mjs';

const NEW_KEY = 'wipeWarningStateByServer';
const OLD_KEY = 'wipeWarningState';

const say = (sb) => sb.panel.calls.filter((call) => call.path.endsWith('/console/command')).map((call) => call.body?.command);

/** Профиль, вайп которого — через 3 минуты: самое время для предупреждения. */
function dueProfile(id, serverId, options = {}) {
  return {
    id,
    serverId,
    enabled: true,
    nextRunAt: new Date(Date.now() + 3 * 60000).toISOString(),
    options: { warnChat: true, dryRun: false, ...options },
  };
}

async function sandbox(options = {}) {
  const sb = createSandbox({
    servers: [defaultServer(), defaultServer({ id: 'srv2', name: 'Rust #2', ownerId: 'user_other' })],
    ...options,
  });
  await sb.load();
  const warnings = await sb.lib('warnings');
  return { sb, warnings };
}

test('контроль: перед боевым вайпом предупреждение уходит', async () => {
  const { sb, warnings } = await sandbox();
  const sent = await sb.run(warnings.sendWipeWarnings(sb.ctx, [dueProfile('p1', 'srv1')], new Date()));
  assert.equal(sent, 1);
  assert.deepEqual(say(sb), ['say Вайп сервера через 3 мин']);
});

test('dry-run профиля: отсчёт в чат не уходит, боевой профиль рядом — уходит', async () => {
  const { sb, warnings } = await sandbox();
  const profiles = [dueProfile('dry', 'srv1', { dryRun: true }), dueProfile('real', 'srv2')];
  const sent = await sb.run(warnings.sendWipeWarnings(sb.ctx, profiles, new Date()));
  assert.equal(sent, 1, 'ушло только предупреждение боевого профиля');
  const calls = sb.panel.calls.filter((call) => call.path.endsWith('/console/command'));
  assert.deepEqual(calls.map((call) => call.path), ['/api/servers/srv2/console/command']);
  assert.equal(warnings.getWarningState('srv1'), null, 'у dry-run профиля нет и записи об отправке');
});

test('глобальный dryRun: отсчёт в чат не уходит ни одному профилю', async () => {
  const { sb, warnings } = await sandbox({ config: { dryRun: true } });
  const sent = await sb.run(warnings.sendWipeWarnings(sb.ctx, [dueProfile('p1', 'srv1'), dueProfile('p2', 'srv2')], new Date()));
  assert.equal(sent, 0);
  assert.deepEqual(say(sb), []);
});

test('состояние отправки — по серверам: вкладка сервера видит только своё', async () => {
  const { sb, warnings } = await sandbox();
  // srv1 — успешно, srv2 — ошибка 403 консоли.
  sb.panel.fail({ method: 'POST', path: '/api/servers/srv2/console/command', status: 403, body: { error: 'Forbidden: console.write' } });
  await sb.run(warnings.sendWipeWarnings(sb.ctx, [dueProfile('p1', 'srv1'), dueProfile('p2', 'srv2')], new Date()));
  const one = warnings.getWarningState('srv1');
  const two = warnings.getWarningState('srv2');
  assert.equal(one?.ok, true, JSON.stringify(one));
  assert.equal(one.serverId, 'srv1');
  assert.equal(two?.ok, false, JSON.stringify(two));
  assert.equal(two.serverId, 'srv2');
  assert.equal(warnings.getWarningState('srv3'), null);
  assert.equal(warnings.getWarningState(), null, 'без сервера — ничего чужого');

  // «Тест предупреждения» пишет состояние своего сервера и не трогает чужое.
  await sb.run(warnings.recordWarningState(sb.ctx, { at: new Date().toISOString(), ok: true, text: '[тест] x', serverId: 'srv2', test: true }));
  assert.equal(warnings.getWarningState('srv2').test, true);
  assert.equal(warnings.getWarningState('srv1').ok, true);
});

test('хранилище: состояние по серверам переживает перезапуск плагина', async () => {
  const { sb, warnings } = await sandbox();
  await sb.run(warnings.recordWarningState(sb.ctx, { at: '2026-11-19T00:00:00.000Z', ok: true, text: 'A', serverId: 'srv1' }));
  await sb.run(warnings.recordWarningState(sb.ctx, { at: '2026-11-19T00:01:00.000Z', ok: false, error: 'B', serverId: 'srv2' }));
  const stored = await sb.ctx.getStorage(NEW_KEY);
  assert.deepEqual(Object.keys(stored).sort(), ['srv1', 'srv2']);

  // Перезапуск: новый экземпляр модуля читает хранилище при включении.
  await sb.load();
  const fresh = await sb.lib('warnings');
  assert.notEqual(fresh, warnings);
  assert.equal(fresh.getWarningState('srv1'), null, 'до загрузки в памяти пусто');
  await sb.run(fresh.loadWarningState(sb.ctx));
  assert.equal(fresh.getWarningState('srv1').text, 'A');
  assert.equal(fresh.getWarningState('srv2').error, 'B');
});

test('хранилище: прежнее общее состояние достаётся только его серверу', async () => {
  const old = { at: '2026-11-18T10:00:00.000Z', ok: false, error: '403', profileId: 'p1', serverId: 'srv1', minutes: 3 };
  const { sb, warnings } = await sandbox({ storage: { [OLD_KEY]: old } });
  await sb.run(warnings.loadWarningState(sb.ctx));
  assert.deepEqual(warnings.getWarningState('srv1'), old);
  assert.equal(warnings.getWarningState('srv2'), null);
  // Прежний ключ не трогаем: при откате на старую версию он читается как раньше.
  await sb.run(warnings.recordWarningState(sb.ctx, { at: '2026-11-19T00:00:00.000Z', ok: true, text: 'new', serverId: 'srv2' }));
  assert.deepEqual(await sb.ctx.getStorage(OLD_KEY), old);
  assert.deepEqual(Object.keys(await sb.ctx.getStorage(NEW_KEY)).sort(), ['srv1', 'srv2']);
});

test('хранилище: запись без загрузки не стирает состояние других серверов', async () => {
  // Планировщик выключен — onEnable не вызывает loadWarningState, а «Тест предупреждения» работает.
  const stored = { srv1: { at: '2026-11-18T10:00:00.000Z', ok: true, text: 'A', serverId: 'srv1' } };
  const { sb, warnings } = await sandbox({ storage: { [NEW_KEY]: stored } });
  // Две записи сразу (тест предупреждения и тик): обе ждут одного чтения хранилища.
  await sb.run(
    Promise.all([
      warnings.recordWarningState(sb.ctx, { at: '2026-11-19T00:00:00.000Z', ok: true, text: 'B', serverId: 'srv2' }),
      warnings.recordWarningState(sb.ctx, { at: '2026-11-19T00:00:00.000Z', ok: true, text: 'C', serverId: 'srv3' }),
    ]),
  );
  const after = await sb.ctx.getStorage(NEW_KEY);
  assert.equal(after.srv1?.text, 'A', JSON.stringify(after));
  assert.equal(after.srv2?.text, 'B');
  assert.equal(after.srv3?.text, 'C');
  assert.equal(warnings.getWarningState('srv1')?.text, 'A', 'и в памяти тоже');
});

test('хранилище: записей не больше 500 — самые старые уходят', async () => {
  const { sb, warnings } = await sandbox();
  for (let index = 0; index < 505; index += 1) {
    await sb.run(warnings.recordWarningState(sb.ctx, { at: new Date().toISOString(), ok: true, text: String(index), serverId: `s${index}` }));
  }
  const stored = await sb.ctx.getStorage(NEW_KEY);
  assert.equal(Object.keys(stored).length, 500);
  assert.equal(warnings.getWarningState('s0'), null);
  assert.equal(warnings.getWarningState('s504').text, '504');
});

test('совместимость: состояние без сервера и отдельные экземпляры модуля', async () => {
  // Так проверяет изоляцию модулей самопроверка песочницы (sandbox.selftest.mjs).
  const { sb, warnings } = await sandbox();
  await sb.run(warnings.recordWarningState(sb.ctx, { ok: true, text: 'A' }));
  assert.equal(warnings.getWarningState().text, 'A');
  await sb.load();
  const other = await sb.lib('warnings');
  assert.equal(other.getWarningState(), null);
});
