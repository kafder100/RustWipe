/**
 * Исполнитель F5, находка S8 (вид вкладки в оболочке Catalyst): раскладка
 * переключалась по ширине окна браузера (@media), а не вкладки. У панели
 * слева меню, и на компьютере вкладка заметно уже окна.
 *
 * Должно: содержимое вкладки — в обёртке-контейнере (container-type), его
 * раскладка — по @container; окна, тост и формы в окнах — по @media (они
 * привязаны к экрану). Окно не лежит внутри контейнера.
 *
 * Запуск: node tools/review/fix-f5-tab-width.test.mjs
 */

import assert from 'node:assert/strict';
import { findAll, setup, test } from './fix-f5-ui-lib.mjs';

async function cssText(ui) {
  return findAll(ui.document.documentElement, (node) => node.tagName === 'STYLE' && node.id === 'rust-autowipe-styles')[0]
    .textContent;
}

/** Тела блоков @media/@container с условием, содержащим cond. */
function blocks(text, at, cond) {
  const out = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(`${at} `, from);
    if (start < 0) break;
    const open = text.indexOf('{', start);
    const head = text.slice(start, open);
    let depth = 1;
    let i = open + 1;
    while (depth && i < text.length) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    if (head.includes(cond)) out.push(text.slice(open + 1, i - 1));
    from = i;
  }
  return out.join('\n');
}

test('S8: содержимое вкладки — в контейнере, окно и тост — вне его', async () => {
  const ui = await setup();
  const body = ui.find((node) => node.classList.contains('rw-body'));
  assert.ok(body, 'нет обёртки-контейнера .rw-body');
  assert.ok(body.contains(ui.find((node) => node.tagName === 'HEADER')), 'шапка не в контейнере');
  ui.click(ui.button('Вайп сейчас'), '«Вайп сейчас»');
  const overlay = ui.overlays()[0];
  assert.ok(overlay, 'окно не открылось');
  assert.ok(!body.contains(overlay), 'окно внутри контейнера: position:fixed может считаться от него');
  const css = await cssText(ui);
  assert.ok(/\.rw-root \.rw-body\{container:rw-tab \/ inline-size/.test(css), 'у .rw-body нет container-type');
});

test('S8: раскладка карточек, шапки и шагов — по ширине вкладки, окна — по ширине экрана', async () => {
  const ui = await setup();
  const css = await cssText(ui);
  const container720 = blocks(css, '@container', '(max-width:720px)');
  const media720 = blocks(css, '@media', '(max-width:720px)');
  for (const selector of ['.rw-root .rw-head{', '.rw-root .rw-card-head{', '.rw-root .rw-actions .rw-btn{', '.rw-root .rw-step>summary{']) {
    assert.ok(container720.includes(selector), `${selector} не в @container`);
    assert.ok(!media720.includes(selector), `${selector} всё ещё по ширине окна`);
  }
  assert.ok(media720.includes('.rw-root .rw-overlay{padding:0}'), 'окно на телефоне больше не во весь экран');
  assert.ok(media720.includes('.rw-root .rw-toast{'), 'тост на телефоне не по ширине экрана');
  assert.ok(blocks(css, '@container', '(max-width:420px)').includes('.rw-root .rw-actions .rw-btn{flex:1 1 100%}'));
});
