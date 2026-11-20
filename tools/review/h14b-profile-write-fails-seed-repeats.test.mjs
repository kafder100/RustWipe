/**
 * Ревью RustWipe, гипотеза 14 (раздел 4.2), утверждение H14b:
 * после вайпа плагин одной записью обновляет профиль: «последний прогон» и
 * курсор ротации сида (mapState). Если эта запись не удалась, сид уже записан
 * в переменные сервера, а курсор остался прежним — следующий вайп снова
 * ставит тот же сид (та же карта), хотя по профилю сиды идут по очереди.
 *
 * Правильное поведение (README, «Сид и размер карты»: сиды «по списку по
 * очереди», курсор двигается после реальной записи): один сбой записи в
 * коллекцию profiles не ломает очередь сидов — следующий вайп берёт
 * следующий сид из списка.
 *
 * Сбой внедряется store.failWrite: N-я запись в profiles за первый прогон
 * падает один раз (N = 1, 2 — свой тест на каждую), потом правило снимается.
 *
 * Запуск: node tools/review/h14b-profile-write-fails-seed-repeats.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): файлы — дерево в памяти,
 * панель и часы поддельные, по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const ROTATE = { seed: { mode: 'rotate', values: [111, 222, 333] }, size: { mode: 'keep' } };

for (const nth of [1, 2]) {
  test(`сбой записи №${nth} в profiles после вайпа: следующий вайп берёт следующий сид из списка`, async (t) => {
    const sb = createSandbox({ now: '2026-11-19T10:00:00.000Z' });
    const completed = () => sb.journal.of('event').filter((entry) => entry.event === 'rust-autowipe:run-completed').length;
    const seedNow = () => sb.panel.server('srv1').environment.WORLD_SEED;
    const profile = await sb.addProfile({ nextRunAt: '2026-11-26T05:00:00.000Z', map: ROTATE, options: { warnChat: false } });
    await sb.load();

    const removeFailure = sb.store.failWrite({ collection: 'profiles', op: 'update', nth, times: 1 });
    let res = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
    assert.equal(res.status, 200);
    await sb.until(() => completed() >= 1);
    await sb.idle();
    removeFailure();
    const firstSeed = seedNow();
    const failed = sb.journal.of('db').filter((entry) => entry.failed).map((entry) => `${entry.table}.${entry.op}`);

    res = await sb.call('admin', 'POST', `/servers/srv1/profiles/${profile.id}/run`, { body: {} });
    assert.equal(res.status, 200);
    await sb.until(() => completed() >= 2);
    await sb.idle();
    const secondSeed = seedNow();

    t.note(`сбои записи: ${failed.join(', ') || 'нет'}; WORLD_SEED после 1-го вайпа: ${firstSeed}, после 2-го: ${secondSeed}`);
    t.note(`профиль: lastSeed=${sb.profiles()[0].lastSeed ?? '—'}, mapState=${JSON.stringify(sb.profiles()[0].mapState ?? null)}`);
    assert.equal(firstSeed, '111', 'предусловие: первый вайп ставит первый сид из списка');
    assert.equal(secondSeed, '222', 'второй вайп повторил тот же сид — очередь сидов сбилась');
  });
}
