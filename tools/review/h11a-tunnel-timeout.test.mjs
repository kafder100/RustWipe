/**
 * Ревью RustWipe, гипотеза 11 (раздел 4.2 правил), утверждение H11a — в исходном
 * виде: «у файлового туннеля нет таймаута, зависший агент держит вайп вечно».
 *
 * Факт Catalyst v1.89.2: у самого плагина таймаута нет
 * (rust-autowipe/backend/lib/glob-walk.js:53, 74), но панель снимает каждый
 * запрос туннеля через 60 с с ошибкой «Agent file operation timed out»
 * (catalyst-backend/src/services/file-tunnel.ts:52, 276-286; таймер ставится сразу
 * в queueRequest и действует и для очереди, и для запроса у агента).
 * В песочнице это режим tunnel.hang({ panelTimeout: true }).
 *
 * Правильное поведение: агент перестал отвечать при раскрытии путей — вайп
 * не висит, а заканчивается ошибкой; ничего не удалено; сервер, который
 * остановил плагин, снова работает (README: «авто-подъём сервера при ошибке»).
 *
 * Запуск: node tools/review/h11a-tunnel-timeout.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

test('H11a: агент не отвечает на list — вайп завершается ошибкой через 60 с, сервер поднят', async (t) => {
  const sb = createSandbox();
  await sb.load();
  sb.tunnel.hang({ op: 'list', panelTimeout: true });
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile();
  const started = sb.clock.now();
  const run = await sb.wipe(profile);
  const tookSec = Math.round((sb.clock.now() - started) / 1000);
  await sb.idle();
  t.note(`вайп закончился через ${tookSec} с виртуального времени; ok=${run.ok}; ошибки: ${run.errors.join(' | ')}`);
  t.note(`шаги: ${run.steps.map((step) => step.action).join(' → ')}; статус сервера: ${sb.status()}`);
  assert.ok(tookSec <= 10 * 60, `вайп шёл ${tookSec} с`);
  assert.equal(run.ok, false);
  assert.deepEqual(sb.tree.diff(before).removed, []);
  assert.equal(sb.status(), 'running');
});
