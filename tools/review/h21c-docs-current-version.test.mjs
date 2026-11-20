/**
 * Ревью RustWipe, гипотеза 21 (раздел 4.2), утверждение H21c:
 * руководство называет устаревшую «актуальную» версию плагина
 * (docs/RUST-AUTOWIPE-RU.md, вступление: «Актуальная версия плагина — 1.4.1»).
 *
 * Правильное поведение (ответ владельца №23 «Устаревшие тексты — Да», править):
 * везде, где документы называют актуальную или текущую версию плагина, стоит
 * version из rust-autowipe/plugin.json.
 *
 * Только чтение. Запуск: node tools/review/h21c-docs-current-version.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Мини-набор тестов: незавершённый тест считается проваленным ─────────────
const tests = [];
const pending = new Set();
let passed = 0;
let failed = 0;
let reported = false;
function test(name, fn) {
  tests.push({ name, fn });
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
process.on('beforeExit', () => {
  if (reported) return;
  reported = true;
  for (const name of pending) {
    failed += 1;
    console.log(`  FAIL  ${name}: тест не завершился`);
  }
  console.log(`Итог: ${passed} прошло, ${failed} провалено`);
  if (failed) process.exitCode = 1;
});
async function runAll() {
  for (const t of tests) pending.add(t.name);
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok    ${t.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${t.name}\n        ${String(error.message).split('\n').join('\n        ')}`);
    } finally {
      pending.delete(t.name);
    }
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
const manifest = JSON.parse(read('rust-autowipe/plugin.json'));
/** Номер строки (с 1) для позиции в тексте. */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const DOCS = ['README.md', 'docs/RUST-AUTOWIPE-RU.md', 'rust-autowipe/README.md'];
const CLAIM = /(актуальн|текущ)\p{L}*\s+верси\p{L}*[^\d\n]{0,40}?(\d+\.\d+\.\d+)/giu;

test('документы называют актуальной версию из plugin.json', () => {
  const wrong = [];
  let found = 0;
  for (const rel of DOCS) {
    if (!fs.existsSync(path.join(ROOT, ...rel.split('/')))) continue;
    const text = read(rel);
    for (const m of text.matchAll(CLAIM)) {
      found += 1;
      if (m[2] !== manifest.version) wrong.push(`${rel}:${lineOf(text, m.index)} — «${m[0].trim()}»`);
    }
  }
  check(wrong.length === 0, `plugin.json: ${manifest.version}; устарело:\n${wrong.join('\n')}`);
  console.log(`  инфо  упоминаний актуальной версии: ${found}`);
});

runAll();
