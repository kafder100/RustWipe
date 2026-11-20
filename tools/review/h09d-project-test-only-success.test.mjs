/**
 * Ревью RustWipe, гипотеза 9 (раздел 4.2), утверждение H9d.
 *
 * Что проверяем. В тестах проекта (tools/test.mjs) проверка доступа через
 * панель покрыта только удачным ответом: единственный тест, который передаёт
 * cookie и доходит до запроса в панель (636-660), подменяет fetch ответом
 * { ok: true }. Тест «чужой сервер недоступен» (602-617) не передаёт ни cookie,
 * ни Authorization, поэтому плагин отказывает ещё до запроса в панель
 * (index.js:96) — ответ панели в нём не проверяется. Если сломать разбор ответа
 * (например, всегда считать доступ разрешённым), тесты проекта этого не заметят.
 *
 * Как должно быть (правила 3.4: тесты на опасное должны падать, если сломать
 * код): есть хотя бы один тест, где панель отвечает отказом, страницей входа
 * с кодом 200 или переходом, и ожидается отказ плагина.
 *
 * Тест читает текст tools/test.mjs, сам набор тестов проекта не запускает
 * (тяжёлый прогон запрещён условиями ревью). Для наглядности песочница
 * показывает, что в случае «без cookie» запроса в панель нет вовсе.
 *
 * Запуск: node tools/review/h09d-project-test-only-success.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSandbox, test } from './sandbox.mjs';

const PROJECT_TESTS = new URL('../test.mjs', import.meta.url);

/** Блоки `await test('имя', ...)` файла: { name, line, body }. */
function testBlocks(text) {
  const marks = [...text.matchAll(/await test\(\s*(['"`])(.+?)\1/g)];
  return marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : text.length;
    return {
      name: mark[2],
      line: text.slice(0, mark.index).split('\n').length,
      body: text.slice(mark.index, end),
    };
  });
}

test('H9d: в тестах проекта есть отказ панели при проверке доступа', async (t) => {
  const text = fs.readFileSync(PROJECT_TESTS, 'utf8');
  const blocks = testBlocks(text);

  // Тест доходит до запроса в панель, только если передаёт плагину cookie или Authorization.
  const reachesPanel = blocks.filter((block) => /headers:\s*\{[^}]*\b(cookie|authorization)\s*:/i.test(block.body));
  const describe = (block) => {
    const stub = /globalThis\.fetch\s*=[\s\S]*?return\s+(\{[^;]*?\})\s*;/.exec(block.body)?.[1] ?? 'нет подмены fetch';
    return `${block.line}: «${block.name}» — подмена fetch отвечает ${stub.replace(/\s+/g, ' ')}`;
  };
  // Отказ панели: не-2xx, HTML, переход — и ожидание отказа плагина.
  const negative = reachesPanel.filter(
    (block) =>
      /ok:\s*false|status:\s*(30[1278]|40[134])|text\/html|redirected:\s*true|Response\(/i.test(block.body) &&
      /statusCode,\s*40[134]|Нет доступа|success,\s*false/.test(block.body),
  );
  t.note(`тестов в tools/test.mjs: ${blocks.length}; доходят до запроса в панель: ${reachesPanel.length}`);
  for (const block of reachesPanel) t.note(describe(block));

  // Наглядно: «чужой без cookie» (как в тесте проекта) отсекается до запроса в панель.
  const sb = createSandbox();
  await sb.load();
  const res = await sb.call('stranger', 'GET', '/servers/srv1/status', { cookie: false });
  const panelCalls = sb.panel.calls.filter((call) => call.path === '/api/servers/srv1').length;
  t.note(`песочница: чужой без cookie → ${res.status}, запросов в панель на проверку доступа: ${panelCalls}`);

  assert.ok(
    negative.length >= 1,
    `нет ни одного теста, где панель отказывает (401/403, страница входа 200, переход) и плагин должен ответить отказом; ` +
      `до панели доходят только: ${reachesPanel.map((block) => `«${block.name}»`).join(', ') || 'ни одного'}`,
  );
});
