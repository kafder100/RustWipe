/**
 * Исполнитель F5, находки S3, S4, S5, S6, S7, S10 (вид вкладки в оболочке
 * Catalyst v1.89.2) и «попутно» — неопределённый --rw-accent.
 *
 * Было: свои цвета, оранжевый акцент и радиусы 6/10 вместо токенов панели;
 * свой фон вкладки; свои поля поверх полей панели (на 375 px вкладка теряла
 * 24 px); свой шрифт вместо шрифта панели; у select пропадала стрелка (панель
 * рисует её картинкой фона, а плагин стирал её сокращённым background);
 * у корня не задан color-scheme — поля даты и времени оставались тёмными
 * после смены темы.
 *
 * Проверяется текст стилей, который вкладка кладёт в <style>.
 *
 * Запуск: node tools/review/fix-f5-panel-look.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findAll, setup, test } from './fix-f5-ui-lib.mjs';

const SOURCE = fs.readFileSync(new URL('../../rust-autowipe/frontend/frontend.mjs', import.meta.url), 'utf8');

async function css() {
  const ui = await setup();
  const style = findAll(ui.document.documentElement, (node) => node.tagName === 'STYLE' && node.id === 'rust-autowipe-styles')[0];
  assert.ok(style, 'вкладка не положила стили');
  return style.textContent;
}

/** Тело правила с ровно этим селектором (первое вхождение). */
function rule(text, selector) {
  const at = text.indexOf(`\n${selector}{`);
  assert.ok(at >= 0, `нет правила ${selector}`);
  const start = at + selector.length + 2;
  return text.slice(start, text.indexOf('}', start));
}

test('S4: цвета вкладки — токены панели hsl(var(--…)), своих #hex нет', async () => {
  const text = await css();
  for (const theme of ['dark', 'light']) {
    const body = rule(text, `.rw-root[data-rw-theme="${theme}"]`);
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(body), `в теме ${theme} свои цвета: ${body.match(/#[0-9a-f]{3,8}\b/i)}`);
    for (const [token, panel] of [
      ['--rw-surface', '--card'],
      ['--rw-text', '--foreground'],
      ['--rw-text-dim', '--muted-foreground'],
      ['--rw-border', '--border'],
      ['--rw-primary', '--primary'],
      ['--rw-ok', '--success'],
      ['--rw-warn', '--warning'],
      ['--rw-danger', '--danger'],
      ['--rw-overlay', '--scrim'],
    ]) {
      assert.ok(new RegExp(`${token}:hsl\\(var\\(${panel}[,)]`).test(body), `в теме ${theme} ${token} не из ${panel}`);
    }
  }
  assert.ok(!SOURCE.includes('--rw-accent'), 'в коде осталась неопределённая --rw-accent');
  assert.ok(!SOURCE.includes('rgba(148,163,184'), 'в коде остался свой серый цвет');
});

test('S4: радиус — --deck-radius панели', async () => {
  const body = rule(await css(), '.rw-root');
  assert.ok(body.includes('--rw-r-sm:var(--deck-radius'), 'малый радиус не из панели');
  assert.ok(body.includes('--rw-r-md:var(--deck-radius'), 'большой радиус не из панели');
});

test('S5, S6, S7: у корня нет своего фона и полей, шрифт — панели', async () => {
  const text = await css();
  const body = rule(text, '.rw-root');
  assert.ok(!/(^|;|\n)\s*background(-color)?:/.test(body), 'у вкладки свой фон');
  assert.ok(/(^|;|\n)\s*padding:0[;\n]/.test(body), 'у корня вкладки свои поля');
  assert.ok(!/\.rw-root\{padding:/.test(text), 'поля корня возвращаются в @media');
  assert.ok(!/font-family:/.test(body), 'корень задаёт свой шрифт вместо шрифта панели');
  assert.ok(/--rw-mono:"JetBrains Mono/.test(body), 'моноширинный шрифт не панели');
  assert.ok(/\.rw-root \.rw-btn\{[^}]*font:inherit/.test(text), 'кнопки не берут шрифт панели');
});

test('S3: select сохраняет стрелку панели', async () => {
  const text = await css();
  const shared = /\.rw-root \.rw-field input,\.rw-root \.rw-field select[^{]*\{([^}]*)\}/.exec(text)?.[1] ?? '';
  assert.ok(shared, 'нет общего правила полей');
  assert.ok(!/(^|;|\n)\s*background:/.test(shared), 'сокращённый background стирает стрелку select');
  assert.ok(/\.rw-root \.rw-field select\{padding-right:2rem\}/.test(text), 'справа у select нет места под стрелку');
});

test('S10: color-scheme по теме вкладки', async () => {
  const text = await css();
  assert.ok(rule(text, '.rw-root[data-rw-theme="dark"]').includes('color-scheme:dark'));
  assert.ok(rule(text, '.rw-root[data-rw-theme="light"]').includes('color-scheme:light'));
});
