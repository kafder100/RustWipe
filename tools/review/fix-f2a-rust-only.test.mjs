/**
 * Исправление F2a: плагин работает только с серверами Rust (ответ владельца №16).
 *
 * Правило то же, что у вкладки (templateFilter.namePattern 'rust' во frontend):
 * имя шаблона сервера совпадает с /rust/i. Имя шаблона плагин узнаёт у API
 * панели ключом из настроек (GET /api/servers/:id, поле template.name): в
 * ctx.db.servers есть только templateId, таблицы шаблонов у плагина нет.
 * Если спросить не удалось (нет ключа, панель отвечает не JSON) — плагин не
 * мешает, вкладка и так видна только у Rust.
 *
 * Дополняет тесты нашедших h08e (роуты) и h08f (плановый вайп).
 *
 * Запуск: node tools/review/fix-f2a-rust-only.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { RUST_TEMPLATE, createSandbox, defaultServer, test } from './sandbox.mjs';

const MINECRAFT = Object.freeze({
  id: 'tpl_mc',
  name: 'Minecraft: Java Edition',
  variables: [{ name: 'SERVER_JARFILE', default: 'server.jar', required: true, input: 'text', rules: ['required', 'string'] }],
});

function sandboxWith(template, options = {}) {
  return createSandbox({
    servers: [defaultServer({ template, templateId: template.id, environment: { SERVER_JARFILE: 'server.jar', WORLD_SEED: '1', WORLD_SIZE: '3000' } })],
    ...options,
  });
}

const power = (sb) =>
  sb.panel.calls.filter((call) => call.method === 'POST' && /\/(stop|start)$/.test(call.path)).map((call) => call.path.split('/').pop());

test('шаблоны с «Rust» в имени в любом регистре — роуты работают', async (t) => {
  const names = [];
  for (const name of ['Rust', 'Rust Dedicated Server', 'rust (Oxide/uMod)', 'Карбон RUST']) {
    const sb = sandboxWith({ ...RUST_TEMPLATE, name });
    await sb.load();
    const status = await sb.call('owner', 'GET', '/servers/srv1/status');
    names.push(`${name} → ${status.status}`);
    assert.equal(status.status, 200, `${name}: ${JSON.stringify(status.body)}`);
    sb.restore();
  }
  t.note(names.join('; '));
});

test('сервер не Rust: отказ с понятной причиной, и для владельца, и для админа', async (t) => {
  const sb = sandboxWith(MINECRAFT);
  await sb.load();
  const owner = await sb.call('owner', 'GET', '/servers/srv1/status');
  const admin = await sb.call('admin', 'GET', '/servers/srv1/profiles');
  t.note(`владелец → ${owner.status} «${owner.body?.error}»; админ → ${admin.status}`);
  assert.equal(owner.status, 403);
  assert.match(owner.body.error, /не Rust/);
  assert.match(owner.body.error, /Minecraft/);
  assert.equal(admin.status, 403);
});

test('шаблон узнать нельзя (нет API-ключа или панель отвечает не JSON) — плагин не мешает', async (t) => {
  const noKey = sandboxWith(MINECRAFT, { config: { apiKey: '' } });
  await noKey.load();
  const withoutKey = await noKey.call('owner', 'GET', '/servers/srv1/status');
  noKey.restore();

  const html = sandboxWith(MINECRAFT);
  html.panel.fail({ method: 'GET', path: '/api/servers/srv1', status: 200, body: '<!doctype html><title>Вход</title>' });
  await html.load();
  const withHtml = await html.call('owner', 'GET', '/servers/srv1/status');
  t.note(`без ключа → ${withoutKey.status}; панель отдала HTML → ${withHtml.status}`);
  assert.equal(withoutKey.status, 200);
  assert.equal(withHtml.status, 200);
});

test('плановый вайп на сервере не Rust: сервер не трогается, срок перенесён, причина видна в профиле', async (t) => {
  const sb = sandboxWith(MINECRAFT, { now: '2026-11-19T05:00:00.050Z' });
  await sb.load();
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', targets: ['/server.jar'], options: { warnChat: false } });
  await sb.tick();
  await sb.idle();
  const profile = sb.profiles()[0];
  t.note(`питание [${power(sb).join(', ')}], удалений ${sb.tunnel.paths('delete').length}; nextRunAt ${profile.nextRunAt}; причина: ${profile.lastSkipReason}`);
  assert.deepEqual(power(sb), []);
  assert.equal(sb.tunnel.paths('delete').length, 0);
  assert.ok(Date.parse(profile.nextRunAt) > sb.clock.now(), 'срок перенесён на следующий раз');
  assert.match(profile.lastSkipReason, /не Rust/);
});

test('контроль: плановый вайп на сервере Rust идёт', async () => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z' });
  await sb.load();
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.tick();
  await sb.idle();
  assert.deepEqual(power(sb), ['stop', 'start']);
  assert.equal(sb.runs().length, 1);
  assert.equal(sb.runs()[0].ok, true, JSON.stringify(sb.runs()[0].errors));
});
