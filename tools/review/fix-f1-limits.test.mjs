/**
 * F1, находки H2a, H2b, H2d и L34-5: пределы раскрытия путей.
 *   H2a — после 250 запросов list каталог считался пустым и удалялся целиком
 *         вместе с исключённым файлом;
 *   H2b — на глубине 8 обход исключений отдавал каталог целиком, без отметки;
 *   H2d — «**» молча не заходил глубже 8 уровней: ни отметки, ни предупреждения;
 *   L34-5 — ни один тест не доходил до пределов 500/250/8, до 50 ошибок
 *         удаления и до «нет файла» при удалении.
 *
 * Правильное поведение (ответ владельца №3: при сомнении — стоп до удаления,
 * в истории причина; договорённость К2): при любом пределе truncated: true
 * и limitHit — какой предел и где; непрочитанный каталог не считается пустым;
 * каталог, где не проверено исключённое, на удаление не отдаётся. Сам вайп
 * при truncated остановит F2b (К3); здесь проверяется, что раскрытие не
 * отдаёт лишнего и честно сообщает о пределе.
 *
 * Готовые тесты нашедших — h02a, h02b, h02d (на настоящих пределах).
 * Здесь — маленькие пределы через параметр limits и сами значения пределов.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-limits.test.mjs
 */

import assert from 'node:assert/strict';

import { DEFAULT_LIMITS } from '../../rust-autowipe/backend/lib/glob-walk.js';
import { createSandbox, test } from './sandbox.mjs';

function oxideTree() {
  return {
    files: {
      '/RustDedicated': 1024,
      '/oxide/data/A/keep.json': '{"keep":true}',
      '/oxide/data/A/a.json': '{}',
      '/oxide/data/B/keep.json': '{"keep":true}',
      '/oxide/data/B/b.json': '{}',
      '/oxide/data/C/keep.json': '{"keep":true}',
      '/oxide/data/C/c.json': '{}',
      '/oxide/data/top.json': '{}',
      '/oxide/data/Deep/1/2/3/x.json': '{}',
    },
  };
}

