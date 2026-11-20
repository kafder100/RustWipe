/**
 * Исправление F2a (находка L32-2): проверочный прогон (dry-run) включается
 * только явным dryRun: true, а флаги профиля — только true или false.
 *
 * Было: POST …/run с { dryRun: "true" }, { dryRun: 1 }, { dry_run: true } или
 * ?dryRun=true запускал боевой вайп (остановка сервера, удаление файлов).
 * PUT профиля с options.dryRun "1", 1 или "yes" молча делал проверочный профиль
 * боевым, enabled "no" профиль не выключал.
 * Должно (ответ владельца №3 «строго выбранные файлы», договорённость К5):
 * любое непонятное значение — 400 и никаких действий.
 *
 * Запуск: node tools/review/fix-f2a-dryrun-flag.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const powerAndDeletes = (sb, since) => {
  const after = sb.journal.entries.filter((entry) => entry.seq > since);
  return {
    power: after.filter((entry) => entry.kind === 'fetch' && entry.method === 'POST' && /\/(stop|start)$/.test(entry.path)).length,
    deletes: after.filter((entry) => entry.kind === 'tunnel' && entry.op === 'delete').length,
  };
};

test('запуск: непонятное значение dryRun — 400, сервер и файлы не трогаются', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const path = `/servers/srv1/profiles/${profile.id}/run`;
  const bad = [
    ['{ dryRun: "true" }', { body: { dryRun: 'true' } }],
    ['{ dryRun: 1 }', { body: { dryRun: 1 } }],
    ['{ dryRun: null }', { body: { dryRun: null } }],
    ['{ dry_run: true }', { body: { dry_run: true } }],
    ['?dryRun=true', { body: {}, query: { dryRun: 'true' } }],
    ['тело-массив', { body: [true] }],
  ];
  const rows = [];
  for (const [name, options] of bad) {
    const since = sb.journal.entries.at(-1).seq;
    const res = await sb.call('admin', 'POST', path, options);
    await sb.idle();
    rows.push(`${name} → ${res.status}`);
    assert.equal(res.status, 400, `${name}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.deepEqual(powerAndDeletes(sb, since), { power: 0, deletes: 0 }, `${name}: сервер или файлы тронуты`);
  }
  t.note(rows.join('; '));
  assert.equal(sb.runs().length, 0);
});

test('запуск: dryRun: true — проверка без остановки; {} и dryRun: false — боевой вайп', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ options: { warnChat: false } });
  const path = `/servers/srv1/profiles/${profile.id}/run`;

  let since = sb.journal.entries.at(-1).seq;
  const dry = await sb.call('admin', 'POST', path, { body: { dryRun: true } });
  await sb.idle();
  const dryEffects = powerAndDeletes(sb, since);

  since = sb.journal.entries.at(-1).seq;
  const real = await sb.call('admin', 'POST', path, { body: { dryRun: false } });
  await sb.idle();
  const realEffects = powerAndDeletes(sb, since);

  since = sb.journal.entries.at(-1).seq;
  const empty = await sb.call('admin', 'POST', path, { body: {} });
  await sb.idle();
  t.note(`dryRun:true → ${dry.status} ${JSON.stringify(dryEffects)}; dryRun:false → ${real.status} ${JSON.stringify(realEffects)}; {} → ${empty.status}`);

  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual(dryEffects, { power: 0, deletes: 0 });
  assert.equal(real.status, 200);
  assert.equal(real.body.dryRun, false);
  assert.ok(realEffects.power >= 1 && realEffects.deletes >= 1, 'боевой вайп должен остановить сервер и удалить файлы');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.dryRun, false);
});

test('профиль: options.dryRun и enabled — только true или false; иначе 400 и профиль не меняется', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ options: { dryRun: true, warnChat: false } });
  const put = (body) => sb.call('admin', 'PUT', `/servers/srv1/profiles/${profile.id}`, { body });
  const rows = [];
  for (const body of [
    { options: { dryRun: '1' } },
    { options: { dryRun: 1 } },
    { options: { dryRun: 'yes' } },
    { options: { stopServer: 'on' } },
    { enabled: 0 },
    { enabled: 'no' },
  ]) {
    const res = await put(body);
    rows.push(`${JSON.stringify(body)} → ${res.status}`);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const created = await sb.call('admin', 'POST', '/servers/srv1/profiles', {
    body: { name: 'x', targets: ['/server/rust/cfg/*'], options: { dryRun: 'yes' } },
  });
  rows.push(`создание с dryRun "yes" → ${created.status}`);
  const okPut = await put({ options: { ...profile.options, dryRun: 'true' } });
  rows.push(`dryRun "true" → ${okPut.status}`);
  t.note(rows.join('; '));

  assert.equal(created.status, 400);
  assert.equal(okPut.status, 200);
  const stored = sb.profiles().find((item) => item.id === profile.id);
  assert.equal(stored.options.dryRun, true, 'проверочный профиль остался проверочным');
  assert.equal(stored.enabled, true);
  assert.equal(sb.profiles().length, 1);
});
