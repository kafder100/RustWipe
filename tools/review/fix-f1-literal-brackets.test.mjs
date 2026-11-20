/**
 * F1, находка H17a (часть backend, договорённость К1): имя файла или каталога
 * со «*» или «?» нельзя было выбрать буквально. Любые «*» и «?» в пути —
 * маска, поэтому отмеченный в пикере файл «*.json» удалял весь каталог,
 * а каталог «**» — всё вокруг. Экранировать было нечем: «\» панель
 * превращает в «/», а «[*]» ни с чем не совпадал.
 *
 * Правильное поведение (К1): «[x]» — квадратные скобки ровно с одним символом
 * внутри — это сам символ буквально: «[*]», «[?]», «[[]». Скобки без такой
 * пары («[backup]») — обычные символы, как раньше. Сегмент без настоящих масок —
 * точное имя. Так понимают пути и цели, и исключения, и предпросмотр.
 * Пикер (F5) при добавлении сам заменит «*» на «[*]», «?» на «[?]», «[» на «[[]».
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-literal-brackets.test.mjs
 */

import assert from 'node:assert/strict';

import * as glob from '../../rust-autowipe/backend/lib/glob.js';
import { createSandbox, test } from './sandbox.mjs';

const { canMatchDescendant, hasGlob, isExcluded, matchPath, segmentMatcher } = glob;

const CLANS = '/oxide/data/Clans';
const BACKUPS = '/oxide/data/Backups';

function tree() {
  return {
    files: {
      '/RustDedicated': 1024,
      [`${CLANS}/*.json`]: '{"star":true}',
      [`${CLANS}/A?.json`]: '{"question":true}',
      [`${CLANS}/AB.json`]: '{}',
      [`${CLANS}/Alpha.json`]: '{}',
      [`${CLANS}/[x].json`]: '{}',
      [`${BACKUPS}/**/old.json`]: '{}',
      [`${BACKUPS}/keep.json`]: '{"keep":true}',
      [`${BACKUPS}/2026/old.json`]: '{}',
      '/oxide/[backup]/notes.txt': 'старый каталог со скобками в имени',
      '/oxide/b/notes.txt': 'другой каталог',
    },
  };
}

async function wipeWith(t, targets, excludes = []) {
  const sb = createSandbox({ tree: tree() });
  await sb.load();
  const res = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Буквальные имена', targets, excludes, schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  assert.equal(res.status, 200, `профиль не сохранён: ${JSON.stringify(res.body)}`);
  const profile = await sb.ctx.collection('profiles').findOne({ id: res.body.data.id });
  const preview = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  await sb.idle();
  const removed = sb.tree.diff(before).removed;
  t.note(`цели ${JSON.stringify(targets)}, исключения ${JSON.stringify(excludes)}`);
  t.note(`предпросмотр: ${preview.body.data.paths.join(', ') || 'пусто'}; delete к агенту: ${sb.tunnel.paths('delete').join(', ') || 'нет'}; ok=${run.ok}`);
  return { sb, removed, shown: preview.body.data.paths, run };
}

test('К1: «[x]» — символ буквально, скобки без пары — обычные символы', () => {
  assert.equal(segmentMatcher('[*].json').test('*.json'), true);
  assert.equal(segmentMatcher('[*].json').test('a.json'), false, '«[*]» — не маска');
  assert.equal(segmentMatcher('A[?].json').test('A?.json'), true);
  assert.equal(segmentMatcher('A[?].json').test('AB.json'), false, '«[?]» — не маска');
  assert.equal(segmentMatcher('[[]x].json').test('[x].json'), true, '«[[]» — открывающая скобка');
  assert.equal(segmentMatcher('[*][*]').test('**'), true);
  assert.equal(segmentMatcher('[*][*]').test('ab'), false);
  assert.equal(segmentMatcher('[backup]').test('[backup]'), true, 'старые имена со скобками не меняют смысла');
  assert.equal(segmentMatcher('[ab]').test('a'), false);
  assert.equal(segmentMatcher('a[').test('a['), true, '«[» без пары — обычный символ');
  assert.equal(segmentMatcher(']').test(']'), true, '«]» вне пары — обычный символ');
  assert.equal(segmentMatcher('[*]*').test('*tail'), true, 'буквальная «*» и настоящая маска вместе');
  assert.equal(segmentMatcher('[*]*').test('tail'), false);

  assert.equal(hasGlob('/oxide/data/[*].json'), false);
  assert.equal(hasGlob('/oxide/data/[*]/*.json'), true);
  assert.equal(hasGlob('/oxide/[backup]'), false);
  assert.equal(typeof glob.literalPath, 'function', 'нет функции literalPath: точный путь из «[x]» не получить');
  const { literalPath } = glob;
  assert.equal(literalPath('/oxide/data/Clans/[*].json'), '/oxide/data/Clans/*.json');
  assert.equal(literalPath('/oxide/data/Backups/[*][*]'), '/oxide/data/Backups/**');
  assert.equal(literalPath('/oxide/[backup]'), '/oxide/[backup]');
  assert.equal(literalPath('/oxide/*'), null);

  assert.equal(matchPath('/oxide/data/[*].json', '/oxide/data/*.json'), true);
  assert.equal(matchPath('/oxide/data/[*].json', '/oxide/data/a.json'), false);
  assert.equal(matchPath('/oxide/[*][*]/x', '/oxide/a/b/x'), false, '«[*][*]» — не «**»');
  assert.equal(isExcluded(['/oxide/data/[*].json'], '/oxide/data/*.json'), true);
  assert.equal(isExcluded(['/oxide/data/[*].json'], '/oxide/data/a.json'), false);
  assert.equal(canMatchDescendant('/oxide/[*][*]/x', '/oxide/**'), true);
  assert.equal(canMatchDescendant('/oxide/[*][*]/x', '/oxide/a'), false);
});

test('К1: цель «[*].json» удаляет только файл «*.json»', async (t) => {
  const { removed, shown } = await wipeWith(t, [`${CLANS}/[*].json`]);
  assert.deepEqual(shown, [`${CLANS}/*.json`]);
  assert.deepEqual(removed, [`${CLANS}/*.json`]);
});

test('К1: цель «A[?].json» удаляет только файл «A?.json»', async (t) => {
  const { removed } = await wipeWith(t, [`${CLANS}/A[?].json`]);
  assert.deepEqual(removed, [`${CLANS}/A?.json`]);
});

test('К1: цель «[*][*]» удаляет только каталог «**», а не весь Backups', async (t) => {
  const { removed, sb } = await wipeWith(t, [`${BACKUPS}/[*][*]`]);
  assert.deepEqual(removed, [`${BACKUPS}/**/`, `${BACKUPS}/**/old.json`]);
  assert.ok(sb.tree.exists(`${BACKUPS}/keep.json`));
});

test('К1: исключение «[*].json» защищает только файл «*.json»', async (t) => {
  const { removed, sb } = await wipeWith(t, [`${CLANS}/*`], [`${CLANS}/[*].json`]);
  assert.ok(sb.tree.exists(`${CLANS}/*.json`), 'исключённый «*.json» удалён');
  assert.deepEqual(removed, [`${CLANS}/A?.json`, `${CLANS}/AB.json`, `${CLANS}/Alpha.json`, `${CLANS}/[x].json`]);
});

test('К1: старый путь «/oxide/[backup]» по-прежнему значит каталог «[backup]»', async (t) => {
  const { removed } = await wipeWith(t, ['/oxide/[backup]']);
  assert.deepEqual(removed, ['/oxide/[backup]/', '/oxide/[backup]/notes.txt']);
});
