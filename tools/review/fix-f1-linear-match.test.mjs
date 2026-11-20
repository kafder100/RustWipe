/**
 * F1, находка L32-1: маска с множеством «*» в одном сегменте вешала весь
 * процесс панели. segmentMatcher строил RegExp вида ^[^/]*[^/]*…x$, и
 * проверка имени уходила в перебор вариантов (время росло примерно ×4 на
 * каждую «*»). Плагин работает внутри панели, поэтому вставали все роуты,
 * тики и вайпы всех серверов.
 *
 * Правильное поведение: маска любой длины сравнивается с именем без перебора —
 * время растёт не быстрее «длина маски × длина имени», а не в разы на каждую «*».
 *
 * Зависший RegExp не прервать таймером в том же процессе, поэтому проверки
 * идут в дочернем процессе с жёстким пределом настоящего времени. Не уложился —
 * процесс убит, тест упал. Каждая проверка внутри — не дольше CASE_LIMIT_MS.
 *
 * Всё на подменах: в дочернем процессе — простая подмена туннеля и песочница
 * (дерево в памяти), настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-linear-match.test.mjs
 */

import assert from 'node:assert/strict';

import { runNode, test } from './sandbox.mjs';

const GLOB_URL = new URL('../../rust-autowipe/backend/lib/glob.js', import.meta.url).href;
const WALK_URL = new URL('../../rust-autowipe/backend/lib/glob-walk.js', import.meta.url).href;
const SANDBOX_URL = new URL('./sandbox.mjs', import.meta.url).href;

/** Предел на одну проверку (мс настоящего времени). Старый RegExp не укладывался и в 6 с. */
const CASE_LIMIT_MS = 250;
/** Предел на весь дочерний процесс вместе с запуском node. */
const CHILD_LIMIT_MS = 8000;
/** Сторож самого теста — с запасом над пределом дочернего процесса. */
const TEST_LIMIT = { timeoutMs: 20000 };

/**
 * Запустить проверки в дочернем процессе. Каждая проверка печатает строку
 * JSON { label, ms, value } сразу после себя — если процесс убит, видно, где он завис.
 */
async function runChecks(body) {
  const code = `
const NAME = 'a'.repeat(255);
async function check(label, fn) {
  const started = performance.now();
  const value = await fn();
  process.stdout.write(JSON.stringify({ label, ms: Math.round((performance.now() - started) * 100) / 100, value }) + '\\n');
}
${body}
`;
  const result = await runNode({ code, timeoutMs: CHILD_LIMIT_MS });
  const lines = result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  return { result, lines };
}

function assertFast(t, { result, lines }, expected) {
  for (const line of lines) t.note(`${line.label}: ${line.ms} мс → ${JSON.stringify(line.value)}`);
  assert.equal(
    result.timedOut,
    false,
    `проверки не уложились в ${CHILD_LIMIT_MS} мс: процесс убит после «${lines.at(-1)?.label ?? 'начала'}» — зависла следующая`,
  );
  assert.equal(result.code, 0, `дочерний процесс упал: ${result.stderr.slice(0, 600)}`);
  assert.deepEqual(
    lines.map((line) => line.label),
    Object.keys(expected),
    'выполнены не все проверки',
  );
  for (const line of lines) {
    assert.ok(line.ms < CASE_LIMIT_MS, `«${line.label}» шла ${line.ms} мс — дольше ${CASE_LIMIT_MS} мс`);
    assert.deepEqual(line.value, expected[line.label], `«${line.label}»: неверный результат`);
  }
}

