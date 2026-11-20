/**
 * Исполнитель F5, находка L31-1: исключение, набранное без Enter, молча
 * не сохранялось — поле пересоздавалось при любой перерисовке, а «Сохранить»
 * отправлял excludes: [] и писал «Профиль сохранён».
 *
 * Должно: набранный текст переживает перерисовку, «Сохранить» добавляет его
 * в исключения и говорит об этом; рядом с полем есть «Добавить» и выбор
 * исключений в файлах.
 *
 * Запуск: node tools/review/fix-f5-exclude-input.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const excludeField = (ui) => ui.input((node) => node.getAttribute('placeholder') === 'например /server/*/cfg');

async function newProfile(ui) {
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Полный вайп');
  ui.addTarget('/server/rust/*');
}

function excludeList(ui) {
  const field = ui.find(
    (node) => node.classList.contains('rw-field') && node.children[0]?.textContent === 'Исключения (не удалять)',
  );
  assert.ok(field, 'нет блока «Исключения»');
  return ui
    .findAll((node) => node.classList.contains('rw-path-text') && field.contains(node))
    .map((node) => node.textContent);
}

test('L31-1: текст в поле исключений переживает перерисовку и сохраняется без Enter', async () => {
  const ui = await setup({ profiles: [] });
  await newProfile(ui);
  ui.type(excludeField(ui), '/server/rust/cfg');
  // Любая перерисовка — здесь клик по галочке.
  const box = ui.input((node) => node.getAttribute('type') === 'checkbox');
  ui.check(box, false);
  assert.equal(excludeField(ui).value, '/server/rust/cfg', 'после перерисовки поле исключений опустело');

  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
  const post = ui.requests.find((request) => request.method === 'POST' && request.path.endsWith('/profiles'));
  assert.ok(post, `профиль не отправлен: ${ui.toast()}`);
  assert.deepEqual(post.body.excludes, ['/server/rust/cfg'], 'набранное исключение не ушло в запрос');
  assert.ok(/Исключение из поля добавлено/.test(ui.toast()), `тост не говорит о добавленном исключении: «${ui.toast()}»`);
});

test('L31-1: кнопка «Добавить» переносит текст в список и очищает поле; Enter работает как раньше', async () => {
  const ui = await setup({ profiles: [] });
  await newProfile(ui);
  ui.type(excludeField(ui), '/server/rust/cfg');
  const field = ui.find(
    (node) => node.classList.contains('rw-field') && node.children[0]?.textContent === 'Исключения (не удалять)',
  );
  ui.click(ui.button('Добавить', field), '«Добавить» у исключений');
  assert.deepEqual(excludeList(ui), ['/server/rust/cfg']);
  assert.equal(excludeField(ui).value, '', 'поле не очистилось');

  ui.type(excludeField(ui), '/oxide/data/keep.json');
  ui.fire(excludeField(ui), 'keydown', { key: 'Enter' });
  assert.deepEqual(excludeList(ui), ['/server/rust/cfg', '/oxide/data/keep.json']);
});

test('L31-1: у исключений есть выбор в файлах, выбранное попадает в исключения', async () => {
  const files = (path) => ({
    path,
    parent: null,
    breadcrumbs: path === '/' ? [] : [{ name: 'server', path: '/server' }],
    entries:
      path === '/'
        ? [{ name: 'server', path: '/server', isDirectory: true, size: 0 }]
        : [{ name: 'cfg', path: '/server/cfg', isDirectory: true, size: 0 }],
  });
  const ui = await setup({ profiles: [], files });
  await newProfile(ui);
  const field = ui.find(
    (node) => node.classList.contains('rw-field') && node.children[0]?.textContent === 'Исключения (не удалять)',
  );
  ui.click(ui.button('Выбрать в файлах…', field), '«Выбрать в файлах…» у исключений');
  await ui.settle();
  assert.ok(ui.text().includes('Выбор исключений'), 'пикер исключений не открылся');
  const list = ui.find((node) => node.classList.contains('rw-picker-list'));
  ui.click(ui.button('server', list), 'каталога server');
  await ui.settle();
  const row = ui.find((node) => node.classList.contains('rw-picker-row') && node.textContent.includes('cfg'));
  ui.check(row.children.find((node) => node.tagName === 'INPUT'), true);
  ui.click(ui.buttonLike(/^Добавить выбранные/), '«Добавить выбранные»');
  await ui.settle();
  assert.deepEqual(excludeList(ui), ['/server/cfg']);
});
