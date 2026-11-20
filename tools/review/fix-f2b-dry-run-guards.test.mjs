/**
 * Исправление F2b: режим проверки (dry-run) под защитой тестов (находка L34-2).
 *
 * Раньше dry-run проверялся только флагом в самом профиле. Поломки «глобальная
 * настройка dryRun плагина игнорируется» и «роут /run не видит dryRun: true из
 * кнопки «Проверка (dry-run)»» проходили все тесты — и вайп шёл по-настоящему.
 *
 * Что проверяем (профили боевые: options.dryRun = false):
 *   1) настройка плагина dryRun: true — ручной вайп ничего не удаляет, сервер
 *      не останавливается, карта не меняется, в истории dryRun: true;
 *   2) то же для планового вайпа (тик планировщика);
 *   3) POST …/run с { dryRun: true } (кнопка «Проверка (dry-run)») — ничего не
 *      удалено, питание не трогали, ответ и история говорят dryRun: true.
 *
 * Запуск: node tools/review/fix-f2b-dry-run-guards.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const SEED_777 = { seed: { mode: 'fixed', value: 777 }, size: { mode: 'keep' } };
const changes = (sb) =>
  sb.panel.calls
    .filter((call) => ['POST', 'PATCH'].includes(call.method) && /\/(stop|start|restart|kill|variables)$/.test(call.path))
    .map((call) => `${call.method} ${call.path}`);

function assertNothingTouched(sb, before) {
  assert.deepEqual(sb.tunnel.paths('delete'), [], 'удалений не было');
  assert.deepEqual(sb.tree.snapshot(), before, 'файлы на месте');
  assert.deepEqual(changes(sb), [], 'питание и переменные карты не трогали');
  assert.equal(sb.status(), 'running', 'сервер не останавливали');
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '12345', 'сид прежний');
}

test('настройка плагина dryRun: true — ручной вайп боевого профиля ничего не удаляет', async (t) => {
  const sb = createSandbox({ config: { dryRun: true } });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ map: SEED_777, options: { dryRun: false, warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`прогон: ok=${run.ok}, dryRun=${run.dryRun}, было бы удалено: ${run.deleted.length}`);
  assert.equal(run.dryRun, true);
  assert.equal(sb.runs()[0].dryRun, true, 'в истории — проверка');
  assertNothingTouched(sb, before);
});

test('настройка плагина dryRun: true — плановый вайп боевого профиля ничего не удаляет', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.050Z', config: { dryRun: true } });
  await sb.load();
  await sb.addProfile({ nextRunAt: '2026-11-19T05:00:00.000Z', map: SEED_777, options: { dryRun: false, warnChat: false } });
  const before = sb.tree.snapshot();
  await sb.tick();
  await sb.idle();
  const [run] = sb.runs();
  t.note(`история: ${run ? `trigger=${run.trigger}, dryRun=${run.dryRun}, ok=${run.ok}` : 'пусто'}`);
  assert.ok(run, 'плановый прогон был');
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.dryRun, true);
  assertNothingTouched(sb, before);
});

test('кнопка «Проверка (dry-run)»: POST /run с { dryRun: true } у боевого профиля ничего не удаляет', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ map: SEED_777, options: { dryRun: false, warnChat: false } });
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: { dryRun: true } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await sb.until(() => sb.runs().some((run) => run.status !== 'running'));
  await sb.idle();
  const [run] = sb.runs();
  t.note(`ответ: dryRun=${res.body.dryRun}; история: dryRun=${run.dryRun}, ok=${run.ok}`);
  assert.equal(res.body.dryRun, true, 'ответ говорит, что это проверка');
  assert.equal(run.dryRun, true, 'в истории — проверка');
  assertNothingTouched(sb, before);
});
