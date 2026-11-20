/**
 * Исполнитель F5, находка L31-17 (и «попутно» из разбора оболочки): любое
 * изменение в редакторе пересобирало окно — прокрутка и фокус сбрасывались;
 * исчезновение тоста через 4,5 с сворачивало раскрытые шаги истории.
 *
 * Должно: после перерисовки то же окно прокручено туда же, фокус в том же
 * поле, раскрытые шаги и списки путей остаются раскрытыми.
 *
 * Запуск: node tools/review/fix-f5-rerender.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const modalOf = (ui) => ui.find((node) => node.classList.contains('rw-modal'));
const overlayOf = (ui) => ui.overlays()[0];

test('L31-17: клик по галочке не сбрасывает прокрутку редактора', async () => {
  const ui = await setup({ profiles: [] });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  const first = modalOf(ui);
  first.scrollTop = 900;
  overlayOf(ui).scrollTop = 120;
  ui.check(ui.input((node) => node.getAttribute('type') === 'checkbox'), false);
  const second = modalOf(ui);
  assert.notEqual(first, second, 'проверка не имеет смысла: окно не пересоздано');
  assert.equal(second.scrollTop, 900, 'прокрутка окна сбросилась');
  assert.equal(overlayOf(ui).scrollTop, 120, 'прокрутка подложки сбросилась');
});

test('L31-17: тост погас — фокус остаётся в поле названия', async () => {
  const ui = await setup({ profiles: [] });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Вайп карты');
  ui.click(ui.button('Сохранить'), '«Сохранить»'); // тост «Добавьте хотя бы один путь…»
  const name = ui.field('Название');
  name.focus(); // админ дальше печатает в названии
  await ui.timers.advance(5000); // тост гаснет — перерисовка
  const active = ui.document.activeElement;
  assert.ok(active && active !== name, 'проверка не имеет смысла: поле не пересоздано');
  assert.equal(active.getAttribute('data-rw-key'), 'name', 'фокус ушёл из поля названия');
  assert.ok(ui.root.contains(active), 'фокус на узле, которого нет на странице');
  assert.equal(active.value, 'Вайп карты');
});

test('L31-17: окно сменилось — прокрутка не переносится в другое окно', async () => {
  const ui = await setup({ profiles: [] });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  modalOf(ui).scrollTop = 900;
  ui.click(ui.button('Закрыть'), '«Закрыть»');
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  assert.equal(modalOf(ui).scrollTop, 0, 'новое окно открылось не с начала');
});

test('L31-17: из редактора в пикер — прокрутка редактора не переезжает в пикер; новый каталог — с начала', async () => {
  const files = (path) => ({
    path,
    parent: null,
    breadcrumbs: path === '/' ? [] : [{ name: 'server', path: '/server' }],
    entries: path === '/' ? [{ name: 'server', path: '/server', isDirectory: true, size: 0 }] : [],
  });
  const ui = await setup({ profiles: [], files });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  modalOf(ui).scrollTop = 900;
  overlayOf(ui).scrollTop = 120;
  ui.click(ui.button('Выбрать в файлах…'), '«Выбрать в файлах…»');
  await ui.settle();
  assert.equal(modalOf(ui).scrollTop, 0, 'пикер открылся прокрученным, как редактор');
  assert.equal(overlayOf(ui).scrollTop, 0, 'подложка пикера прокручена, как у редактора');
  const list = () => ui.find((node) => node.classList.contains('rw-picker-list'));
  list().scrollTop = 300;
  ui.click(ui.button('server', list()), 'каталога server');
  await ui.settle();
  assert.equal(list().scrollTop, 0, 'новый каталог открылся не с начала списка');
});

test('раскрытые шаги истории не сворачиваются, когда гаснет тост', async () => {
  const run = {
    id: 'run_1',
    profileId: 'wipe_1',
    profileName: 'Еженедельный вайп',
    trigger: 'schedule',
    ok: true,
    startedAt: '2026-11-19T02:00:00.000Z',
    deleted: ['/server/rust/a.sav'],
    steps: [{ at: '2026-11-19T02:00:01.000Z', action: 'delete', ok: true, detail: 'удалено 1', data: { deleted: 1 } }],
  };
  const ui = await setup({ runs: [run] });
  const open = (node) => {
    node.setAttribute('open', '');
    ui.fire(node, 'toggle');
  };
  open(ui.find((node) => node.tagName === 'DETAILS' && node.classList.contains('rw-details')));
  open(ui.find((node) => node.tagName === 'DETAILS' && node.classList.contains('rw-step')));
  open(ui.find((node) => node.tagName === 'DETAILS' && node.classList.contains('rw-step-paths')));
  ui.click(ui.button('Тест предупреждения'), '«Тест предупреждения»');
  await ui.settle();
  await ui.timers.advance(5000);
  for (const cls of ['rw-details', 'rw-step', 'rw-step-paths']) {
    const node = ui.find((item) => item.tagName === 'DETAILS' && item.classList.contains(cls));
    assert.ok(node.hasAttribute('open'), `«${cls}» свернулся после перерисовки`);
  }
});
