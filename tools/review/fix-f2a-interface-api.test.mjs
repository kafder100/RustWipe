/**
 * Исправление F2a: ответы роутов для вкладки по договорённостям К2 и К5.
 *
 *  - К2, находка H5b: POST …/preview отдаёт вместе с путями directories (какие
 *    пути — каталоги: удалятся целиком, со всем содержимым), skipped и
 *    limitHit. Эти поля считает expandTargets (glob-walk.js, часть F1) — в этой
 *    ветке их ещё нет, поэтому здесь glob-walk.js для index.js подменён
 *    обёрткой: настоящий expandTargets плюс поля К2. Проверяем, что роут их
 *    передаёт как есть, а без них отдаёт пустые значения;
 *  - К5: GET …/profiles отдаёт итог последней проверки (lastCheck*) отдельно
 *    от итога настоящего вайпа.
 *
 * Запуск: node tools/review/fix-f2a-interface-api.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createSandbox, test } from './sandbox.mjs';

// ── Подмена lib/glob-walk.js для index.js (только пока stub.globWalk задан) ─
const stub = { globWalk: null };
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const version = /[?&]rwsandbox=(\d+)/.exec(context.parentURL || '')?.[1];
    if (!stub.globWalk || !version || !/\/backend\/index\.js\?/.test(context.parentURL || '')) return result;
    const file = result.url.split('?')[0];
    if (!file.endsWith('/lib/glob-walk.js')) return result;
    const real = JSON.stringify(`${file}?rwsandbox=${version}`);
    const source =
      `import * as real from ${real};\n` +
      `export * from ${real};\n` +
      'export async function expandTargets(...args) {\n' +
      '  const result = await real.expandTargets(...args);\n' +
      '  return { ...result, ...globalThis.__f2aExpandStub(result) };\n' +
      '}\n';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

test('К2: предпросмотр передаёт directories, skipped и limitHit из раскрытия путей', async (t) => {
  globalThis.__f2aExpandStub = (result) => ({
    directories: result.paths.filter((path) => path === '/server/rust'),
    skipped: [{ path: '/server/rust/link', reason: 'ссылка — не удаляется' }],
    limitHit: { kind: 'listings', detail: '250 запросов list' },
    truncated: true,
  });
  stub.globWalk = true;
  t.cleanup(() => {
    stub.globWalk = null;
    delete globalThis.__f2aExpandStub;
  });
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/server/rust'] });
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  const data = res.body.data;
  t.note(`ответ: ${JSON.stringify({ paths: data.paths, directories: data.directories, skipped: data.skipped, limitHit: data.limitHit, truncated: data.truncated })}`);
  assert.equal(res.status, 200);
  assert.deepEqual(data.paths, ['/server/rust']);
  assert.deepEqual(data.directories, ['/server/rust']);
  assert.deepEqual(data.skipped, [{ path: '/server/rust/link', reason: 'ссылка — не удаляется' }]);
  assert.deepEqual(data.limitHit, { kind: 'listings', detail: '250 запросов list' });
  assert.equal(data.truncated, true);
});

test('К2: если раскрытие этих полей не дало — пустые значения, а не undefined', async (t) => {
  const sb = createSandbox();
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/server/*/proceduralmap.*.map'] });
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  const { directories, skipped, limitHit } = res.body.data;
  t.note(JSON.stringify({ directories, skipped, limitHit }));
  assert.deepEqual({ directories, skipped, limitHit }, { directories: [], skipped: [], limitHit: null });
});

test('К5: у профиля в списке есть итог последней проверки — отдельно от итога вайпа', async (t) => {
  const sb = createSandbox();
  await sb.load();
  await sb.addProfile({
    lastRunAt: '2026-11-12T05:00:00.000Z',
    lastRunStatus: 'ok',
    lastRunId: 'run_real',
    lastCheckAt: '2026-11-18T12:00:00.000Z',
    lastCheckStatus: 'failed',
    lastCheckId: 'run_check',
    lastCheckError: 'Ни один путь не найден',
  });
  const card = (await sb.call('owner', 'GET', '/servers/srv1/profiles')).body.data[0];
  const picked = ['lastRunStatus', 'lastRunId', 'lastCheckAt', 'lastCheckStatus', 'lastCheckId', 'lastCheckError'].map((key) => [key, card[key]]);
  t.note(JSON.stringify(Object.fromEntries(picked)));
  assert.deepEqual(Object.fromEntries(picked), {
    lastRunStatus: 'ok',
    lastRunId: 'run_real',
    lastCheckAt: '2026-11-18T12:00:00.000Z',
    lastCheckStatus: 'failed',
    lastCheckId: 'run_check',
    lastCheckError: 'Ни один путь не найден',
  });
});
