/**
 * Ревью RustWipe, гипотеза 7 (раздел 4.2), утверждение H7a:
 * пресеты «Карта» и «Карта + блюпринты» удаляют .map и .sav, но оставляют
 * запасные копии сохранения мира — proceduralmap.<...>.sav.1, .sav.2 (Rust
 * создаёт их при каждом сохранении, их число задаёт server.saveBackupCount).
 *
 * Правильное поведение (описание пресета «Удаляет сохранение мира»; ответ
 * владельца «строго выбранные файлы»): после пресета от старого мира в
 * server/<identity> не остаётся ни карты, ни сохранения, ни его копий;
 * блюпринты и данные игроков (для «Карты»), настройки cfg — на месте.
 *
 * Запуск: node tools/review/h07a-preset-sav-backups.test.mjs
 * Всё на подменах песочницы; дерево — rustServerTree (настоящие имена файлов
 * Rust). Ссылки и junction убраны: пресеты карты их не касаются.
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const WORLD = /^\/server\/rust\/proceduralmap\./;

function treeWithoutLinks() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  return spec;
}

/** Пресет по id, а если id поменяли — по содержимому целей. */
async function findPreset(sb, id, byContent) {
  const res = await sb.call('owner', 'GET', '/presets');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const presets = res.body.data;
  const preset = presets.find((item) => item.id === id) || presets.find((item) => byContent(item.targets || []));
  assert.ok(preset, `пресет ${id} не найден`);
  return preset;
}

/** Создать профиль из пресета так, как это делает кнопка пресета во вкладке, и выполнить боевой вайп. */
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

const hasMap = (targets) => targets.some((target) => target.includes('proceduralmap'));
const hasPlayers = (targets) => targets.some((target) => target.includes('player'));

test('H7a: пресет «Карта» не оставляет копий сохранения старого мира (.sav.N)', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const preset = await findPreset(sb, 'rust-map', (targets) => hasMap(targets) && !hasPlayers(targets));
  const run = await wipeWithPreset(sb, preset);
  const left = sb.tree.snapshot().filter((item) => WORLD.test(item));
  t.note(`пресет: ${preset.targets.join(', ')}; прогон ok=${run.ok}, удалено ${run.deletedCount}`);
  t.note(`от старого мира осталось: ${left.join(', ') || 'ничего'}`);
  assert.deepEqual(left, [], `после пресета «Карта» остались части старого мира: ${left.join(', ')}`);
  for (const keep of ['/server/rust/player.blueprints.270.db', '/server/rust/player.deaths.270.db', '/server/rust/cfg/server.cfg']) {
    assert.ok(sb.tree.exists(keep), `пресет «Карта» удалил лишнее: ${keep}`);
  }
});

test('H7a: пресет «Карта + блюпринты» не оставляет копий сохранения старого мира (.sav.N)', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const preset = await findPreset(sb, 'rust-map-bp', (targets) => hasMap(targets) && targets.some((target) => target.includes('blueprints')));
  const run = await wipeWithPreset(sb, preset);
  const left = sb.tree.snapshot().filter((item) => WORLD.test(item));
  t.note(`пресет: ${preset.targets.join(', ')}; прогон ok=${run.ok}, удалено ${run.deletedCount}`);
  t.note(`от старого мира осталось: ${left.join(', ') || 'ничего'}`);
  assert.deepEqual(left, [], `после пресета «Карта + блюпринты» остались части старого мира: ${left.join(', ')}`);
  for (const keep of ['/server/rust/player.deaths.270.db', '/server/rust/player.identities.270.db', '/server/rust/cfg/server.cfg']) {
    assert.ok(sb.tree.exists(keep), `пресет «Карта + блюпринты» удалил лишнее: ${keep}`);
  }
});
