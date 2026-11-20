/**
 * F1, находки L32-3 и L31-16 (часть backend): проверка профиля молча
 * выбрасывала неверное. Исключения после 40-го, исключения с «..», длиннее
 * 400 символов и «/» пропадали без ошибки — и вайп удалял исключённый файл.
 * Цели после 40-й пропадали — и нужное не удалялось. Команды после 10-й
 * пропадали, длинные обрезались до 200 символов. «/», добавленный пикером
 * в корне, тихо выбрасывался, а ответ говорил «Добавьте хотя бы один путь».
 *
 * Правильное поведение (ответ владельца №3 «строго выбранные файлы»):
 * сохранение отвечает 400 и называет элемент и предел. Пустые строки и
 * повторы убираются без ошибки — от них ничего не зависит.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/fix-f1-profile-lists.test.mjs
 */

import assert from 'node:assert/strict';

import { createSandbox, test } from './sandbox.mjs';

const SCHEDULE = { kind: 'weekly', weekday: 4, time: '05:00' };

async function sandbox() {
  const sb = createSandbox();
  await sb.load();
  return sb;
}

function post(sb, body) {
  return sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Проверка списков', targets: ['/oxide/data/*'], schedule: SCHEDULE, ...body },
  });
}

function expect400(t, res, pattern) {
  t.note(`${res.status}: ${res.body?.error}`);
  assert.equal(res.status, 400, `ожидалась ошибка, а ответ ${res.status}: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error, pattern);
}

test('L32-3: 41 исключение — ошибка с пределом, а не молча 40', async (t) => {
  const sb = await sandbox();
  const excludes = Array.from({ length: 40 }, (_, index) => `/oxide/data/Keep${index}.json`);
  excludes.push('/oxide/data/Economics.json');
  expect400(t, await post(sb, { excludes }), /Исключение: не больше 40 путей, а их 41/);
  assert.equal(sb.profiles().length, 0, 'профиль сохранён без 41-го исключения');
});

test('L32-3: исключение с «..», длиннее 400 символов и «/» — ошибка с номером элемента', async (t) => {
  const sb = await sandbox();
  expect400(t, await post(sb, { excludes: ['/oxide/data/Kits.json', '/oxide/../data/Economics.json'] }), /Исключение №2 .*«\.\.»/);
  expect400(t, await post(sb, { excludes: [`/oxide/data/${'x'.repeat(400)}.json`] }), /Исключение №1: путь длиннее 400 символов/);
  expect400(t, await post(sb, { excludes: ['/'] }), /Исключение №1: «\/» — это весь каталог сервера/);
  // «[.][.]» — обычное имя (R-1, как в 1.5.6), поэтому «..» здесь — в конце пути.
  expect400(t, await post(sb, { excludes: ['/oxide/data/Kits/..'] }), /Исключение №1 .*«\.\.»/);
  expect400(t, await post(sb, { excludes: '/oxide/data/Kits.json' }), /Исключение: нужен список путей/);
  expect400(t, await post(sb, { excludes: [42] }), /Исключение №1: путь должен быть строкой/);
  assert.equal(sb.profiles().length, 0);
});

test('L32-3: 41 цель — ошибка с пределом', async (t) => {
  const sb = await sandbox();
  const targets = Array.from({ length: 41 }, (_, index) => `/oxide/data/File${index}.json`);
  expect400(t, await post(sb, { targets }), /Цель: не больше 40 путей, а их 41/);
});

test('L31-16: «/» как единственная цель — понятная ошибка про «/», а не «добавьте путь»', async (t) => {
  const sb = await sandbox();
  const res = await post(sb, { targets: ['/'] });
  expect400(t, res, /Цель №1: «\/» — это весь каталог сервера/);
  assert.doesNotMatch(res.body.error, /Добавьте хотя бы один путь/);
  // «/» среди других путей тоже не пропадает молча.
  expect400(t, await post(sb, { targets: ['/server/*/proceduralmap.*.map', '/'] }), /Цель №2: «\/»/);
});

test('L32-3: 11 команд и команда длиннее 200 символов — ошибка, а не обрезка', async (t) => {
  const sb = await sandbox();
  const eleven = Array.from({ length: 11 }, (_, index) => `say ${index}`);
  expect400(t, await post(sb, { options: { commandsAfter: eleven } }), /Команд после запуска не больше 10, а их 11/);
  expect400(t, await post(sb, { options: { commandsAfter: ['oxide.reload *', `say ${'x'.repeat(200)}`] } }), /Команда №2 .*длиннее 200/);
  assert.equal(sb.profiles().length, 0);
});

test('В пределах — сохраняется как есть; пустые строки и повторы убираются без ошибки', async (t) => {
  const sb = await sandbox();
  const commands = Array.from({ length: 10 }, (_, index) => `say ${String(index).padEnd(196, 'x')}`);
  const res = await post(sb, {
    targets: ['/oxide/data/*', '', '  ', '/oxide/data/*', '/oxide//data/*'],
    excludes: Array.from({ length: 40 }, (_, index) => `/oxide/data/Keep${index}.json`),
    options: { commandsAfter: ['', ...commands, '   '] },
  });
  t.note(`${res.status}: ${res.body?.error ?? 'ok'}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const saved = sb.profiles()[0];
  assert.deepEqual(saved.targets, ['/oxide/data/*']);
  assert.equal(saved.excludes.length, 40);
  assert.deepEqual(saved.options.commandsAfter, commands, 'команды в пределах сохраняются целиком');
  // Выключить профиль по-прежнему можно (PUT только с enabled).
  const put = await sb.call('owner', 'PUT', `/servers/srv1/profiles/${saved.id}`, { body: { enabled: false } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
});
