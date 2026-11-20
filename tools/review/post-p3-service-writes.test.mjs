/**
 * Исправление P3 (R-6, часть index.js; регрессии R2-3 и R4-3): служебные
 * записи планировщика не меняют версию профиля.
 *
 * Было: версия профиля для редактора — updatedAt (договорённость К5: PUT с
 * устаревшим expectedUpdatedAt — 409 PROFILE_CHANGED). Но updatedAt меняли и
 * служебные записи index.js: тик, когда занимал срок перед вайпом, пропускал
 * срок, начинал отсчёт догона, ставил срок профилю без nextRunAt или
 * записывал точку отсчёта старого «каждые N дней», а также перенос срока
 * после ручного вайпа. Админ открыл редактор, прошёл тик — «Сохранить»
 * получало 409 «Профиль изменён в другом месте», хотя профиль никто не правил.
 * Должно: updatedAt меняет только правка профиля человеком; сохранение из
 * редактора, открытого до тика, — 200. Настоящий конфликт (правка в другой
 * вкладке) — по-прежнему 409.
 *
 * Итог настоящего вайпа в профиль пишет lib/wipe.js (часть P2), поэтому здесь
 * срок перед вайпом проверяется на профиле-проверке (dry-run: его итог идёт в
 * lastCheck*), а в тесте ручного вайпа executeProfileRun подменён (хук
 * загрузки node:module): проверяются только записи index.js.
 *
 * Запуск: node tools/review/post-p3-service-writes.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createSandbox, test } from './sandbox.mjs';

const WEEKLY = { kind: 'weekly', weekday: 4, time: '05:00', timeZone: 'UTC' };

// ── Подмена executeProfileRun для index.js (только пока stub.run задан) ─────
const stub = { run: null };
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const version = /[?&]rwsandbox=(\d+)/.exec(context.parentURL || '')?.[1];
    if (!stub.run || !version || !/\/backend\/index\.js\?/.test(context.parentURL || '')) return result;
    const file = result.url.split('?')[0];
    if (!file.endsWith('/lib/wipe.js')) return result;
    const real = JSON.stringify(`${file}?rwsandbox=${version}`);
    const source =
      `export * from ${real};\n` +
      'export function executeProfileRun(ctx, profile, options) { return globalThis.__p3Run(ctx, profile, options); }\n';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

/** Включить подмену executeProfileRun на время теста. */
function useRunStub(t, run) {
  globalThis.__p3Run = run;
  stub.run = true;
  t.cleanup(() => {
    stub.run = null;
    delete globalThis.__p3Run;
  });
}

/** Карточка профиля — то, что видит открытый редактор. */
async function openEditor(sb) {
  const list = await sb.call('admin', 'GET', '/servers/srv1/profiles');
  assert.equal(list.status, 200);
  return list.body.data[0];
}

/** «Сохранить» в редакторе: поля черновика и версия, которую он видел (как saveProfile во вкладке). */
function saveEditor(sb, card, changes = {}) {
  const draft = { ...card, ...changes };
  return sb.call('admin', 'PUT', `/servers/srv1/profiles/${card.id}`, {
    body: {
      name: draft.name,
      serverId: draft.serverId,
      enabled: draft.enabled,
      schedule: draft.schedule,
      targets: draft.targets,
      excludes: draft.excludes,
      options: draft.options,
      map: draft.map,
      expectedUpdatedAt: card.updatedAt,
    },
  });
}

