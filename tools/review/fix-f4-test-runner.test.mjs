/**
 * Исправление F4 для L34-12: tools/test.mjs не останавливается на первой
 * упавшей проверке — остальные выполняются, в конце печатается итог, код выхода 1.
 *
 * Как проверяется: во временной папке копия tools/test.mjs и rust-autowipe/.
 * В копию test.mjs сразу после первой проверки вставлена нарочно падающая.
 * Затем копия запускается (node, без сети и без серверов — как обычный
 * node tools/test.mjs). Исходный tools/test.mjs не меняется.
 *
 * Запуск: node tools/review/fix-f4-test-runner.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNode, test, withTempDir } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'tools', 'test.mjs'), 'utf8');
const TOTAL = (SOURCE.match(/^await test\(/gm) || []).length;
const BROKEN = 'нарочно падающая проверка (ревью)';
/** Имя последней проверки в tools/test.mjs: у неё тоже должен быть итог (ok или FAIL). */
const LAST = [...SOURCE.matchAll(/^await test\('([^']+)'/gm)].pop()?.[1];

test('после упавшей проверки остальные выполняются, итог печатается, код выхода 1', async () => {
  assert.ok(TOTAL > 1, `в tools/test.mjs не найдено проверок (await test): ${TOTAL}`);
  await withTempDir(async (base) => {
    fs.mkdirSync(path.join(base, 'tools'));
    fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(base, 'rust-autowipe'), { recursive: true });
    // Вставка сразу после первой проверки: дальше должны идти все остальные.
    const first = SOURCE.search(/^await test\(/m);
    const second = SOURCE.slice(first + 1).search(/^await test\(/m) + first + 1;
    const injected =
      `${SOURCE.slice(0, second)}await test(${JSON.stringify(BROKEN)}, () => {\n` +
      `  throw new Error('сломано нарочно');\n});\n\n${SOURCE.slice(second)}`;
    const copy = path.join(base, 'tools', 'test.mjs');
    fs.writeFileSync(copy, injected);

    const result = await runNode({ file: copy, cwd: base, timeoutMs: 120_000 });
    const out = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, 'прогон копии не уложился в 120 с');
    assert.equal(result.code, 1, `код выхода ${result.code}, а нужен 1`);
    const lines = out.split(/\r?\n/);
    const brokenAt = lines.findIndex((line) => line === `FAIL  ${BROKEN}`);
    assert.ok(brokenAt >= 0, `нет строки «FAIL  ${BROKEN}»:\n${out.slice(0, 2000)}`);
    const results = lines.filter((line) => /^ {2}ok {2}/.test(line) || /^FAIL {2}/.test(line));
    assert.equal(results.length, TOTAL + 1, `проверок с итогом ${results.length}, а запускалось ${TOTAL + 1}:\n${out.slice(-2000)}`);
    // stdout и stderr приходят отдельно, порядок строк между ними не сохраняется:
    // проверяем, что итог есть и у последней проверки файла.
    assert.ok(LAST, 'не найдено имя последней проверки');
    assert.ok(lines.includes(`  ok  ${LAST}`) || lines.includes(`FAIL  ${LAST}`), `последняя проверка «${LAST}» не выполнилась`);
    assert.ok(/Проверок прошло: \d+, упало: [1-9]\d*/.test(out), `нет итоговой строки:\n${out.slice(-1500)}`);
    assert.ok(lines.includes(`  FAIL  ${BROKEN}`), 'в итоге нет списка упавших проверок');
  }, { prefix: 'rw-fix-f4-runner-' });
}, { timeoutMs: 150_000 });
