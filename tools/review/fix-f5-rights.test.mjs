/**
 * Исполнитель F5, находка L31-14 (и часть L31-19 про тексты по правам).
 *
 * У пользователя с правом запуска, но без права менять профили, в шапке было
 * «Только просмотр», а на карточке — кнопка боевого вайпа. На экране было
 * внутреннее имя права rust-autowipe.manage, а «Создайте профиль» видели те,
 * кто создавать не может.
 *
 * Должно: «Только просмотр» — только без обоих прав; с запуском —
 * «Можно запускать, нельзя менять профили»; о правах — обычными словами.
 *
 * Запуск: node tools/review/fix-f5-rights.test.mjs
 */

import assert from 'node:assert/strict';
import { makeStatus, setup, test } from './fix-f5-ui-lib.mjs';

const header = (ui) => ui.find((node) => node.tagName === 'HEADER')?.textContent ?? '';

test('L31-14: можно запускать, нельзя менять — не «Только просмотр»', async () => {
  const ui = await setup({ status: makeStatus({ permissions: { canManage: false, canRun: true } }) });
  assert.ok(header(ui).includes('Можно запускать, нельзя менять профили'), header(ui));
  assert.ok(!header(ui).includes('Только просмотр'), 'в шапке «Только просмотр» рядом с кнопкой вайпа');
  assert.ok(ui.button('Вайп сейчас'), 'нет кнопки вайпа у пользователя с правом запуска');
  assert.ok(!ui.text().includes('rust-autowipe.'), 'на экране внутреннее имя права');
});

test('L31-14: нет ни запуска, ни правки — «Только просмотр»', async () => {
  const ui = await setup({ status: makeStatus({ permissions: { canManage: false, canRun: false } }) });
  assert.ok(header(ui).includes('Только просмотр'));
  assert.ok(!ui.button('Вайп сейчас'), 'кнопка вайпа у пользователя без права запуска');
});

test('L31-19: пустой список без права менять — без «Создайте профиль»', async () => {
  const ui = await setup({ profiles: [], status: makeStatus({ permissions: { canManage: false, canRun: false } }) });
  assert.ok(ui.text().includes('Профилей пока нет.'));
  assert.ok(!ui.text().includes('Создайте профиль'), 'предлагает создать профиль тому, кто не может');
});

test('пустой список с правом менять — подсказка «Создайте профиль» на месте', async () => {
  const ui = await setup({ profiles: [] });
  assert.ok(ui.text().includes('Создайте профиль'));
});