test('R-6: тик пропустил срок (опоздание больше catchUpMinutes) — сохранение из открытого редактора проходит', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T10:00:00.040Z' });
  await sb.addProfile({ name: 'Карта', schedule: WEEKLY, nextRunAt: '2026-11-19T05:00:00.000Z' });
  await sb.load();
  const card = await openEditor(sb);
  await sb.clock.advance(60000);
  await sb.tick();
  const afterTick = { ...sb.profiles()[0] };
  await sb.clock.advance(60000);
  const saved = await saveEditor(sb, card, { name: 'Карта (правка)' });
  // Вторая вкладка открыта до этой правки: это настоящий конфликт.
  const other = await saveEditor(sb, card, { name: 'Карта (вторая вкладка)' });
  t.note(`после тика: nextRunAt ${afterTick.nextRunAt}, пропуск «${afterTick.lastSkipReason}», updatedAt ${afterTick.updatedAt} (в редакторе ${card.updatedAt})`);
  t.note(`сохранение → ${saved.status} ${saved.body?.code ?? ''}; вторая вкладка → ${other.status} ${other.body?.code ?? ''}`);

  assert.match(String(afterTick.lastSkipReason), /пропущен/);
  assert.equal(afterTick.nextRunAt, '2026-11-26T05:00:00.000Z');
  assert.equal(afterTick.updatedAt, card.updatedAt, 'пропуск срока — служебная запись, версия профиля прежняя');
  assert.equal(saved.status, 200);
  assert.equal(sb.profiles()[0].name, 'Карта (правка)');
  assert.equal(sb.profiles()[0].nextRunAt, '2026-11-26T05:00:00.000Z', 'правка без смены расписания срок не трогает');
  assert.equal(other.status, 409, 'правка в другой вкладке — по-прежнему конфликт');
  assert.equal(other.body.code, 'PROFILE_CHANGED');
});

test('R-6: тик начал отсчёт догона — сохранение проходит, отсчёт идёт дальше', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:30:00.040Z' });
  await sb.addProfile({ name: 'Карта', schedule: WEEKLY, nextRunAt: '2026-11-19T05:00:00.000Z' });
  await sb.load();
  const card = await openEditor(sb);
  await sb.clock.advance(1000);
  await sb.tick(); // 05:30 — отсчёт в чате, вайп в 05:35
  const afterTick = { ...sb.profiles()[0] };
  await sb.clock.advance(60000);
  const saved = await saveEditor(sb, card, { name: 'Карта (правка)' });
  const stored = sb.profiles()[0];
  t.note(`после тика: nextRunAt ${afterTick.nextRunAt}, catchUpOf ${afterTick.catchUpOf}, updatedAt ${afterTick.updatedAt} (в редакторе ${card.updatedAt}); сохранение → ${saved.status} ${saved.body?.code ?? ''}`);

  assert.equal(afterTick.nextRunAt, '2026-11-19T05:35:00.000Z');
  assert.equal(afterTick.catchUpOf, '2026-11-19T05:00:00.000Z');
  assert.equal(afterTick.updatedAt, card.updatedAt, 'отсчёт догона — служебная запись, версия профиля прежняя');
  assert.equal(saved.status, 200);
  assert.equal(stored.nextRunAt, '2026-11-19T05:35:00.000Z', 'правка без смены расписания отсчёт не сбрасывает');
  assert.equal(stored.catchUpOf, '2026-11-19T05:00:00.000Z');
});

