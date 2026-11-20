/**
 * Исправление F4 для L34-10 и H18a: документы не обещают, что CI остановит
 * сломанную версию до панелей, и говорят, как это сделать на деле.
 *
 * Панели ставят пакет по index.json из ветки main сразу после push, а CI
 * запускается уже после него. sha256 лежит рядом с пакетом и защищает только
 * от порчи файла. Поэтому правильные тексты: CI идёт после push, выпуск — через
 * pull request с зелёным CI, ветку main стоит защитить.
 *
 * Только чтение. Запуск: node tools/review/fix-f4-docs-release.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const DOCS = ['README.md', 'docs/RUST-AUTOWIPE-RU.md', 'rust-autowipe/README.md'];

/**
 * Раздел markdown от заголовка heading до следующего заголовка того же или
 * старшего уровня. Строки с «#» внутри блоков кода ``` — не заголовки.
 */
function section(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `нет раздела «${heading}»`);
  const level = heading.match(/^#+/)[0].length;
  let end = start + 1;
  let fence = false;
  for (; end < lines.length; end += 1) {
    if (lines[end].startsWith('```')) fence = !fence;
    const mark = !fence && lines[end].match(/^(#+)\s/);
    if (mark && mark[1].length <= level) break;
  }
  return lines.slice(start, end).join('\n');
}

test('документы не обещают, что CI остановит сломанную версию до панелей', () => {
  const promises = [
    /сломанная версия не доедет/iu,
    /sha256 сверяется в CI, поэтому панель не получит/iu,
    /проверяется\s+в CI\. Панель умеет/iu,
  ];
  const found = [];
  for (const rel of DOCS) {
    const text = read(rel).replace(/\s+/g, ' ');
    for (const promise of promises) if (promise.test(text)) found.push(`${rel}: ${promise}`);
  }
  assert.deepEqual(found, [], `ложные обещания:\n${found.join('\n')}`);
});

for (const [rel, heading] of [
  ['README.md', '### Как выпустить новую версию'],
  ['docs/RUST-AUTOWIPE-RU.md', '### 4.3a. Как выпустить обновление'],
]) {
  test(`${rel}: выпуск через pull request, CI — после push, ветку main защитить`, () => {
    const text = section(read(rel), heading).replace(/\s+/g, ' ');
    assert.match(text, /pull request/i, 'нет шага с pull request');
    assert.match(text, /CI запускается уже после push/i, 'не сказано, что CI идёт после push');
    assert.match(text, /защити\p{L}*\s+ветку\s+`?main`?/iu, 'нет совета защитить ветку main');
  });
}

test('руководство объясняет, от чего защищает sha256 и от чего нет', () => {
  const text = read('docs/RUST-AUTOWIPE-RU.md').replace(/\s+/g, ' ');
  assert.match(text, /sha256 защищает от файла, испорченного при скачивании, но не от подмены/i);
});
