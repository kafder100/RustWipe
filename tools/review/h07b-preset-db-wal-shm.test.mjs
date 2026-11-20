/**
 * Ревью RustWipe, гипотеза 7 (раздел 4.2), утверждение H7b:
 * пресеты «Карта + блюпринты» и «Данные игроков» удаляют базу player.*.db,
 * но оставляют её спутники -wal и -shm (SQLite создаёт их в режиме WAL; после
 * падения или убийства процесса они остаются на диске).
 *
 * Правильное поведение (описания пресетов «Вайп мира и чертежей», «Удаляет
 * файлы игроков»; руководство, раздел 6 — база это .db вместе с -wal и -shm;
 * ответ владельца «строго выбранные файлы»): у каждой удалённой базы не
 * остаётся её -wal и -shm; то, что пресет не трогает, — на месте.
 *
 * Третья проверка — справка о тяжести, не о плагине: что делает SQLite с
 * оставшимся -wal, когда рядом создаётся новая пустая база. Идёт на настоящих
 * файлах во временной папке (withTempDir) и встроенном node:sqlite; если его
 * нет (Node < 22.13), справка пропускается.
 *
 * Запуск: node tools/review/h07b-preset-db-wal-shm.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createSandbox, rustServerTree, test, withTempDir } from './sandbox.mjs';

function treeWithoutLinks() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  return spec;
}

async function findPreset(sb, id, byContent) {
  const res = await sb.call('owner', 'GET', '/presets');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const presets = res.body.data;
  const preset = presets.find((item) => item.id === id) || presets.find((item) => byContent(item.targets || []));
  assert.ok(preset, `пресет ${id} не найден`);
  return preset;
}

async function wipeWithPreset(sb, preset) {
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: {
      name: preset.label,
      targets: preset.targets,
      excludes: preset.excludes || [],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
    },
  });
  assert.equal(res.status, 200, `профиль не создан: ${JSON.stringify(res.body)}`);
  const profile = await sb.ctx.collection('profiles').findOne({ id: res.body.data.id });
  return sb.wipe(profile);
}

/** Спутники -wal/-shm, оставшиеся у удалённых баз .db. */
function orphanCompanions(sb, removed) {
  const out = [];
  for (const item of removed.filter((entry) => entry.endsWith('.db'))) {
    for (const suffix of ['-wal', '-shm']) if (sb.tree.exists(`${item}${suffix}`)) out.push(`${item}${suffix}`);
  }
  return out;
}

const hasMap = (targets) => targets.some((target) => target.includes('proceduralmap'));
const hasPlayers = (targets) => targets.some((target) => target.includes('player'));

test('H7b: пресет «Карта + блюпринты» удаляет базу чертежей вместе с -wal и -shm', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const preset = await findPreset(sb, 'rust-map-bp', (targets) => hasMap(targets) && targets.some((target) => target.includes('blueprints')));
  const before = sb.tree.snapshot();
  const run = await wipeWithPreset(sb, preset);
  const removed = sb.tree.diff(before).removed;
  const orphans = orphanCompanions(sb, removed);
  t.note(`пресет: ${preset.targets.join(', ')}; прогон ok=${run.ok}`);
  t.note(`удалено баз: ${removed.filter((item) => item.endsWith('.db')).join(', ') || 'ни одной'}; остались спутники: ${orphans.join(', ') || 'нет'}`);
  assert.ok(!sb.tree.exists('/server/rust/player.blueprints.270.db'), 'пресет не удалил саму базу чертежей');
  assert.deepEqual(orphans, [], `после удаления базы остались её файлы: ${orphans.join(', ')}`);
  for (const keep of ['/server/rust/player.deaths.270.db', '/server/rust/cfg/server.cfg']) {
    assert.ok(sb.tree.exists(keep), `пресет удалил лишнее: ${keep}`);
  }
});

test('H7b: пресет «Данные игроков» удаляет базы игроков вместе с -wal и -shm', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const preset = await findPreset(sb, 'rust-players', (targets) => hasPlayers(targets) && !hasMap(targets));
  const before = sb.tree.snapshot();
  const run = await wipeWithPreset(sb, preset);
  const removed = sb.tree.diff(before).removed;
  const orphans = orphanCompanions(sb, removed);
  t.note(`пресет: ${preset.targets.join(', ')}; прогон ok=${run.ok}`);
  t.note(`удалено баз: ${removed.filter((item) => item.endsWith('.db')).join(', ') || 'ни одной'}; остались спутники: ${orphans.join(', ') || 'нет'}`);
  assert.ok(!sb.tree.exists('/server/rust/player.blueprints.270.db'), 'пресет не удалил базу чертежей');
  assert.deepEqual(orphans, [], `после удаления баз остались их файлы: ${orphans.join(', ')}`);
  for (const keep of ['/server/rust/proceduralmap.3000.12345.270.map', '/server/rust/proceduralmap.3000.12345.270.sav', '/server/rust/cfg/server.cfg']) {
    assert.ok(sb.tree.exists(keep), `пресет «Данные игроков» удалил лишнее: ${keep}`);
  }
});

test('справка о тяжести (не проверка плагина): SQLite отбрасывает старый -wal рядом с новой пустой базой', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.note('node:sqlite недоступен в этой версии Node — справка пропущена');
    return;
  }
  await withTempDir(async (dir) => {
    const name = 'player.blueprints.270.db';
    const crashed = path.join(dir, 'crashed');
    const wiped = path.join(dir, 'wiped');
    fs.mkdirSync(crashed);
    fs.mkdirSync(wiped);
    // Сервер «упал»: в -wal есть данные, которых ещё нет в самой базе.
    const db = new DatabaseSync(path.join(crashed, name));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE bp(steamid TEXT); INSERT INTO bp VALUES ('old1'), ('old2');");
    fs.copyFileSync(path.join(crashed, `${name}-wal`), path.join(wiped, `${name}-wal`));
    fs.copyFileSync(path.join(crashed, `${name}-shm`), path.join(wiped, `${name}-shm`));
    db.close();
    // Вайп удалил только .db; сервер открывает новую пустую базу рядом со старыми -wal и -shm.
    const fresh = new DatabaseSync(path.join(wiped, name));
    const tables = fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    const walLeft = fs.existsSync(path.join(wiped, `${name}-wal`));
    fresh.close();
    t.note(`таблицы в новой базе: ${JSON.stringify(tables)}; старый -wal после открытия: ${walLeft ? 'остался' : 'удалён SQLite'}`);
    assert.deepEqual(tables, [], 'старые данные из -wal попали в новую базу');
  });
});
