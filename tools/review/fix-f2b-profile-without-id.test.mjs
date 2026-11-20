/**
 * Исправление F2b: профиль без id не портит другие профили (находка L33-11,
 * часть в rust-autowipe/backend/lib/wipe.js; остальное — в index.js у F2a).
 *
 * В хранилище Catalyst v1.89.2 условие со значением undefined пропускается
 * (storage/collection-storage.ts, translateFilter): update({ id: undefined })
 * совпадает со всеми документами. Раньше итог прогона испорченного профиля
 * без id записывался во все профили всех серверов.
 *
 * Что проверяем: прогон профиля без id не меняет другие профили, а сам
 * прогон записан в историю.
 *
 * Запуск: node tools/review/fix-f2b-profile-without-id.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

test('прогон профиля без id не записывает свой итог в чужие профили', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const other = await sb.addProfile({
    serverId: 'srv1',
    options: { warnChat: false },
    lastRunAt: '2026-11-12T05:00:05.000Z',
    lastRunStatus: 'ok',
    lastRunId: 'run_week_ago',
  });
  const broken = { ...other, id: undefined, name: 'Испорченный', options: { warnChat: false, dryRun: true } };
  const run = await sb.wipe(broken);
  await sb.idle();

  const stored = sb.profiles().find((item) => item.id === other.id);
  t.note(`чужой профиль после прогона: lastRunId=${stored.lastRunId}, lastCheckId=${stored.lastCheckId ?? '—'}; в истории: ${sb.runs().length}`);
  assert.equal(stored.lastRunId, 'run_week_ago');
  assert.equal(stored.lastCheckId, undefined, 'итог проверки испорченного профиля не попал в чужой профиль');
  assert.equal(sb.runs().length, 1);
  assert.equal(sb.runs()[0].id, run.id);
});
