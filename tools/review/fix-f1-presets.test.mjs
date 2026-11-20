/**
 * F1, находки H7a и H7b: пресеты оставляли части старого мира.
 *   H7a — «Карта» и «Карта + блюпринты» не удаляли запасные копии
 *         сохранения proceduralmap.….sav.1, .sav.2 (их создаёт сам Rust,
 *         число задаёт server.savebackupcount): при смене сида копии больше
 *         не перезаписываются и копятся на диске;
 *   H7b — «Карта + блюпринты» и «Данные игроков» удаляли базу .db, но
 *         оставляли её -wal и -shm.
 *
 * Правильное поведение (описание пресетов: «Удаляет сохранение мира»;
 * ответ владельца №3 «строго выбранные файлы»): копии с номерами удаляются
 * вместе с сохранением, база — вместе с -wal и -shm. Лишнего не трогаем:
 * ручная копия «.sav.bak», блюпринты (для «Карты»), смерти, cfg остаются.
 *
 * Готовые тесты нашедших — h07a-preset-sav-backups и h07b-preset-db-wal-shm.
 * Здесь — что пресет «Карта» не берёт лишнего: ручную копию и чужие файлы.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-presets.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const WORLD = '/server/rust/proceduralmap.3000.12345.270';

function tree() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  spec.files[`${WORLD}.sav.10`] = 2097152;
  spec.files[`${WORLD}.sav.bak`] = 'ручная копия админа';
  return spec;
}

async function wipeWithPreset(t, id) {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const presets = (await sb.call('owner', 'GET', '/presets')).body.data;
  const preset = presets.find((item) => item.id === id);
  assert.ok(preset, `нет пресета ${id}`);
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: preset.label, targets: preset.targets, excludes: preset.excludes, schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  assert.equal(res.status, 200, `пресет не сохраняется как профиль: ${JSON.stringify(res.body)}`);
  const before = sb.tree.snapshot();
  const run = await sb.wipe(await sb.ctx.collection('profiles').findOne({ id: res.body.data.id }));
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`пресет ${id}: ${preset.targets.join(', ')}`);
  t.note(`удалено: ${removed.join(', ')}; ok=${run.ok}`);
  return { sb, removed };
}

test('H7a: «Карта» удаляет копии .sav.1, .sav.2, .sav.10, но не ручную .sav.bak и не данные игроков', async (t) => {
  const { sb, removed } = await wipeWithPreset(t, 'rust-map');
  for (const suffix of ['map', 'sav', 'sav.1', 'sav.2', 'sav.10']) {
    assert.equal(sb.tree.exists(`${WORLD}.${suffix}`), false, `осталась часть старого мира: .${suffix}`);
  }
  assert.ok(sb.tree.exists(`${WORLD}.sav.bak`), 'пресет удалил ручную копию .sav.bak');
  assert.deepEqual(
    removed.filter((path) => !path.startsWith(`${WORLD}.`)),
    [],
    'пресет «Карта» удалил что-то кроме сохранения мира',
  );
});

test('H7b: «Данные игроков» удаляют базы вместе с -wal и -shm и не трогают карту', async (t) => {
  const { sb } = await wipeWithPreset(t, 'rust-players');
  for (const path of ['/server/rust/player.blueprints.270.db', '/server/rust/player.blueprints.270.db-wal', '/server/rust/player.blueprints.270.db-shm']) {
    assert.equal(sb.tree.exists(path), false, `остался ${path}`);
  }
  assert.ok(sb.tree.exists(`${WORLD}.map`));
  assert.ok(sb.tree.exists('/server/rust/cfg/server.cfg'));
});
