/**
 * Исправление F4 для H20b (попутно): .gitignore целиком в UTF-8.
 * Раньше строка-комментарий о стенде .preview/ была в кодировке cp1251
 * и в редакторах и на GitHub выглядела как «кракозябры».
 *
 * Только чтение. Запуск: node tools/review/fix-f4-gitignore-utf8.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('.gitignore читается как UTF-8 без ошибок', () => {
  const bytes = fs.readFileSync(path.join(ROOT, '.gitignore'));
  const bad = [];
  bytes
    .toString('latin1')
    .split('\n')
    .forEach((_, index, lines) => {
      const raw = Buffer.from(lines[index], 'latin1');
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        bad.push(index + 1);
      }
    });
  assert.deepEqual(bad, [], `строки не в UTF-8: ${bad.join(', ')}`);
});

test('комментарий к правилу .preview/ читается по-русски', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === '.preview/');
  assert.ok(at > 0, 'в .gitignore нет правила .preview/');
  assert.equal(lines[at - 1], '# локальный стенд предпросмотра (tools/preview-app.mjs)');
});
