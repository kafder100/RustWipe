/**
 * F1, находка L32-4: имя файла с «\» или с пробелом на краю превращалось
 * в другой путь. Плагин обрезал пробелы у имени из листинга, а «\» в пути
 * менял на «/» (так же делает и панель перед отправкой агенту:
 * catalyst-backend/src/lib/path-validation.ts, normalizeRequestPath).
 * Файл «Kits\data.json» при цели /oxide/data/*.json превращался в
 * /oxide/data/Kits/data.json — удалялся чужой файл, иногда исключённый.
 * Файл «player.blueprints.5.db » (пробел в конце) удалить было нельзя:
 * агент отвечал «нет файла», вайп считался успешным.
 *
 * Правильное поведение (ответ владельца №3 «строго выбранные файлы»;
 * договорённость К2): такое имя не удаляется и не обходится, а попадает
 * в skipped с причиной. Имя с пробелом в начале панель не трогает —
 * такой файл удаляется как обычный.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-odd-names.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, test } from './sandbox.mjs';

const BACKSLASH = '/oxide/data/Kits\\data.json';
const TRAILING = '/server/rust/player.blueprints.5.db ';

function tree() {
  return {
    files: {
      '/RustDedicated': 1024,
      [BACKSLASH]: '{"backslash":true}',
      '/oxide/data/Kits/data.json': '{"real":true}',
      '/oxide/data/Kits/other.json': '{}',
      '/oxide/data/ lead.json': '{"leading":true}',
      '/oxide/data/plain.json': '{}',
      [TRAILING]: 'trailing',
      '/server/rust/player.blueprints.6.db': 'normal',
    },
  };
}

async function wipe(t, targets, excludes = []) {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const expansion = await sb.run(expandTargets(sb.ctx, server, targets, excludes));
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets, excludes });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`пути: ${expansion.paths.join(', ')}; пропущено: ${expansion.skipped.map((item) => JSON.stringify(item.path)).join(', ') || 'нет'}`);
  t.note(`delete: ${sb.tunnel.paths('delete').map((path) => JSON.stringify(path)).join(', ')}; ok=${run.ok}`);
  return { sb, expansion, removed, run };
}

test('L32-4: «Kits\\data.json» не превращается в Kits/data.json — чужой файл цел', async (t) => {
  const { sb, expansion, run } = await wipe(t, ['/oxide/data/*.json']);
  assert.ok(sb.tree.exists('/oxide/data/Kits/data.json'), 'удалён /oxide/data/Kits/data.json, которого маска не выбирала');
  const item = expansion.skipped.find((entry) => entry.path === BACKSLASH);
  assert.ok(item, 'имя с «\\» должно попасть в skipped');
  assert.match(item.reason, /«\\»/);
  assert.ok(expansion.paths.includes('/oxide/data/plain.json'), 'обычные файлы должны попасть в список');
  // Пока среди выбранного есть имя, которое нельзя передать агенту точно,
  // вайп не идёт целиком (R-3): обычные файлы тоже целы, имя названо.
  assert.ok(sb.tree.exists('/oxide/data/plain.json'), 'вайп с пропущенным именем всё-таки удалял');
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes(BACKSLASH)), 'в причине отказа нет этого имени');
});

test('L32-4: цель — весь /oxide/data, исключён Kits/data.json — исключённый цел', async (t) => {
  const { sb, expansion, run } = await wipe(t, ['/oxide/data'], ['/oxide/data/Kits/data.json']);
  assert.ok(sb.tree.exists('/oxide/data/Kits/data.json'), 'удалён исключённый файл');
  assert.ok(expansion.paths.includes('/oxide/data/Kits/other.json'), 'соседний файл должен попасть в список');
  assert.equal(expansion.paths.includes('/oxide/data/Kits/data.json'), false, 'исключённый файл попал в список');
  // Имя с «\» в той же папке — вайп не идёт целиком (R-3), соседний файл цел.
  assert.ok(sb.tree.exists('/oxide/data/Kits/other.json'), 'вайп с пропущенным именем всё-таки удалял');
  assert.equal(run.ok, false);
});

test('L32-4: имя с пробелом в конце — в skipped с причиной, вайп не идёт целиком', async (t) => {
  const { sb, expansion, run } = await wipe(t, ['/server/*/player.blueprints.*']);
  const item = expansion.skipped.find((entry) => entry.path === TRAILING);
  assert.ok(item, 'имя с пробелом в конце должно попасть в skipped');
  assert.match(item.reason, /пробел/);
  assert.ok(expansion.paths.includes('/server/rust/player.blueprints.6.db'), 'соседний файл должен попасть в список');
  // Вайп не идёт целиком (R-3): соседний файл цел, имя с пробелом названо.
  assert.ok(sb.tree.exists('/server/rust/player.blueprints.6.db'), 'вайп с пропущенным именем всё-таки удалял');
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes(TRAILING)), 'в причине отказа нет этого имени');
  assert.equal(
    run.skipped.some((entry) => entry.path.trimEnd() === TRAILING.trimEnd() && entry.reason === 'уже отсутствует'),
    false,
    'файл с пробелом записан «уже отсутствует», хотя он на месте',
  );
});

test('Имя с пробелом в начале панель не трогает — файл удаляется как обычный', async (t) => {
  // Маска берёт только « lead.json»: «Kits\data.json» из той же папки
  // отменил бы вайп целиком (R-3), а здесь проверяется само имя.
  const { sb, run } = await wipe(t, ['/oxide/data/*lead.json']);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.equal(sb.tree.exists('/oxide/data/ lead.json'), false, 'файл « lead.json» не удалён');
  assert.ok(sb.tree.exists('/oxide/data/lead.json') === false);
});

test('Пикер: имя отдаётся как есть, у проблемного имени есть причина nameProblem', async (t) => {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const res = await sb.call('owner', 'GET', '/servers/srv1/files', { query: { path: '/server/rust' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const names = res.body.data.entries.map((entry) => entry.name);
  t.note(`имена: ${JSON.stringify(names)}`);
  assert.ok(names.includes('player.blueprints.5.db '), 'пробел в конце имени обрезан');
  const odd = res.body.data.entries.find((entry) => entry.name === 'player.blueprints.5.db ');
  assert.match(String(odd.nameProblem), /пробел/);
  assert.equal(res.body.data.entries.find((entry) => entry.name === 'player.blueprints.6.db').nameProblem, null);
});
