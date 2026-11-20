/**
 * Исполнитель F5, находки H16c и L31-10.
 *
 * Во время запроса «Запустить сейчас» оставалась активной: двойное нажатие
 * слало второй POST …/run. Вкладка обновлялась только через 2,5 и 9 с, а вайп
 * идёт минуты — «выполняется» висело до ручного «Обновить»; «Проверка»,
 * «Изменить» и «Удалить» во время прогона были активны.
 *
 * Должно (правила ревью 3.1): на время запроса и прогона кнопки профиля
 * неактивны, надписи не меняются; пока профиль выполняется, вкладка сама
 * опрашивает профили и историю и перестаёт, когда прогон кончился.
 *
 * Запуск: node tools/review/fix-f5-run-busy.test.mjs
 */

import assert from 'node:assert/strict';
import { makeProfile, setup, test } from './fix-f5-ui-lib.mjs';

const BUTTONS = ['Проверка', 'Вайп сейчас', 'Изменить', 'Выключить', 'Удалить'];

function cardButtons(ui) {
  const card = ui.find((node) => node.classList.contains('rw-card'));
  return Object.fromEntries(BUTTONS.map((label) => [label, ui.button(label, card)]));
}

/** Подмена: ответ на POST …/run ждёт release(); профили — из state. */
function gatedRun() {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release,
    async handle(request) {
      if (request.method === 'POST' && request.path.endsWith('/run')) {
        await gate;
        return { success: true, started: true, dryRun: request.body?.dryRun === true };
      }
      return undefined;
    },
  };
}

async function pressLive(ui) {
  ui.click(cardButtons(ui)['Вайп сейчас'], '«Вайп сейчас»');
  ui.click(ui.button('Вайп сейчас', ui.overlays()[0]), 'подтверждения');
  await ui.settle();
}

test('H16c: пока запрос в пути, кнопки профиля неактивны, надписи те же, второй запрос не уходит', async () => {
  const run = gatedRun();
  const ui = await setup({ handle: run.handle });
  await pressLive(ui);
  const buttons = cardButtons(ui);
  for (const label of BUTTONS) {
    assert.ok(buttons[label], `кнопка «${label}» пропала или сменила надпись`);
    assert.ok(buttons[label].disabled, `«${label}» активна, пока запрос в пути`);
  }
  // Второе нажатие ничего не делает.
  ui.click(buttons['Вайп сейчас']);
  ui.click(buttons['Проверка']);
  await ui.settle();
  run.release();
  await ui.settle();
  const posts = ui.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/run'));
  assert.equal(posts.length, 1, `ушло POST …/run: ${posts.length}`);
});

test('L31-10: после запуска вкладка опрашивает состояние, пока прогон не кончится, потом перестаёт', async () => {
  const ui = await setup();
  await pressLive(ui);
  // Backend: прогон идёт.
  ui.state.profiles = [makeProfile({ running: true })];
  const badge = () => ui.find((node) => node.classList.contains('rw-badge') && node.parentNode?.classList.contains('rw-card-head'))?.textContent;
  await ui.timers.advance(4000);
  assert.equal(badge(), 'выполняется');
  assert.ok(cardButtons(ui)['Удалить'].disabled, '«Удалить» активна во время прогона');
  assert.ok(cardButtons(ui)['Изменить'].disabled, '«Изменить» активна во время прогона');
  // Прогон кончился через 3 минуты.
  await ui.timers.advance(180000);
  ui.state.profiles = [makeProfile({ running: false, lastRunStatus: 'ok', lastRunAt: new Date().toISOString() })];
  await ui.timers.advance(4000);
  assert.equal(badge(), 'последний вайп: ок', 'вкладка сама не узнала, что прогон кончился');
  assert.ok(!cardButtons(ui)['Вайп сейчас'].disabled, 'после прогона кнопка осталась неактивной');
  const polls = ui.requests.filter((request) => request.path.endsWith('/runs')).length;
  await ui.timers.advance(60000);
  assert.equal(ui.requests.filter((request) => request.path.endsWith('/runs')).length, polls, 'опрос не остановился');
});

test('L31-10: фоновый опрос не пересобирает открытый редактор (не мешает набирать текст)', async () => {
  const ui = await setup({ profiles: [makeProfile({ running: true }), makeProfile({ id: 'wipe_2', name: 'Второй' })] });
  ui.click(ui.button('+ Новый профиль'), '«+ Новый профиль»');
  const modal = ui.modal();
  const polls = ui.requests.filter((request) => request.path.endsWith('/runs')).length;
  await ui.timers.advance(4000);
  assert.ok(ui.requests.filter((request) => request.path.endsWith('/runs')).length > polls, 'опрос не идёт');
  assert.equal(ui.modal(), modal, 'опрос пересобрал открытый редактор');
});

test('L31-10: вкладку открыли, когда профиль уже выполняется, — опрос идёт сам', async () => {
  const ui = await setup({ profiles: [makeProfile({ running: true })] });
  const before = ui.requests.length;
  await ui.timers.advance(4000);
  assert.ok(ui.requests.length > before, 'вкладка не опрашивает выполняющийся профиль');
});
