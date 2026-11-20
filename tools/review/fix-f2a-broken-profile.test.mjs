/**
 * Исправление F2a (находка L33-11): испорченная запись профиля без id не
 * трогает остальные профили.
 *
 * Фильтр { id: undefined } в хранилище Catalyst условием не считается
 * (collection-storage.ts v1.89.2) и совпадает со всеми документами. Было:
 * просроченная запись без id выполнялась, и её nextRunAt, отметки
 * предупреждений и итоги прогона записывались во все профили всех серверов.
 * Должно: тик пропускает такую запись (одно предупреждение в журнал), сервер
 * не трогается, другие профили не меняются.
 *
 * Запуск: node tools/review/fix-f2a-broken-profile.test.mjs
 * Всё на подменах песочницы: дерево файлов в памяти, сеть закрыта, часы поддельные.
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, makeProfile, test } from './sandbox.mjs';

test('запись без id пропускается, соседний профиль не меняется, в журнале одно предупреждение', async (t) => {
  const uuid2 = 'c0ffee00-0000-4000-8000-00000000b002';
  const sb = createSandbox({
    now: '2026-11-19T04:57:00.050Z',
    servers: [defaultServer({ id: 'srv1' }), defaultServer({ id: 'srv2', uuid: uuid2, name: 'Rust #2' })],
  });
  const { id: _drop, ...broken } = makeProfile('srv1', { name: 'Битая', nextRunAt: '2026-11-19T04:58:00.000Z' });
  void _drop;
  const good = makeProfile('srv2', { name: 'Исправный', nextRunAt: '2026-12-03T05:00:00.000Z' });
  sb.store.seed('profiles', [broken, good]);
  await sb.load();
  for (let minute = 0; minute < 3; minute += 1) {
    await sb.tick();
    await sb.clock.advance(60000);
  }
  await sb.idle();

  const stored = sb.profiles().find((item) => item.id === good.id);
  const warnings = sb.journal.entries.filter((entry) => entry.kind === 'log' && /без id/.test(entry.msg)).length;
  const power = sb.panel.calls.filter((call) => call.method === 'POST' && /\/(stop|start)$/.test(call.path)).length;
  t.note(`исправный: nextRunAt ${stored.nextRunAt}, lastRunAt ${stored.lastRunAt ?? '—'}, warnedRuns ${JSON.stringify(stored.warnedRuns ?? null)}; прогонов ${sb.runs().length}, питание ${power}, предупреждений в журнале ${warnings}`);
  assert.equal(stored.nextRunAt, '2026-12-03T05:00:00.000Z');
  assert.equal(stored.lastRunAt, undefined);
  assert.equal(stored.warnedRuns, undefined);
  assert.equal(sb.runs().length, 0);
  assert.equal(power, 0);
  assert.equal(warnings, 1);
});
