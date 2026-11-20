/**
 * Ревью RustWipe, гипотеза 3 (раздел 4.2), утверждение H3d — «что ещё может
 * снести установку»: ссылка внутри выбранной папки, которая ведёт на корень
 * сервера или на каталог игры. Плагин ссылку не отличает от файла или
 * каталога и отдаёт агенту «удалить /oxide/data/<ссылка>», а агент Catalyst
 * удаляет цель ссылки (catalyst-agent/src/file_manager.rs, delete_file и
 * resolve_beneath, тег v1.89.2). Своя защита плагина «не удалять корень»
 * (glob-walk.js, deletePath) смотрит только на строку пути.
 *
 * Правильное поведение (ответ владельца «строго выбранные файлы»): пресет
 * «Данные Oxide» удаляет только то, что лежит в /oxide/data; установка игры,
 * настройки и всё вне /oxide/data остаются.
 *
 * Пересекается с гипотезой 6 (ссылки): там — выход за папку сервера, здесь —
 * ссылка, которая остаётся внутри сервера, но уводит удаление на установку.
 *
 * Запуск: node tools/review/h03d-link-wipes-install.test.mjs
 * Всё на подменах песочницы; поведение агента со ссылками — по исходникам.
 */

import assert from 'node:assert/strict';

import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const INSTALL = [
  '/RustDedicated',
  '/RustDedicated_Data/Managed/Assembly-CSharp.dll',
  '/RustDedicated_Data/globalgamemanagers',
  '/start.sh',
  '/runds.sh',
  '/steamapps/appmanifest_258550.acf',
  '/server/rust/cfg/server.cfg',
];

function treeWithoutLinks() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  return spec;
}

async function oxidePreset(sb) {
  const res = await sb.call('owner', 'GET', '/presets');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const presets = res.body.data;
  const preset =
    presets.find((item) => item.id === 'oxide-data') ||
    presets.find((item) => (item.targets || []).some((target) => target.startsWith('/oxide/data')));
  assert.ok(preset, 'пресет «Данные Oxide» не найден');
  return preset;
}

async function wipeWithLink(t, name, link) {
  const spec = treeWithoutLinks();
  spec.files[`/oxide/data/${name}`] = { link };
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const preset = await oxidePreset(sb);
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Данные Oxide',
      targets: preset.targets,
      excludes: preset.excludes || [],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
    },
  });
  assert.equal(res.status, 200, `профиль не создан: ${JSON.stringify(res.body)}`);
  const profile = await sb.ctx.collection('profiles').findOne({ id: res.body.data.id });
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  const removed = sb.tree.diff(before).removed;
  const outside = removed.filter((item) => !item.startsWith('/oxide/data/'));
  t.note(`пресет: ${preset.targets.join(', ')}; ссылка /oxide/data/${name} -> ${link}`);
  t.note(`удалено вне /oxide/data: ${outside.length} записей; прогон ok=${run.ok}`);
  return { sb, outside };
}

test('H3d: ссылка на корень сервера (-> /data) в /oxide/data — пресет «Данные Oxide» не сносит установку', async (t) => {
  const { sb, outside } = await wipeWithLink(t, 'root', '/data');
  const lost = INSTALL.filter((item) => !sb.tree.exists(item));
  assert.deepEqual(lost, [], `вместе с данными Oxide снесена установка: ${lost.join(', ')}`);
  assert.deepEqual(outside, [], 'удалено что-то вне /oxide/data');
});

test('H3d: ссылка на каталог игры (-> ../../RustDedicated_Data) — пресет «Данные Oxide» его не трогает', async (t) => {
  const { sb, outside } = await wipeWithLink(t, 'game', '../../RustDedicated_Data');
  const lost = INSTALL.filter((item) => !sb.tree.exists(item));
  assert.deepEqual(lost, [], `вместе с данными Oxide снесена установка: ${lost.join(', ')}`);
  assert.deepEqual(outside, [], 'удалено что-то вне /oxide/data');
});
