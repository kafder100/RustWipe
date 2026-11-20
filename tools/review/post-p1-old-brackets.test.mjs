/**
 * P1, R-1 (регрессии R1-3 и R4-2 второго круга): после правки К1 любая пара
 * «[x]» значила символ x. Старые пути поменяли смысл: цель «Kits[1].json»
 * удаляла «Kits1.json», исключение «[K]Bob.json» перестало защищать файл,
 * а цель «/oxide/data/[.]» стирала всю папку /oxide/data.
 *
 * Правильное поведение: особый смысл только у трёх записей — «[*]»
 * (звёздочка), «[?]» (вопрос) и «[[]» (открывающая скобка). Так пикер пишет
 * имена, где есть «*», «?» или «[». Любые другие квадратные скобки — обычные
 * символы, как в 1.5.6: «Backup[1].json», «[backup]», «a[b]c» значат ровно
 * то, что написано.
 *
 * Профиль «из старой версии» кладётся в коллекцию напрямую (sb.addProfile),
 * без проверки при сохранении, — как профиль, сохранённый до обновления.
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/post-p1-old-brackets.test.mjs
 */

import assert from 'node:assert/strict';

import {
  hasGlob,
  isExcluded,
  literalName,
  literalPath,
  matchPath,
  segmentMatcher,
} from '../../rust-autowipe/backend/lib/glob.js';
import { createSandbox, test } from './sandbox.mjs';

