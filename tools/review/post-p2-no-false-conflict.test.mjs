/**
 * После второго круга, R-6 (регрессии R2-3 и R4-3, часть wipe.js): итог вайпа
 * записывался в профиль вместе с updatedAt. А updatedAt — это версия профиля
 * для редактора: PUT сверяет её с expectedUpdatedAt. Админ открыл редактор,
 * в это время прошёл вайп (из другой вкладки или ночью), админ жмёт
 * «Сохранить» — и получает 409 «Профиль изменён в другом месте», хотя пути и
 * расписание никто не менял.
 *
 * Правильное поведение: служебные записи плагина после прогона updatedAt не
 * трогают — его меняет только правка профиля человеком. Проверка версии в
 * PUT остаётся: правка в другой вкладке по-прежнему даёт 409.
 *
 * Здесь — ручной вайп: его итог пишет только wipe.js. Служебные записи тика
 * (занять срок, пропуск, догон) — в index.js, это отдельная правка.
 *
 * Запуск: node tools/review/post-p2-no-false-conflict.test.mjs
 * Всё на подменах песочницы (sandbox.mjs): по-настоящему ничего не удаляется.
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

async function openEditorThenWipe(t, { dryRun = false } = {}) {
  const sb = createSandbox();
  await sb.load();
  const created = await sb.call('admin', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Карта',
      targets: ['/server/*/proceduralmap.*.map'],
      schedule: { kind: 'weekly', weekday: 1, time: '05:00' },
      options: { warnChat: false },
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  await sb.clock.advance(60000);
  // Админ открыл редактор: карточка из списка профилей.
  const list = await sb.call('admin', 'GET', '/servers/srv1/profiles');
  const card = list.body.data.find((item) => item.id === created.body.data.id);

  // Пока редактор открыт, из другой вкладки запускают вайп.
  await sb.clock.advance(60000);
  const started = await sb.call('admin', 'POST', `/servers/srv1/profiles/${card.id}/run`, { body: { dryRun } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await sb.until(() => sb.runs().length > 0 && sb.runs().every((run) => run.status !== 'running'));
  await sb.idle();
  const stored = sb.profiles().find((item) => item.id === card.id);
  t.note(`прогон: ${sb.runs().map((run) => `${run.status} ok=${run.ok}`).join('; ')}`);
  t.note(`updatedAt: в редакторе ${card.updatedAt}, в базе ${stored.updatedAt}`);
  return { sb, card, stored };
}

test('открыл редактор, прошёл вайп, сохранил — 200, а не 409', async (t) => {
  const { sb, card, stored } = await openEditorThenWipe(t);
  assert.ok(stored.lastRunAt, 'итог вайпа не записан в профиль');
  assert.equal(stored.lastRunStatus, 'ok');
  const saved = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { ...card, name: 'Карта (новое имя)', expectedUpdatedAt: card.updatedAt },
  });
  t.note(`PUT → ${saved.status} ${saved.body?.code ?? ''}`);
  assert.equal(saved.status, 200, `ложный конфликт: ${saved.body?.code} «${saved.body?.error}»`);
  assert.equal(sb.profiles().find((item) => item.id === card.id).name, 'Карта (новое имя)');
});

test('контроль: после проверки (dry-run) — тоже 200', async (t) => {
  const { sb, card } = await openEditorThenWipe(t, { dryRun: true });
  const saved = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { ...card, name: 'Карта (новое имя)', expectedUpdatedAt: card.updatedAt },
  });
  assert.equal(saved.status, 200, `${saved.body?.code} «${saved.body?.error}»`);
});

test('контроль: правка в другой вкладке после вайпа — по-прежнему 409', async (t) => {
  const { sb, card } = await openEditorThenWipe(t);
  await sb.clock.advance(1000);
  // Другая вкладка открыта уже после вайпа и меняет пути.
  const fresh = (await sb.call('admin', 'GET', '/servers/srv1/profiles')).body.data.find((item) => item.id === card.id);
  const other = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { ...fresh, targets: ['/server/*/proceduralmap.*.sav'], expectedUpdatedAt: fresh.updatedAt },
  });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const stale = await sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: { ...card, name: 'Устаревшая вкладка', expectedUpdatedAt: card.updatedAt },
  });
  t.note(`другая вкладка → ${other.status}; устаревшая → ${stale.status} ${stale.body?.code ?? ''}`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PROFILE_CHANGED');
});
