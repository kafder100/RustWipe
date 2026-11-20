/**
 * Исправление F2b: порядок шагов вайпа и отмена при пределе раскрытия
 * (находки H2c и H12d, договорённость К3).
 *
 * Что проверяем:
 *   1) порядок: остановка → раскрытие путей → смена сида и размера → удаление;
 *   2) раскрытие упёрлось в предел — ничего не удалено, сид прежний,
 *      сервер снова работает, прогон неудачный и причина называет предел;
 *   3) раскрытие прошло, но удалять нечего — сид всё равно меняется
 *      (выбор владельца, вопрос 9), прогон неудачный, сервер поднят.
 *
 * Запуск: node tools/review/fix-f2b-expand-before-map.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const SEED_777 = { seed: { mode: 'fixed', value: 777 }, size: { mode: 'keep' } };
const patches = (sb) => sb.panel.calls.filter((call) => call.method === 'PATCH' && call.path === '/api/servers/srv1/variables');

test('порядок: остановка → раскрытие путей → сид и размер → удаление', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ map: SEED_777 });
  const run = await sb.wipe(profile);
  await sb.idle();

  const seqOf = (predicate) => sb.journal.entries.filter(predicate).map((entry) => entry.seq);
  const stopped = seqOf((entry) => entry.kind === 'server' && entry.to === 'stopped');
  const lists = seqOf((entry) => entry.kind === 'tunnel' && entry.op === 'list');
  const patch = seqOf((entry) => entry.kind === 'fetch' && entry.method === 'PATCH');
  const deletes = seqOf((entry) => entry.kind === 'tunnel' && entry.op === 'delete');
  t.note(`шаги: ${run.steps.map((step) => step.action).join(' → ')}`);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.ok(stopped.length && lists.length && patch.length && deletes.length, 'все шаги были');
  assert.ok(stopped[0] < Math.min(...lists), 'раскрытие — после остановки');
  assert.ok(Math.max(...lists) < patch[0], 'сид меняется только после раскрытия путей');
  assert.ok(patch[0] < Math.min(...deletes), 'сид меняется до удаления');
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '777');
});

test('предел раскрытия (600 файлов при пределе 500): ничего не удалено, сид прежний, сервер работает', async (t) => {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= 600; index += 1) files[`/oxide/data/Data${String(index).padStart(3, '0')}.json`] = '{}';
  const sb = createSandbox({ tree: { files } });
  await sb.load();
  const seedBefore = sb.panel.server('srv1').environment.WORLD_SEED;
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], map: SEED_777 });
  const run = await sb.wipe(profile);
  await sb.idle();

  t.note(`прогон: ok=${run.ok}; ошибки: ${run.errors.join(' | ')}`);
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => /предел/.test(error) && /ничего не удалено/.test(error)), 'причина называет предел');
  assert.deepEqual(sb.tunnel.paths('delete'), [], 'ни одного удаления');
  assert.equal(patches(sb).length, 0, 'переменные карты не трогали');
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, seedBefore, 'сид прежний');
  assert.equal(sb.status(), 'running', 'сервер снова работает');
  assert.ok(!run.steps.some((step) => step.action === 'map' && step.data?.changed), 'шага смены карты нет');
});

test('удалять нечего: сид всё равно меняется (вопрос 9), прогон — ошибка, сервер поднят', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/server/*/proceduralmap.9999.*.map'], map: SEED_777 });
  const run = await sb.wipe(profile);
  await sb.idle();

  t.note(`шаги: ${run.steps.map((step) => `${step.action}${step.ok ? '' : '!'}`).join(' → ')}`);
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('Ни один путь не найден')));
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '777');
  assert.equal(sb.status(), 'running');
});