/** Сегмент шаблона так, как его понимала 1.5.6: «*» и «?» — маски, остальное — как написано. */
function matcher156(segment) {
  let pattern = '';
  for (const char of String(segment)) {
    if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

/** Как пикер пишет выбранное имя (договорённость К1): «*» → «[*]», «?» → «[?]», «[» → «[[]». */
const pickerName = (name) => name.replace(/[*?[]/g, (char) => `[${char}]`);

const DATA = '/oxide/data';

function tree() {
  return {
    files: {
      '/RustDedicated': 1024,
      [`${DATA}/Kits[1].json`]: '{"old":true}',
      [`${DATA}/Kits1.json`]: '{}',
      [`${DATA}/[.]`]: 'файл с именем [.]',
      [`${DATA}/Economics.json`]: '{}',
      [`${DATA}/Backpacks/[K]Bob.json`]: '{"keep":true}',
      [`${DATA}/Backpacks/KBob.json`]: '{}',
      [`${DATA}/Backpacks/Alice.json`]: '{}',
      [`${DATA}/Clans/[1].json`]: '{}',
      [`${DATA}/Clans/1.json`]: '{}',
    },
  };
}

/** Вайп профиля, сохранённого до обновления: профиль кладётся в коллекцию как есть. */
async function wipeOld(t, targets, excludes = []) {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const profile = await sb.addProfile({ targets, excludes, options: { warnChat: false } });
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`delete к агенту: ${sb.tunnel.paths('delete').join(', ') || 'нет'}; удалено: ${removed.join(', ') || 'ничего'}; ok=${run.ok}`);
  return { sb, removed, run, profile };
}

test('R-1: скобки, кроме «[*]», «[?]», «[[]», значат то же, что в 1.5.6', () => {
  const patterns = ['Kits[1].json', '[K]Bob.json', '[1].json', '[.]', '[..]', '[backup]', 'a[b]c', '[]]', '[]', 'x]', 'a[', '[1]*.json', '*[a]', '?[.]', '[ab]'];
  const names = [
    'Kits[1].json', 'Kits1.json', '[K]Bob.json', 'KBob.json', '[1].json', '1.json', '[.]', '.', '[..]', '..',
    '[backup]', 'backup', 'a[b]c', 'abc', ']', '[]]', '[]', 'x]', 'a[', '[1]abc.json', '1abc.json', 'z[a]', 'za',
    'q[.]', 'q.', '[ab]', 'a',
  ];
  const differ = [];
  for (const pattern of patterns) {
    for (const name of names) {
      const now = segmentMatcher(pattern).test(name);
      const was = matcher156(pattern).test(name);
      if (now !== was) differ.push(`«${pattern}» и «${name}»: в 1.5.6 ${was}, сейчас ${now}`);
    }
  }
  assert.deepEqual(differ, [], 'смысл старых имён поменялся');

  assert.equal(hasGlob(`${DATA}/Kits[1].json`), false);
  assert.equal(literalName('[.]'), '[.]', '«[.]» — имя «[.]», а не «.»');
  assert.equal(literalPath(`${DATA}/[.]`), `${DATA}/[.]`);
  assert.equal(literalPath(`${DATA}/Clans/[1].json`), `${DATA}/Clans/[1].json`);
  assert.equal(matchPath(`${DATA}/Clans/[1].json`, `${DATA}/Clans/[1].json`), true);
  assert.equal(matchPath(`${DATA}/Clans/[1].json`, `${DATA}/Clans/1.json`), false);
  assert.equal(isExcluded([`${DATA}/Backpacks/[K]Bob.json`], `${DATA}/Backpacks/[K]Bob.json`), true);
  assert.equal(isExcluded([`${DATA}/Backpacks/[K]Bob.json`], `${DATA}/Backpacks/KBob.json`), false);
});

test('R-1: три записи пикера по-прежнему значат сам символ', () => {
  assert.equal(segmentMatcher('[*].json').test('*.json'), true);
  assert.equal(segmentMatcher('[*].json').test('a.json'), false, '«[*]» — не маска');
  assert.equal(segmentMatcher('A[?].json').test('A?.json'), true);
  assert.equal(segmentMatcher('A[?].json').test('AB.json'), false, '«[?]» — не маска');
  assert.equal(segmentMatcher('[[]K]Bob.json').test('[K]Bob.json'), true, '«[[]» — открывающая скобка');
  assert.equal(segmentMatcher('[[]K]Bob.json').test('KBob.json'), false);
  assert.equal(hasGlob(`${DATA}/[*].json`), false);
  assert.equal(literalPath(`${DATA}/Backups/[*][*]`), `${DATA}/Backups/**`);
});

test('R-1: имена из пикера выбираются точно, и только они', () => {
  const names = ['*.json', 'A?.json', 'AB.json', '**', 'ab', '[backup]', 'backup', '[*]', '*', '[1]', '1', 'Kits[1].json', 'Kits1.json', 'a]b', '[[]', '[', '[?]x', '?x', '[]', 'x.json'];
  const wrong = [];
  for (const name of names) {
    const written = pickerName(name);
    if (literalName(written) !== name) wrong.push(`«${name}» записано как «${written}», а читается как «${literalName(written)}»`);
    const matches = names.filter((other) => segmentMatcher(written).test(other));
    if (matches.length !== 1 || matches[0] !== name) wrong.push(`«${written}» (имя «${name}») совпадает с: ${matches.join(', ') || 'ничем'}`);
  }
  assert.deepEqual(wrong, []);
});

test('R-1: старая цель «Kits[1].json» удаляет «Kits[1].json», а не «Kits1.json»', async (t) => {
  const { sb, removed, run } = await wipeOld(t, [`${DATA}/Kits[1].json`]);
  assert.equal(run.ok, true, run.errors.join(' | '));
  assert.deepEqual(removed, [`${DATA}/Kits[1].json`]);
  assert.ok(sb.tree.exists(`${DATA}/Kits1.json`), 'удалён невыбранный Kits1.json');
});

test('R-1: старое исключение «[K]Bob.json» по-прежнему защищает файл', async (t) => {
  const { sb, removed } = await wipeOld(t, [`${DATA}/Backpacks/*`], [`${DATA}/Backpacks/[K]Bob.json`]);
  assert.ok(sb.tree.exists(`${DATA}/Backpacks/[K]Bob.json`), 'исключённый [K]Bob.json удалён');
  assert.deepEqual(removed, [`${DATA}/Backpacks/Alice.json`, `${DATA}/Backpacks/KBob.json`]);
});

test('R-1: старая цель «/oxide/data/[.]» удаляет только файл «[.]», а не всю папку', async (t) => {
  const { sb, removed } = await wipeOld(t, [`${DATA}/[.]`]);
  assert.deepEqual(removed, [`${DATA}/[.]`]);
  assert.ok(sb.tree.exists(`${DATA}/Economics.json`), 'удалено содержимое /oxide/data');
});

test('R-1: старый профиль с «[.]» пересохраняется, как в 1.5.6', async (t) => {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const profile = await sb.addProfile({ targets: [`${DATA}/[.]`], options: { warnChat: false } });
  const res = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${profile.id}`, {
    body: { name: 'Переименован', expectedUpdatedAt: profile.updatedAt },
  });
  t.note(`PUT: ${res.status} ${res.body?.error ?? ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const saved = await sb.ctx.collection('profiles').findOne({ id: profile.id });
  assert.deepEqual(saved.targets, [`${DATA}/[.]`]);
});

test('R-1: «[.][.]» в новом пути — обычное имя папки, а не «..»; настоящий «..» — по-прежнему ошибка', async (t) => {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const post = (excludes) =>
    sb.call('owner', 'POST', '/servers/srv1/profiles', {
      body: { name: 'Точки в скобках', targets: [`${DATA}/*`], excludes, schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
    });
  const named = await post([`${DATA}/[.][.]/x`]);
  t.note(`«[.][.]»: ${named.status} ${named.body?.error ?? ''}`);
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.deepEqual(named.body.data.excludes, [`${DATA}/[.][.]/x`]);
  const up = await post([`${DATA}/../x`]);
  t.note(`«..»: ${up.status} ${up.body?.error ?? ''}`);
  assert.equal(up.status, 400);
  assert.match(up.body.error, /«\.\.»/);
});

test('R-1: путь «[1].json», набранный вручную, — предпросмотр и вайп берут именно «[1].json»', async (t) => {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: {
      name: 'Скобки вручную',
      targets: [`${DATA}/Clans/[1].json`],
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
      options: { warnChat: false },
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const profile = await sb.ctx.collection('profiles').findOne({ id: res.body.data.id });
  const preview = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  t.note(`предпросмотр: ${preview.body.data.paths.join(', ') || 'пусто'}`);
  assert.deepEqual(preview.body.data.paths, [`${DATA}/Clans/[1].json`]);
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`удалено: ${removed.join(', ') || 'ничего'}; ok=${run.ok}`);
  assert.deepEqual(removed, [`${DATA}/Clans/[1].json`]);
  assert.ok(sb.tree.exists(`${DATA}/Clans/1.json`), 'удалён невыбранный 1.json');
});
