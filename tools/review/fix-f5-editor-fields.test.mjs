/**
 * Исполнитель F5, находка L31-15: поля редактора молча подменяли пустой ввод.
 * Стёрли размер карты — поле снова показывало 3000, а в черновике null, и
 * «Сохранить» ругался на размер, хотя в поле видно 3000. Стёртое время молча
 * становилось 05:00, число месяца — 1, интервал — 7.
 *
 * Должно: поле показывает то, что будет сохранено (пустое остаётся пустым),
 * а пустое значение даёт понятную ошибку до отправки.
 *
 * Запуск: node tools/review/fix-f5-editor-fields.test.mjs
 */

import assert from 'node:assert/strict';
import { setup, test } from './fix-f5-ui-lib.mjs';

async function newProfile(ui) {
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  ui.type(ui.field('Название'), 'Вайп');
  ui.addTarget('/server/*/proceduralmap.*.sav');
}

const rerender = (ui) => ui.check(ui.input((node) => node.getAttribute('type') === 'checkbox'), true);
const posts = (ui) => ui.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/profiles'));

async function save(ui) {
  ui.click(ui.button('Сохранить'), '«Сохранить»');
  await ui.settle();
}

test('L31-15: стёртый размер карты остаётся пустым и даёт понятную ошибку', async () => {
  const ui = await setup({ profiles: [] });
  await newProfile(ui);
  ui.type(ui.field('Размер (1000…6000)'), '');
  rerender(ui);
  assert.equal(ui.field('Размер (1000…6000)').value, '', 'поле размера снова показывает число');
  await save(ui);
  assert.equal(posts(ui).length, 0, 'профиль ушёл с пустым размером');
  assert.ok(ui.toast().includes('укажите размер'), `тост: «${ui.toast()}»`);
});

test('L31-15: стёртое время не становится 05:00', async () => {
  const ui = await setup({ profiles: [] });
  await newProfile(ui);
  ui.type(ui.input((node) => node.getAttribute('type') === 'time'), '');
  rerender(ui);
  assert.equal(ui.input((node) => node.getAttribute('type') === 'time').value, '', 'время подменено');
  await save(ui);
  assert.equal(posts(ui).length, 0, 'профиль ушёл без времени');
  assert.equal(ui.toast(), 'Укажите время вайпа');
});

test('L31-15: стёртые число месяца и интервал не становятся 1 и 7', async () => {
  const ui = await setup({ profiles: [] });
  await newProfile(ui);
  ui.select(ui.field('Тип расписания'), 'monthly_day');
  ui.type(ui.field('Число месяца (1–31)'), '');
  rerender(ui);
  assert.equal(ui.field('Число месяца (1–31)').value, '');
  await save(ui);
  assert.equal(ui.toast(), 'Укажите число месяца от 1 до 31');

  ui.select(ui.field('Тип расписания'), 'interval');
  ui.type(ui.field('Интервал, дней'), '');
  rerender(ui);
  assert.equal(ui.field('Интервал, дней').value, '');
  await save(ui);
  assert.equal(ui.toast(), 'Укажите интервал от 1 до 365 дней');
  assert.equal(posts(ui).length, 0);
});

test('заполненные поля сохраняются как есть', async () => {
  const ui = await setup({ profiles: [] });
  await newProfile(ui);
  ui.type(ui.field('Размер (1000…6000)'), '4500');
  ui.type(ui.input((node) => node.getAttribute('type') === 'time'), '06:30');
  await save(ui);
  assert.equal(posts(ui).length, 1, `профиль не ушёл: ${ui.toast()}`);
  assert.equal(posts(ui)[0].body.map.size.value, 4500);
  assert.equal(posts(ui)[0].body.schedule.time, '06:30');
});
