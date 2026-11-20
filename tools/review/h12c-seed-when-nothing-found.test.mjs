/**
 * Ревью RustWipe, гипотеза 12 (раздел 4.2), утверждение H12c:
 * сид меняется до раскрытия путей — профиль не нашёл ни одного файла, а
 * сервер всё равно стартует с новым сидом и старыми файлами.
 *
 * Правильное поведение (ответ владельца №9 «Да, менять всё равно»): если
 * удалять нечего, сид и размер карты всё равно меняются. Это выбор владельца,
 * поэтому тест проверяет именно его: сид записан, сервер после вайпа поднят.
 * Тест проходит — значит, гипотеза как дефект опровергнута.
 *
 * Запуск: node tools/review/h12c-seed-when-nothing-found.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

test('удалять нечего: сид всё равно записан, файлы целы, сервер после вайпа поднят', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({
    targets: ['/server/*/proceduralmap.9999.*.map'],
    map: { seed: { mode: 'fixed', value: 777 }, size: { mode: 'keep' } },
  });

  const run = await sb.wipe(profile);
  await sb.idle();

  t.note(`история: ok=${run.ok}, ошибки: ${run.errors.join(' | ') || 'нет'}`);
  t.note(`WORLD_SEED в панели: ${sb.panel.server('srv1').environment.WORLD_SEED}; статус сервера: ${sb.status()}`);
  assert.deepEqual(sb.tree.diff(before).removed, [], 'удалять было нечего');
  assert.equal(sb.panel.server('srv1').environment.WORLD_SEED, '777', 'по выбору владельца сид меняется, даже если удалять нечего');
  assert.equal(sb.status(), 'running', 'сервер, который остановил плагин, после вайпа снова работает');
});