async function expand(t, targets, excludes, limits) {
  const sb = createSandbox({ tree: oxideTree() });
  await sb.load();
  const { expandTargets } = await sb.lib('glob-walk');
  const server = { nodeId: sb.panel.server('srv1').nodeId, uuid: sb.tree.uuid };
  const result = await sb.run(expandTargets(sb.ctx, server, targets, excludes, limits));
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}, пределы ${JSON.stringify(limits)}`);
  t.note(`пути: ${result.paths.join(', ') || 'нет'}; truncated=${result.truncated}; limitHit=${JSON.stringify(result.limitHit)}; list: ${sb.tunnel.paths('list').join(', ')}`);
  return { sb, result };
}

test('L34-5: пределы по умолчанию — 500 путей, 250 запросов list, глубина 8', () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, { maxMatches: 500, maxDepth: 8, maxListCalls: 250 });
});

test('без пределов: truncated=false, limitHit=null', async (t) => {
  const { result } = await expand(t, ['/oxide/data/*'], ['/oxide/data/*/keep.json'], {});
  assert.equal(result.truncated, false);
  assert.equal(result.limitHit, null);
  assert.ok(result.paths.includes('/oxide/data/A/a.json'));
});

test('H2a: кончились запросы list — непрочитанный каталог не удаляется целиком', async (t) => {
  // 1 запрос на /oxide/data, ещё 2 — на A и B; каталоги C и Deep прочитать уже нечем.
  const { result } = await expand(t, ['/oxide/data/*'], ['/oxide/data/*/keep.json'], { maxListCalls: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.limitHit?.kind, 'listings');
  assert.match(result.limitHit.detail, /3 чтений папок/);
  const covers = (target) => result.paths.filter((path) => target === path || target.startsWith(`${path}/`));
  assert.deepEqual(covers('/oxide/data/C/keep.json'), [], 'каталог C с исключённым keep.json отдан на удаление, хотя не прочитан');
  assert.deepEqual(covers('/oxide/data/A/keep.json'), []);
  assert.ok(result.paths.includes('/oxide/data/A/a.json'), 'прочитанное отдаётся как обычно');
});

test('L34-5: кончились запросы list у маски — каталог не считается пустым, truncated', async (t) => {
  const { result } = await expand(t, ['/oxide/data/*/*.json'], [], { maxListCalls: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.limitHit?.kind, 'listings');
  assert.ok(result.paths.every((path) => path.startsWith('/oxide/data/A/')), `лишние пути: ${result.paths.join(', ')}`);
});

test('L34-5: больше maxMatches путей — truncated, limitHit «matches», путей не больше предела', async (t) => {
  const { result } = await expand(t, ['/oxide/data/*/*.json'], [], { maxMatches: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.limitHit?.kind, 'matches');
  assert.ok(result.paths.length <= 2, `путей ${result.paths.length}`);
});

test('H2d: «**» упёрся в глубину — truncated и limitHit «depth», а не молчание', async (t) => {
  const { result } = await expand(t, ['/oxide/data/**/*.json'], [], { maxDepth: 4 });
  assert.equal(result.truncated, true);
  assert.equal(result.limitHit?.kind, 'depth');
  assert.match(result.limitHit.detail, /глубже 4 уровней/);
  assert.equal(result.paths.includes('/oxide/data/Deep/1/2/3/x.json'), false);
});

test('H2d: «**» дошёл до предела глубины, но глубже каталогов нет — отметки нет', async (t) => {
  const { result } = await expand(t, ['/oxide/data/**/*.json'], [], { maxDepth: 6 });
  assert.equal(result.truncated, false, JSON.stringify(result.limitHit));
  assert.ok(result.paths.includes('/oxide/data/Deep/1/2/3/x.json'));
});

test('H2b: обход исключений упёрся в глубину — каталог не отдаётся целиком, limitHit «depth»', async (t) => {
  const { result } = await expand(t, ['/oxide/data/*'], ['/oxide/data/Deep/1/2/3/x.json'], { maxDepth: 2 });
  assert.equal(result.truncated, true);
  assert.equal(result.limitHit?.kind, 'depth');
  const covers = result.paths.filter((path) => '/oxide/data/Deep/1/2/3/x.json'.startsWith(`${path}/`));
  assert.deepEqual(covers, [], 'каталог с исключённым файлом отдан на удаление целиком');
  assert.ok(result.paths.includes('/oxide/data/top.json'));
});

test('H2a на вайпе: исключённые файлы целы, в истории есть отметка о пределе', async (t) => {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= 260; index += 1) {
    const name = `Plugin${String(index).padStart(3, '0')}`;
    files[`/oxide/data/${name}/keep.json`] = '{"keep":true}';
    files[`/oxide/data/${name}/data.json`] = '{}';
  }
  const sb = createSandbox({ tree: { files } });
  await sb.load();
  const before = sb.tree.snapshot();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], excludes: ['/oxide/data/*/keep.json'] });
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`list: ${sb.tunnel.paths('list').length}; удалено: ${removed.length}; ok=${run.ok}; предупреждения: ${run.warnings.join(' | ')}; ошибки: ${run.errors.join(' | ')}`);
  assert.ok(sb.tunnel.paths('list').length <= 250, 'запросов list больше предела');
  assert.deepEqual(removed.filter((path) => path.endsWith('/keep.json')), []);
  assert.ok(run.warnings.length > 0 || run.ok === false, 'предел кончился, а в истории — ни предупреждения, ни ошибки');
});

test('L34-5: 60 ошибок удаления — вайп останавливается после 50 и пишет об этом', async (t) => {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= 60; index += 1) files[`/oxide/data/f${String(index).padStart(2, '0')}.json`] = '{}';
  const sb = createSandbox({ tree: { files } });
  await sb.load();
  sb.tunnel.fail({ op: 'delete', error: 'Permission denied: Access denied' });
  const profile = await sb.addProfile({ targets: ['/oxide/data/*.json'] });
  const run = await sb.wipe(profile);
  await sb.idle();
  const deletes = sb.tunnel.paths('delete').length;
  t.note(`delete: ${deletes}; ok=${run.ok}; предупреждения: ${run.warnings.join(' | ')}`);
  assert.ok(deletes <= 50, `после 50 ошибок вайп не остановился: ${deletes} запросов delete`);
  assert.equal(run.ok, false);
  assert.ok([...run.warnings, ...run.errors].some((text) => /50/.test(text)), 'нет записи об остановке после 50 ошибок');
  assert.equal(sb.status(), 'running', 'сервер снова работает');
});
