/**
 * F1, находка L32-6: map.vars принимал любую переменную шаблона. Профиль с
 * vars.seed = "RCON_PASS" и фиксированным сидом 1, vars.size = "SERVER_PORT"
 * сохранялся, и вайп ключом панели писал RCON_PASS=1 и SERVER_PORT=3000.
 * Новый пароль RCON попадал в шаг истории. Одинаковые vars.seed и vars.size
 * тоже принимались.
 *
 * Правильное поведение (ответ владельца №18: «только сид и размер»): имя
 * переменной сида должно содержать SEED, размера — SIZE (так их ищет и кнопка
 * «Определить из шаблона»), имена разные; иначе — 400. Профиль, сохранённый
 * раньше с чужой переменной, после обновления пишет только имена по умолчанию
 * (WORLD_SEED и WORLD_SIZE) — пароль и порт вайп не трогает.
 *
 * Всё на подменах песочницы: панель и переменные шаблона поддельные.
 *
 * Запуск: node tools/review/fix-f1-map-vars.test.mjs
 */

import assert from 'node:assert/strict';

import { normalizeMapSettings, validateMapInput } from '../../rust-autowipe/backend/lib/mapgen.js';
import { createSandbox, test } from './sandbox.mjs';

const SCHEDULE = { kind: 'weekly', weekday: 4, time: '05:00' };

function mapWith(vars) {
  return { seed: { mode: 'fixed', value: 1 }, size: { mode: 'fixed', value: 3000 }, vars };
}

test('validateMapInput: только SEED для сида и SIZE для размера, и не одна переменная на двоих', () => {
  assert.ok(validateMapInput(mapWith({ seed: 'RCON_PASS', size: 'WORLD_SIZE' })).some((error) => /SEED/.test(error)));
  assert.ok(validateMapInput(mapWith({ seed: 'WORLD_SEED', size: 'SERVER_PORT' })).some((error) => /SIZE/.test(error)));
  assert.ok(validateMapInput(mapWith({ seed: 'SEED_SIZE', size: 'SEED_SIZE' })).some((error) => /одну переменную/.test(error)));
  assert.deepEqual(validateMapInput(mapWith({ seed: 'SERVER_SEED', size: 'MAP_SIZE' })), []);
  assert.deepEqual(validateMapInput(mapWith({ seed: 'world_seed', size: 'worldsize' })), [], 'регистр не важен');
  assert.deepEqual(validateMapInput(mapWith({})), [], 'без vars — имена по умолчанию');
});

test('normalizeMapSettings: чужая переменная в старом профиле заменяется именем по умолчанию', () => {
  assert.deepEqual(normalizeMapSettings(mapWith({ seed: 'RCON_PASS', size: 'SERVER_PORT' })).vars, {
    seed: 'WORLD_SEED',
    size: 'WORLD_SIZE',
  });
  assert.deepEqual(normalizeMapSettings(mapWith({ seed: 'SEED_SIZE', size: 'SEED_SIZE' })).vars, {
    seed: 'WORLD_SEED',
    size: 'WORLD_SIZE',
  });
  assert.deepEqual(normalizeMapSettings(mapWith({ seed: 'SERVER_SEED', size: 'MAP_SIZE' })).vars, {
    seed: 'SERVER_SEED',
    size: 'MAP_SIZE',
  });
});

test('L32-6: профиль с vars RCON_PASS и SERVER_PORT не сохраняется', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Чужие переменные', targets: ['/server/*/proceduralmap.*.map'], schedule: SCHEDULE, map: mapWith({ seed: 'RCON_PASS', size: 'SERVER_PORT' }) },
  });
  t.note(`${res.status}: ${res.body?.error}`);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(sb.profiles().length, 0);
  const same = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Одна переменная', targets: ['/server/*/proceduralmap.*.map'], schedule: SCHEDULE, map: mapWith({ seed: 'WORLD_SEED', size: 'WORLD_SEED' }) },
  });
  assert.equal(same.status, 400, JSON.stringify(same.body));
});

test('L32-6: старый профиль с vars RCON_PASS — вайп не трогает пароль RCON и порт', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const before = { ...sb.panel.server('srv1').environment };
  const profile = await sb.addProfile({ map: mapWith({ seed: 'RCON_PASS', size: 'SERVER_PORT' }) });
  const run = await sb.wipe(profile);
  await sb.idle();
  const env = sb.panel.server('srv1').environment;
  const patches = sb.panel.calls.filter((call) => call.method === 'PATCH');
  const mapStep = run.steps.find((step) => step.action === 'map');
  t.note(`PATCH: ${patches.map((call) => JSON.stringify(call.body)).join(' | ')}; шаг map: ${mapStep?.detail}`);
  assert.equal(env.RCON_PASS, before.RCON_PASS, 'вайп переписал пароль RCON');
  assert.equal('SERVER_PORT' in env, 'SERVER_PORT' in before, 'вайп записал порт');
  assert.equal(String(env.WORLD_SEED), '1');
  assert.doesNotMatch(String(mapStep?.detail), /RCON_PASS|SERVER_PORT/);
});