test('R-6: тик занял срок и записал точку отсчёта старого «каждые N дней» (профиль-проверка) — сохранение проходит', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T05:00:00.040Z' });
  await sb.addProfile({
    name: 'Проверка',
    schedule: { kind: 'interval', time: '05:00', timeZone: 'UTC', weekday: 4, nth: 1, day: 1, intervalDays: 7, anchorDate: null },
    nextRunAt: '2026-11-19T05:00:00.000Z',
    options: { dryRun: true },
  });
  await sb.load();
  const card = await openEditor(sb);
  await sb.clock.advance(1000);
  await sb.tick();
  await sb.idle();
  const afterTick = { ...sb.profiles()[0] };
  await sb.clock.advance(60000);
  const saved = await saveEditor(sb, card, { name: 'Проверка (правка)' });
  const stored = sb.profiles()[0];
  t.note(`после тика: проверка ${afterTick.lastCheckStatus}, nextRunAt ${afterTick.nextRunAt}, точка отсчёта ${afterTick.schedule.anchorDate}, updatedAt ${afterTick.updatedAt} (в редакторе ${card.updatedAt}); сохранение → ${saved.status} ${saved.body?.code ?? ''}`);

  assert.equal(sb.runs().length, 1);
  assert.equal(afterTick.lastCheckStatus, 'ok');
  assert.equal(afterTick.nextRunAt, '2026-11-26T05:00:00.000Z');
  assert.equal(afterTick.schedule.anchorDate, '2026-11-19', 'тик сохранил вычисленную точку отсчёта');
  assert.equal(afterTick.updatedAt, card.updatedAt, 'срок и точка отсчёта — служебные записи, версия профиля прежняя');
  assert.equal(saved.status, 200);
  assert.equal(stored.schedule.anchorDate, '2026-11-19', 'сохранение из редактора точку отсчёта не теряет');
  assert.equal(stored.nextRunAt, '2026-11-26T05:00:00.000Z');
});

test('R-6: тик поставил срок профилю без nextRunAt — сохранение проходит', async (t) => {
  const sb = createSandbox({ now: '2026-11-19T10:00:00.040Z' });
  await sb.addProfile({ name: 'Карта', schedule: WEEKLY }); // nextRunAt нет
  await sb.load();
  const card = await openEditor(sb);
  await sb.clock.advance(1000);
  await sb.tick();
  const afterTick = { ...sb.profiles()[0] };
  const saved = await saveEditor(sb, card, { name: 'Карта (правка)' });
  t.note(`после тика: nextRunAt ${afterTick.nextRunAt}, updatedAt ${afterTick.updatedAt} (в редакторе ${card.updatedAt}); сохранение → ${saved.status} ${saved.body?.code ?? ''}`);

  assert.equal(card.nextRunAt, null);
  assert.equal(afterTick.nextRunAt, '2026-11-26T05:00:00.000Z');
  assert.equal(afterTick.updatedAt, card.updatedAt, 'срок — служебная запись, версия профиля прежняя');
  assert.equal(saved.status, 200);
});

test('R-6: ручной вайп, на который пришёлся плановый срок, — перенос срока не меняет версию профиля', async (t) => {
  // Прогон подменён: итог в профиль он не пишет (это часть wipe.js) — смотрим только index.js.
  useRunStub(t, async (_ctx, profile, options) => ({
    id: 'run_p3_manual',
    profileId: profile.id,
    serverId: profile.serverId,
    trigger: options?.trigger,
    dryRun: false,
    ok: true,
    deletedCount: 2,
    finishedAt: new Date().toISOString(),
  }));
  const sb = createSandbox({ now: '2026-11-19T05:00:20.000Z' });
  await sb.addProfile({ name: 'Карта', schedule: WEEKLY, nextRunAt: '2026-11-19T05:00:00.000Z', options: { warnChat: false } });
  await sb.load();
  const card = await openEditor(sb);
  await sb.clock.advance(10000);
  const run = await sb.call('admin', 'POST', `/servers/srv1/profiles/${card.id}/run`, { body: {} });
  await sb.idle();
  const afterRun = { ...sb.profiles()[0] };
  await sb.clock.advance(60000);
  const saved = await saveEditor(sb, card, { name: 'Карта (правка)' });
  t.note(`ручной вайп → ${run.status}; после: nextRunAt ${afterRun.nextRunAt}, updatedAt ${afterRun.updatedAt} (в редакторе ${card.updatedAt}); сохранение → ${saved.status} ${saved.body?.code ?? ''}`);

  assert.equal(run.status, 200);
  assert.equal(afterRun.nextRunAt, '2026-11-26T05:00:00.000Z', 'плановый срок покрыт ручным вайпом — перенесён');
  assert.equal(afterRun.updatedAt, card.updatedAt, 'перенос срока — служебная запись, версия профиля прежняя');
  assert.equal(saved.status, 200);
});
