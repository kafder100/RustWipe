/**
 * Ревью RustWipe, гипотеза 21 (раздел 4.2), утверждение H21e:
 * в репозитории нет файла лицензии.
 *
 * Правильное поведение (ответ владельца №22 «Лицензия — Пока без лицензии»):
 * отсутствие LICENSE — решение владельца, не ошибка. Ошибкой было бы
 * противоречие: документы или манифесты заявляют лицензию, которой нет,
 * или LICENSE лежит в корне, а в пакет (rust-autowipe/LICENSE) не попадает.
 *
 * Только чтение (zip разбирается в памяти).
 * Запуск: node tools/review/h21e-license.test.mjs
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

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const rootLicense = fs.readdirSync(ROOT).filter((name) => LICENSE_FILE.test(name));
const pluginLicense = fs.readdirSync(path.join(ROOT, 'rust-autowipe')).filter((name) => LICENSE_FILE.test(name));

/** Имена записей zip из центрального каталога. */
function zipNames(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const names = [];
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n -= 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return names;
}

test('без LICENSE ничто не заявляет лицензию (решение владельца — пока без лицензии)', () => {
  if (rootLicense.length || pluginLicense.length) return; // лицензия появилась — проверяет следующий тест
  const claims = [];
  const index = JSON.parse(read('index.json'));
  for (const [label, obj] of [['rust-autowipe/plugin.json', manifest], ['index.json', (index.plugins || index)[0] || {}]]) {
    if (obj.license) claims.push(`${label}: license = ${obj.license}`);
  }
  for (const rel of ['README.md', 'rust-autowipe/README.md', 'docs/RUST-AUTOWIPE-RU.md']) {
    const text = read(rel);
    const m = text.match(/(распространяется|выпущен\p{L}*|licensed)\s+(под|по|under)\s+(лицензи\p{L}*\s+)?(MIT|Apache|GPL|BSD|MPL)/iu);
    if (m) claims.push(`${rel}:${lineOf(text, m.index)} — «${m[0]}»`);
  }
  const zipName = path.posix.basename(new URL((index.plugins || index)[0].downloadUrl).pathname);
  const inZip = zipNames(fs.readFileSync(path.join(ROOT, 'dist', zipName))).filter((name) => LICENSE_FILE.test(name));
  if (inZip.length) claims.push(`dist/${zipName}: ${inZip.join(', ')}`);
  check(claims.length === 0, `лицензии нет, но она заявлена:\n${claims.join('\n')}`);
});

test('если LICENSE появится, он попадает и в пакет (rust-autowipe/LICENSE)', () => {
  if (!rootLicense.length) return;
  check(pluginLicense.length > 0, `в корне ${rootLicense.join(', ')}, а в rust-autowipe/ нет — pack.py его не возьмёт`);
});

console.log(`H21e: в корне — ${rootLicense.join(', ') || 'нет LICENSE'}; в rust-autowipe/ — ${pluginLicense.join(', ') || 'нет'}`);
runAll();
