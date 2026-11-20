/**
 * F1, находки H3a, H3b, H3c (и поломка S1 из L34-4): запрет «нельзя удалять
 * всё содержимое корня» сравнивал цель только со строками /* и /**. Маски
 * /**\/*, /?*, /*?, /*\/**, /**\/** значат то же самое, но сохранялись,
 * и вайп сносил установку: RustDedicated, RustDedicated_Data, стартовые
 * скрипты, steamapps, cfg. Перед удалением цель больше не проверялась.
 *
 * Правильное поведение (правило самого плагина, store.js: «Нельзя удалять всё
 * содержимое корня каталога сервера»): любая цель без единой буквы — только
 * «*», «?» и «**» — отклоняется при сохранении. И ещё раз перед удалением:
 * профиль, сохранённый старой версией, после обновления установку не сносит.
 *
 * Готовые тесты нашедших — h03a, h03b, h03c.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-root-masks.test.mjs
 */

import assert from 'node:assert/strict';

import * as glob from '../../rust-autowipe/backend/lib/glob.js';
import { createSandbox, rustServerTree, test } from './sandbox.mjs';

const FORBIDDEN = ['/*', '/**', '/**/*', '/?*', '/*?', '/*/**', '/**/**', '/*/*', '/?', '/??*', '/*/?', '/***'];
const ALLOWED = ['/server/*', '/*.sh', '/[*]', '/*/cfg', '/R*', '/**/cfg', '/oxide/**', '/server/*/proceduralmap.*.sav'];

const INSTALL = [
  '/RustDedicated',
  '/RustDedicated_Data/Managed/Assembly-CSharp.dll',
  '/RustDedicated_Data/globalgamemanagers',
  '/start.sh',
  '/runds.sh',
  '/steamapps/appmanifest_258550.acf',
  '/server/rust/cfg/server.cfg',
];

function treeWithoutLinks() {
  const spec = rustServerTree();
  for (const [key, value] of Object.entries(spec.files)) {
    if (value && typeof value === 'object' && ('link' in value || 'junction' in value)) delete spec.files[key];
  }
  return spec;
}

function postProfile(sb, targets, excludes = []) {
  return sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: `Цель ${targets.join(' ')}`, targets, excludes, schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
}

test('isRootMask: цель без единой буквы — на весь корень', () => {
  assert.equal(typeof glob.isRootMask, 'function', 'нет общей проверки «цель на весь корень»');
  for (const target of FORBIDDEN) assert.equal(glob.isRootMask(target), true, target);
  for (const target of ALLOWED) assert.equal(glob.isRootMask(target), false, target);
});

test('L34-4 (S1): сохранение отклоняет все цели на весь корень и пропускает обычные', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const statuses = {};
  for (const target of [...FORBIDDEN, ...ALLOWED]) {
    const res = await postProfile(sb, [target]);
    statuses[target] = res.status;
    if (FORBIDDEN.includes(target)) assert.match(res.body.error, /корня/, `${target}: ${res.body.error}`);
  }
  t.note(JSON.stringify(statuses));
  assert.deepEqual(FORBIDDEN.filter((target) => statuses[target] !== 400), [], 'приняты цели на весь корень');
  assert.deepEqual(ALLOWED.filter((target) => statuses[target] !== 200), [], 'отклонены обычные цели');
  // Исключение без букв — не опасно (ничего не удалится), его не запрещаем.
  assert.equal((await postProfile(sb, ['/server/*'], ['/**/*'])).status, 200);
});

test('Старый профиль с /*/* (сохранён до обновления): вайп ничего не удаляет и называет причину', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/server/*/proceduralmap.*.map', '/*/*'] });
  const before = sb.tree.snapshot();
  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`ok=${run.ok}; ошибки: ${run.errors.join(' | ')}; list: ${sb.tunnel.paths('list').length}; delete: ${sb.tunnel.paths('delete').length}`);
  assert.deepEqual(sb.tree.diff(before).removed, [], 'вайп по профилю с целью на весь корень что-то удалил');
  assert.deepEqual(INSTALL.filter((path) => !sb.tree.exists(path)), []);
  assert.equal(sb.tunnel.paths('list').length, 0, 'до проверки цели не нужно ничего читать');
  assert.equal(run.ok, false);
  assert.ok(run.errors.some((error) => error.includes('/*/*') && error.includes('корня')), 'в истории нет понятной причины');
  assert.equal(sb.status(), 'running', 'сервер снова работает');
});

test('Старый профиль с /**/*: предпросмотр не обещает снести корень, а отвечает причиной', async (t) => {
  const sb = createSandbox({ tree: treeWithoutLinks() });
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/**/*'] });
  const res = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  t.note(`предпросмотр: ${res.status} ${JSON.stringify(res.body)}`);
  assert.notEqual(res.status, 200);
  assert.match(res.body.error, /корня/);
  // И сохранить его, не исправив цель, тоже нельзя.
  const put = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${profile.id}`, { body: { name: 'Переименован' } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
});
