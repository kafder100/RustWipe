/**
 * Исправление F4 для H21c (попутные пункты): разделы «Структура репозитория»
 * в README.md и «3. Состав проекта» в docs/RUST-AUTOWIPE-RU.md перечисляют
 * все скрипты tools/, оба workflow и CHANGELOG.md, а руководство не называет
 * устаревший размер пакета «~38 КБ».
 *
 * Только чтение. Запуск: node tools/review/fix-f4-docs-structure.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

/** Первый блок кода ``` после заголовка heading. */
function codeBlockAfter(markdown, heading) {
  const start = markdown.split(/\r?\n/).findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `нет заголовка «${heading}»`);
  const lines = markdown.split(/\r?\n/).slice(start + 1);
  const open = lines.findIndex((line) => line.startsWith('```'));
  const close = lines.findIndex((line, index) => index > open && line.startsWith('```'));
  assert.ok(open >= 0 && close > open, `после «${heading}» нет блока кода`);
  return lines.slice(open + 1, close).join('\n');
}

const tools = fs
  .readdirSync(path.join(ROOT, 'tools'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(mjs|js|py)$/.test(entry.name))
  .map((entry) => entry.name);
const workflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name));
const expected = [...tools, ...workflows, 'CHANGELOG.md', 'review/'];

for (const [file, heading] of [
  ['README.md', '## Структура репозитория'],
  ['docs/RUST-AUTOWIPE-RU.md', '## 3. Состав проекта'],
]) {
  test(`${file}: «${heading.replace(/^#+\s*/, '')}» перечисляет все скрипты, workflow и CHANGELOG.md`, () => {
    const block = codeBlockAfter(read(file), heading);
    const missing = expected.filter((name) => !block.includes(name));
    assert.deepEqual(missing, [], `не упомянуты: ${missing.join(', ')}`);
  });
}

test('руководство не называет устаревший размер пакета', () => {
  assert.ok(!/~\s*38\s*КБ/.test(read('docs/RUST-AUTOWIPE-RU.md')), 'в руководстве осталось «~38 КБ»');
});
