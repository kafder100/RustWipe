/**
 * Исполнитель F5, находка S2 (вид вкладки в оболочке Catalyst).
 *
 * Панель обновляет плагин «на лету» (событие plugin_updated): бандл
 * импортируется заново без перезагрузки страницы. Вкладка видела, что
 * <style id="rust-autowipe-styles"> уже есть, и не трогала его — новая
 * разметка рисовалась со стилями прошлой версии до обновления страницы.
 *
 * Должно: новая версия кладёт свои стили, <style> с этим id один.
 *
 * Запуск: node tools/review/fix-f5-style-update.test.mjs
 */

import assert from 'node:assert/strict';
import { findAll, setup, test } from './fix-f5-ui-lib.mjs';

const STYLE_ID = 'rust-autowipe-styles';
const OLD_CSS = '.rw-root{color:red} /* стили прошлой версии */';

function styles(ui) {
  return findAll(ui.document.documentElement, (node) => node.tagName === 'STYLE' && node.id === STYLE_ID);
}

test('S2: <style> прошлой версии заменяется стилями новой', async () => {
  const ui = await setup({
    prepare({ document, DomNode }) {
      const old = new DomNode('style');
      old.id = STYLE_ID;
      old.textContent = OLD_CSS;
      document.head.appendChild(old);
    },
  });
  const list = styles(ui);
  assert.equal(list.length, 1, `элементов <style id="${STYLE_ID}">: ${list.length}`);
  assert.notEqual(list[0].textContent, OLD_CSS, 'остались стили прошлой версии');
  assert.ok(list[0].textContent.includes('.rw-root'), 'в новых стилях нет правил вкладки');
});

test('S2: повторное монтирование не плодит <style>', async () => {
  const ui = await setup();
  await ui.remount('srv-other');
  await ui.remount('srv1');
  assert.equal(styles(ui).length, 1);
});
