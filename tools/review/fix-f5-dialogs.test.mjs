/**
 * Исполнитель F5, находка S9 (вид вкладки в оболочке Catalyst): у окон не было
 * role="dialog", Esc их не закрывал, фокус не переходил в окно и не
 * возвращался; путь вручную вводился системным окном prompt; тост не был
 * виден программам чтения с экрана.
 *
 * Должно: окна — role="dialog", aria-modal и подпись; фокус в окне (в окне
 * подтверждения — на «Отмена»); Esc закрывает как «Отмена»/«Закрыть», а
 * редактор с правками сначала спрашивает; после закрытия фокус на кнопке,
 * которая открыла окно; путь вручную — своим полем.
 *
 * Запуск: node tools/review/fix-f5-dialogs.test.mjs
 *
 * Правка исполнителя P4: «Отмена» в редакторе с правками теперь сначала
 * спрашивает «Закрыть без сохранения?» (L31-18) — в случае «пикер и
 * предпросмотр» тест отвечает на вопрос. Суть проверки не менялась.
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

const dialog = (ui) => ui.find((node) => node.getAttribute('role') === 'dialog');
const esc = (ui) => ui.fire(ui.document.activeElement, 'keydown', { key: 'Escape' });
/** Нажатие, как в браузере: кнопка получает фокус, потом click. */
function press(ui, button, what) {
  assert.ok(button, `не найдена ${what}`);
  button.focus();
  ui.click(button, what);
}

const files = (path) => ({
  path,
  parent: null,
  breadcrumbs: path === '/' ? [] : [{ name: 'server', path: '/server' }],
  entries: path === '/' ? [{ name: 'server', path: '/server', isDirectory: true, size: 0 }] : [],
});

test('S9: окно подтверждения — role="dialog", фокус на «Отмена», Esc закрывает без запроса и возвращает фокус', async () => {
  const ui = await setup();
  press(ui, ui.button('Вайп сейчас'), '«Вайп сейчас»');
  const box = dialog(ui);
  assert.ok(box, 'у окна нет role="dialog"');
  assert.equal(box.getAttribute('aria-modal'), 'true');
  assert.ok((box.getAttribute('aria-label') || '').includes('Вайп сейчас'), 'у окна нет подписи');
  assert.equal(ui.document.activeElement?.textContent, 'Отмена', 'фокус не на «Отмена»');
  esc(ui);
  await ui.settle();
  assert.ok(!dialog(ui), 'Esc не закрыл окно');
  assert.equal(ui.requests.filter((request) => request.path.endsWith('/run')).length, 0, 'Esc отправил вайп');
  assert.equal(ui.document.activeElement?.getAttribute('data-rw-key'), 'run:wipe_1', 'фокус не вернулся на «Вайп сейчас»');
});

test('S9: редактор — фокус в «Название»; Esc без правок закрывает; с правками — спрашивает', async () => {
  const ui = await setup();
  press(ui, ui.button('+ Новый профиль'), '«+ Новый профиль»');
  assert.equal(ui.document.activeElement?.getAttribute('data-rw-key'), 'name', 'фокус не в поле названия');
  esc(ui);
  assert.ok(!dialog(ui), 'Esc не закрыл редактор без правок');
  assert.equal(ui.document.activeElement?.getAttribute('data-rw-key'), 'new-profile', 'фокус не вернулся на «+ Новый профиль»');

  press(ui, ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Вайп карты');
  esc(ui);
  assert.ok(ui.text().includes('Закрыть без сохранения?'), 'редактор с правками закрылся без вопроса');
  ui.click(ui.button('Отмена', dialog(ui)), '«Отмена»');
  assert.equal(ui.field('Название')?.value, 'Вайп карты', 'после «Отмена» правки пропали');
  esc(ui);
  ui.click(ui.button('Закрыть без сохранения'), '«Закрыть без сохранения»');
  await ui.settle();
  assert.ok(!dialog(ui), 'редактор не закрылся');
});

test('S9: Esc в поле правки пути отменяет правку, а не закрывает редактор', async () => {
  const ui = await setup();
  press(ui, ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.addTarget('/server/rust/*.sav');
  ui.click(ui.find((node) => node.getAttribute('title') === 'Изменить путь'), '«Изменить путь»');
  const edit = ui.input((node) => node.getAttribute('data-rw-path-edit') !== null);
  assert.ok(edit, 'нет поля правки пути');
  ui.fire(edit, 'keydown', { key: 'Escape' });
  assert.ok(dialog(ui), 'Esc в поле правки закрыл редактор');
});

test('S9: пикер и предпросмотр закрываются по Esc; из пикера — назад в тот же редактор', async () => {
  const ui = await setup({ files });
  press(ui, ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Черновик');
  press(ui, ui.button('Выбрать в файлах…'), '«Выбрать в файлах…»');
  await ui.settle();
  assert.ok(ui.text().includes('Выбор файлов и каталогов'), 'пикер не открылся');
  assert.equal(ui.document.activeElement?.textContent, '← Назад к профилю', 'фокус не в пикере');
  esc(ui);
  assert.equal(ui.field('Название')?.value, 'Черновик', 'Esc в пикере потерял черновик');
  assert.equal(ui.document.activeElement?.getAttribute('data-rw-key'), 'pick-targets', 'фокус не вернулся на «Выбрать в файлах…»');
  ui.click(ui.button('Отмена'), '«Отмена»');
  // В черновике правки: «Отмена» сначала спрашивает (L31-18).
  ui.click(ui.button('Закрыть без сохранения'), '«Закрыть без сохранения»');

  press(ui, ui.button('Что будет удалено'), '«Что будет удалено»');
  await ui.settle();
  assert.equal(ui.document.activeElement?.textContent, 'Закрыть', 'фокус не в предпросмотре');
  esc(ui);
  assert.ok(!dialog(ui), 'Esc не закрыл предпросмотр');
});

test('S9: путь вручную — своим полем, без системного prompt; недобавленный путь не сохраняется молча', async () => {
  const ui = await setup({ profiles: [] });
  let prompted = 0;
  ui.window.prompt = () => {
    prompted += 1;
    return null;
  };
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  assert.ok(!ui.button('Добавить вручную'), 'осталась кнопка с системным prompt');
  ui.type(ui.field('Название'), 'Вайп');
  ui.addTarget('/server/rust/*.sav');
  const target = ui.input((node) => node.getAttribute('data-rw-key') === 'target');
  ui.type(target, '/oxide/data/*');
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
  assert.equal(prompted, 0);
  assert.ok(ui.toast().includes('остался путь'), `тост: «${ui.toast()}»`);
  assert.equal(ui.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/profiles')).length, 0);
});

test('S9: тост виден программам чтения с экрана', async () => {
  const ui = await setup();
  ui.click(ui.button('Тест предупреждения'), '«Тест предупреждения»');
  await ui.settle();
  const toast = ui.find((node) => node.classList.contains('rw-toast'));
  assert.equal(toast?.getAttribute('role'), 'status');
});

test('S9: тост не закрывает окно загрузок панели (справа внизу) — он внизу по центру', async () => {
  const ui = await setup();
  const css = ui.document.getElementById('rust-autowipe-styles')?.textContent ?? '';
  const rule = /\n\.rw-root \.rw-toast\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(rule, 'нет правила тоста');
  assert.ok(rule.includes('left:50%') && rule.includes('transform:translateX(-50%)'), `тост не по центру: ${rule}`);
  assert.ok(!/(^|;)right:/.test(rule), 'тост прижат вправо — закрывает окно загрузок панели');
});
