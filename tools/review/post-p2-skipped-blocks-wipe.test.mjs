/**
 * После второго круга, R-3 (регрессии R1-1 и R1-2, частично L32-4): запись,
 * которую нельзя удалить точно (права 777 — возможно, ссылка; имя с «\» или
 * с пробелом в конце), только пропускалась с предупреждением.
 *   - Права 777 у всего (chmod -R 777): удалено 0, но сид уже сменён, а в
 *     истории «Ни один путь не найден» — настоящей причины не видно.
 *   - Права 777 у части (папка Kits, файл .sav): прогон «успешно», а
 *     выбранное осталось — сервер мог загрузить старую карту.
 *
 * Правильное поведение (ответ владельца №3 «строго выбранные файлы»): если
 * хоть что-то из найденного нельзя удалить точно, вайп не начинается — до
 * смены сида и до удаления. Прогон — ошибка с понятной причиной: какие пути
 * (не больше 10) и что сделать. Сервер, который остановил плагин, поднимается.
 *
 * Запуск: node tools/review/post-p2-skipped-blocks-wipe.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): дерево в памяти, по-настоящему
 * ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const SAV = '/server/rust/proceduralmap.3000.12345.270.sav';
const RANDOM_SEED = { seed: { mode: 'random' }, size: { mode: 'keep' } };
/** Цели пресета «Карта + блюпринты» (presets.js). */
const MAP_BP = [
  '/server/*/proceduralmap.*.map',
  '/server/*/proceduralmap.*.sav',
  '/server/*/proceduralmap.*.sav.?',
  '/server/*/proceduralmap.*.sav.??',
  '/server/*/player.blueprints.*.db',
  '/server/*/player.blueprints.*.db-wal',
  '/server/*/player.blueprints.*.db-shm',
];

/** Дерево сервера без ссылок и junction: здесь важны только права. */
function cleanSpec() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && (value.link !== undefined || value.junction !== undefined)) delete spec.files[key];
  }
  return spec;
}

/** Права fileMode у файлов и dirMode у каталогов (only — только у этих путей). */
function withModes(spec, { fileMode, dirMode, only }) {
  const dirs = new Set();
  for (const path of Object.keys(spec.files)) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) dirs.add(`/${parts.slice(0, i).join('/')}`);
  }
  const out = { ...spec, files: {} };
  // Каталоги — первыми: права уже созданного каталога песочница не меняет.
  if (dirMode !== undefined) {
    for (const dir of [...dirs].sort()) if (!only || only(dir)) out.files[dir] = { dir: true, mode: dirMode };
  }
  for (const [path, value] of Object.entries(spec.files)) {
    let file = typeof value === 'string' ? { content: value } : typeof value === 'number' ? { size: value } : value;
    if (fileMode !== undefined && (!only || only(path))) file = { ...file, mode: fileMode };
    out.files[path] = file;
  }
  return out;
}

async function wipe(t, spec, profileFields, wipeOptions = {}) {
  const sb = createSandbox({ tree: spec });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ ...profileFields, options: { warnChat: false, ...(profileFields.options || {}) } });
  const run = await sb.wipe(profile, wipeOptions);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  const power = sb.panel.calls
    .filter((call) => call.method === 'POST' && /\/api\/servers\/srv1\/(stop|start)$/.test(call.path))
    .map((call) => call.path.split('/').pop());
  const patched = sb.panel.calls.some((call) => call.method === 'PATCH');
  const stored = sb.profiles().find((item) => item.id === profile.id);
  t.note(`ok=${run.ok}; удалено записей: ${removed.length}; WORLD_SEED=${sb.panel.server('srv1').environment.WORLD_SEED}; питание: ${power.join(', ') || 'нет'}; сервер: ${sb.status()}`);
  t.note(`ошибка: ${run.errors[0] || '—'}`);
  return { sb, run, removed, power, patched, stored };
}

