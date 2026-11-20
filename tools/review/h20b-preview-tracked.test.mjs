/**
 * Ревью RustWipe, гипотеза 20 (раздел 4.2), утверждение H20b:
 * каталог локального стенда .preview/ лежит в репозитории, хотя .gitignore
 * его исключает. Правило в .gitignore не убирает уже добавленные файлы:
 * git продолжает их отслеживать, а tools/push_to_github.mjs выкладывает их
 * в любом случае (H20a).
 *
 * Правильное поведение (ответ владельца №21 «Папка .preview/ — Да, убрать»):
 * в индексе git нет ни одного файла из .preview/, а правило .preview/
 * в .gitignore осталось.
 *
 * Только чтение: `git ls-files` и чтение .gitignore. Git не меняется.
 * Запуск: node tools/review/h20b-preview-tracked.test.mjs  (нужен git)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

function gitLsFiles(...pathspec) {
  const result = spawnSync('git', ['-C', ROOT, 'ls-files', '--', ...pathspec], { encoding: 'utf8' });
  check(result.status === 0, `git ls-files не выполнился (код ${result.status}) — проверка не выполнена`);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

test('контроль: git видит файлы проекта', () => {
  check(gitLsFiles('rust-autowipe/plugin.json').length === 1, 'git не видит rust-autowipe/plugin.json');
});

test('.gitignore по-прежнему исключает .preview/', () => {
  const rules = fs.readFileSync(path.join(ROOT, '.gitignore'), 'latin1').split(/\r?\n/).map((l) => l.trim());
  check(rules.some((rule) => /^\/?\.preview\/?$/.test(rule)), 'в .gitignore нет правила .preview/');
});

test('в репозитории нет файлов из .preview/', () => {
  const tracked = gitLsFiles('.preview');
  check(tracked.length === 0, `git отслеживает ${tracked.length}: ${tracked.join(', ')}`);
});

runAll();
