/**
 * После второго круга, R-12 (H3a «осталось»): старый профиль с целью на весь
 * корень (/**\/*, /*, /?* …) сначала останавливал сервер, потом отказывал и
 * запускал сервер снова — и так при каждом плановом запуске.
 *
 * Правильное поведение: цель на корень проверяется до остановки. Сервер не
 * останавливается, ничего не удаляется, причина — в истории прогона.
 *
 * Запуск: node tools/review/post-p2-root-before-stop.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const powerCalls = (sb) =>
  sb.panel.calls.filter((call) => call.method === 'POST' && /\/api\/servers\/srv1\/(stop|start)$/.test(call.path));

for (const mask of ['/**/*', '/*', '/?*']) {
  test(`старый профиль с целью ${mask}: сервер не останавливается, причина в истории`, async (t) => {
    const sb = createSandbox();
    await sb.load();
    // Так профиль лежит в базе, если его сохранила версия 1.5.6.
    const profile = await sb.addProfile({ targets: ['/oxide/data/Kits.json', mask], options: { warnChat: false } });
    const before = sb.tree.snapshot();
    const run = await sb.wipe(profile, { trigger: 'schedule', slot: '2026-11-19T00:00:00.000Z' });
    await sb.idle();

    const power = powerCalls(sb).map((call) => call.path.split('/').pop());
    const [record] = sb.runs();
    t.note(`питание: ${power.join(', ') || 'нет'}; шаги: ${run.steps.map((step) => step.action).join(' → ')}`);
    t.note(`ошибки в истории: ${JSON.stringify(record.errors)}`);
    assert.deepEqual(power, [], 'сервер остановили (и запустили снова) только ради отказа');
    assert.equal(sb.status(), 'running');
    assert.equal(run.ok, false);
    assert.equal(run.steps.some((step) => step.action === 'stop'), false, 'в шагах есть остановка');
    assert.deepEqual(sb.tree.diff(before).removed, []);
    assert.equal(record.status, 'failed');
    assert.ok(
      record.errors.some((error) => error.includes(mask) && error.includes('корня')),
      'в истории нет причины: цель на весь корень',
    );
    const stored = sb.profiles().find((item) => item.id === profile.id);
    assert.ok(String(stored.lastError).includes('корня'), 'в карточке профиля нет причины');
  });
}

test('контроль: обычная цель — сервер останавливается и запускается, как раньше', async () => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/oxide/data/Kits.json'], options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.deepEqual(powerCalls(sb).map((call) => call.path.split('/').pop()), ['stop', 'start']);
  assert.equal(sb.tree.exists('/oxide/data/Kits.json'), false);
  assert.equal(sb.status(), 'running');
});