test('chmod -R 777 у всего: ничего не удалено, сид прежний, причина — про права', async (t) => {
  const spec = withModes(cleanSpec(), { fileMode: 0o777, dirMode: 0o777 });
  const { sb, run, removed, power, patched, stored } = await wipe(t, spec, { targets: MAP_BP, map: RANDOM_SEED });
  assert.equal(run.ok, false);
  assert.deepEqual(removed, [], 'вайп что-то удалил');
  assert.deepEqual(sb.tunnel.paths('delete'), []);
  assert.equal(patched, false, 'переменные карты записывались');
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '12345', 'сид сменён, хотя вайп не прошёл');
  assert.equal(run.seed, null);
  const error = run.errors[0] || '';
  assert.match(error, /777/, 'в причине нет слов про права 777');
  assert.match(error, /644/);
  assert.match(error, /755/);
  assert.ok(error.includes('/server/rust'), 'в причине нет пути');
  assert.doesNotMatch(error, /Ни один путь не найден/, 'причина та же, что при пустом списке');
  assert.ok(String(stored.lastError).includes('777'), 'в карточке профиля другая причина');
  // Сервер остановил плагин — после отказа он поднят.
  assert.deepEqual(power, ['stop', 'start']);
  assert.equal(sb.status(), 'running');
  assert.equal(run.steps.some((step) => step.action === 'map' || step.action === 'delete'), false);
});

test('права 777 у одной папки (/oxide/data/Kits), «Данные Oxide»: вайп не начат, удалено 0', async (t) => {
  const spec = withModes(cleanSpec(), { dirMode: 0o777, only: (path) => path === '/oxide/data/Kits' });
  const { sb, run, removed } = await wipe(t, spec, { targets: ['/oxide/data/*'] });
  assert.equal(run.ok, false, 'прогон «успешно», хотя Kits остался');
  assert.deepEqual(removed, []);
  assert.ok(sb.tree.exists('/oxide/data/Kits.json'), 'остальное удалено — вайп прошёл наполовину');
  assert.ok(run.errors[0].includes('/oxide/data/Kits'), 'в причине нет пути с правами 777');
  assert.equal(run.status, 'failed');
});

test('права 777 у файла .sav, «Карта + блюпринты» со случайным сидом: вайп не начат, сид прежний', async (t) => {
  const spec = withModes(cleanSpec(), { fileMode: 0o777, only: (path) => path === SAV });
  const { sb, run, removed, patched } = await wipe(t, spec, { targets: MAP_BP, map: RANDOM_SEED });
  assert.equal(run.ok, false, 'прогон «успешно», хотя .sav остался');
  assert.deepEqual(removed, []);
  assert.equal(patched, false);
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '12345');
  assert.ok(run.errors[0].includes(SAV));
});

test('больше 10 таких путей: в причине 10, остальные — числом; полный список — в предупреждениях', async (t) => {
  const spec = cleanSpec();
  for (let index = 1; index <= 12; index += 1) {
    spec.files[`/oxide/data/open${String(index).padStart(2, '0')}.json`] = { content: '{}', mode: 0o777 };
  }
  const { run } = await wipe(t, spec, { targets: ['/oxide/data/*.json'] });
  const error = run.errors[0];
  assert.equal(run.ok, false);
  const named = error.match(/\/oxide\/data\/open\d\d\.json/g) || [];
  assert.equal(named.length, 10, `в причине путей: ${named.length}`);
  assert.match(error, /ещё 2/);
  assert.equal(run.warnings.filter((warning) => warning.includes('/oxide/data/open')).length, 12);
});

test('проверка (dry-run) с правами 777: тоже ошибка с той же причиной', async (t) => {
  const spec = withModes(cleanSpec(), { fileMode: 0o777, only: (path) => path === SAV });
  const { run, removed, power } = await wipe(t, spec, { targets: MAP_BP, map: RANDOM_SEED }, { dryRun: true });
  assert.equal(run.dryRun, true);
  assert.equal(run.ok, false, 'проверка обещает удачный вайп, а вайп не пойдёт');
  assert.ok(run.errors[0].includes(SAV));
  assert.deepEqual(removed, []);
  assert.deepEqual(power, []);
});

test('контроль: без пропусков — как раньше: выбранное удалено, сид сменён', async (t) => {
  const { sb, run, removed, power } = await wipe(t, cleanSpec(), { targets: MAP_BP, map: RANDOM_SEED });
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.ok(removed.includes(SAV));
  assert.ok(removed.includes('/server/rust/proceduralmap.3000.12345.270.map'));
  assert.notEqual(sb.panel.server('srv1').environment.WORLD_SEED, '12345');
  assert.deepEqual(power, ['stop', 'start']);
  assert.equal(sb.status(), 'running');
});