test('L32-1: длинные маски из «*» во всех функциях выбора файлов — быстро и с верным ответом', async (t) => {
  const expected = {
    'segmentMatcher: 24 «*» и x, имя из 65 букв': false,
    'segmentMatcher: «*a» × 200 и x, имя из 255 букв': false,
    'segmentMatcher: «*a» × 100 и «*», имя из 255 букв': true,
    'segmentMatcher: «*?» × 200, имя из 255 букв': true,
    'segmentMatcher: маска 4001 символ, имя из 255 букв': false,
    'segmentMatcher: «*» и 398 букв и b, имя из 255 букв': false,
    'matchPath: маска сегмента из 381 символа': false,
    'isExcluded: исключение с такой же маской': false,
    'canMatchDescendant: такая маска в середине шаблона': false,
    'expandTargets: цель и исключение с такими масками, 60 длинных имён': [],
  };
  const checks = await runChecks(`
const { segmentMatcher, matchPath, isExcluded, canMatchDescendant } = await import(${JSON.stringify(GLOB_URL)});
const { expandTargets } = await import(${JSON.stringify(WALK_URL)});
const LONG = '*a'.repeat(190) + 'x';
await check('segmentMatcher: 24 «*» и x, имя из 65 букв', () => segmentMatcher('*'.repeat(24) + 'x').test('a'.repeat(65)));
await check('segmentMatcher: «*a» × 200 и x, имя из 255 букв', () => segmentMatcher('*a'.repeat(200) + 'x').test(NAME));
await check('segmentMatcher: «*a» × 100 и «*», имя из 255 букв', () => segmentMatcher('*a'.repeat(100) + '*').test(NAME));
await check('segmentMatcher: «*?» × 200, имя из 255 букв', () => segmentMatcher('*?'.repeat(200)).test(NAME));
await check('segmentMatcher: маска 4001 символ, имя из 255 букв', () => segmentMatcher('*a?b'.repeat(1000) + 'x').test(NAME));
await check('segmentMatcher: «*» и 398 букв и b, имя из 255 букв', () => segmentMatcher('*' + 'a'.repeat(398) + 'b').test(NAME));
await check('matchPath: маска сегмента из 381 символа', () => matchPath('/oxide/data/' + LONG, '/oxide/data/' + NAME));
await check('isExcluded: исключение с такой же маской', () => isExcluded(['/oxide/data/' + LONG], '/oxide/data/' + NAME + '/keep.json'));
await check('canMatchDescendant: такая маска в середине шаблона', () => canMatchDescendant('/oxide/' + LONG + '/keep.json', '/oxide/' + NAME));
const entries = Array.from({ length: 60 }, (_, index) => ({ name: 'a'.repeat(200) + index, isDirectory: false, size: 1, mode: 420 }));
const ctx = {
  fileTunnel: {
    async queueRequest(_node, operation, _uuid, path) {
      if (operation !== 'list') return { success: false, error: 'операция не нужна тесту' };
      return path === '/oxide/data' ? { success: true, data: entries } : { success: true, data: [] };
    },
  },
};
await check('expandTargets: цель и исключение с такими масками, 60 длинных имён', async () =>
  (await expandTargets(ctx, { nodeId: 'n', uuid: 'u' }, ['/oxide/data/' + LONG], ['/oxide/data/' + '*b'.repeat(190) + 'x'])).paths,
);
`);
  assertFast(t, checks, expected);
}, TEST_LIMIT);

test('L32-1: профиль с маской из 24 «*» сохраняется, а предпросмотр и вайп не вешают панель', async (t) => {
  const expected = {
    'POST профиля с маской и исключением из 24 «*»': 200,
    'предпросмотр от субпользователя': { status: 200, paths: [] },
    'боевой вайп по профилю: ничего не удалено': 0,
  };
  const checks = await runChecks(`
const { createSandbox } = await import(${JSON.stringify(SANDBOX_URL)});
const sb = createSandbox({
  tree: { files: { '/RustDedicated': 1024, ['/oxide/data/' + 'a'.repeat(65)]: '{}', ['/oxide/data/' + 'b'.repeat(200)]: '{}' } },
});
await sb.load();
const mask = '/oxide/data/' + '*'.repeat(24) + 'x';
let id = null;
await check('POST профиля с маской и исключением из 24 «*»', async () => {
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Длинная маска', targets: [mask], excludes: ['/oxide/data/' + '*'.repeat(24) + 'y'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  id = res.body?.data?.id ?? null;
  return res.status;
});
await check('предпросмотр от субпользователя', async () => {
  const res = await sb.call('sub', 'POST', '/servers/srv1/profiles/' + id + '/preview');
  return { status: res.status, paths: res.body?.data?.paths ?? null };
});
await check('боевой вайп по профилю: ничего не удалено', async () => {
  const profile = await sb.ctx.collection('profiles').findOne({ id });
  const run = await sb.wipe(profile);
  return run.deletedCount;
});
sb.restore();
`);
  assertFast(t, checks, expected);
}, TEST_LIMIT);
