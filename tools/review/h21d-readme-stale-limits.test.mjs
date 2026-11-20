/**
 * Ревью RustWipe, гипотеза 21 (раздел 4.2), утверждение H21d:
 * README.md, раздел «Ограничения» (README.md:195), устарел: пишет, что в плагине
 * нет анонсов в чат и ротации сида карты, хотя и предупреждения в чат
 * (wipeWarning*, backend/lib/warnings.js), и смена сида и размера карты
 * (WORLD_SEED / WORLD_SIZE, backend/lib/mapgen.js) есть; ссылка оттуда ведёт
 * на якорь руководства, которого больше нет.
 *
 * Правильное поведение (ответ владельца №23 «Устаревшие тексты — Да», править):
 * README не отрицает того, что плагин умеет, а ссылки на разделы руководства
 * ведут на существующие заголовки.
 *
 * Только чтение. Запуск: node tools/review/h21d-readme-stale-limits.test.mjs
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

const readme = read('README.md');
const config = manifest.config || {};
const exists = (rel) => fs.existsSync(path.join(ROOT, ...rel.split('/')));

/** Возможности, которые есть в плагине, и фразы README, которые их отрицают. */
const FEATURES = [
  {
    name: 'предупреждения игрокам в чат',
    present: 'wipeWarningEnabled' in config || exists('rust-autowipe/backend/lib/warnings.js'),
    denial: /(?:^|[\s(«"—-])нет\s[^.\n]{0,80}?(?:анонс|предупрежден)\p{L}*\s+в\s+чат/iu,
  },
  {
    name: 'смена сида и размера карты',
    present: /WORLD_SEED/.test(manifest.description || '') || exists('rust-autowipe/backend/lib/mapgen.js'),
    denial: /(?:^|[\s(«"—-])нет\s[^.\n]{0,80}?(?:ротаци|смен)\p{L}*\s+сида/iu,
  },
];

test('README не отрицает возможностей, которые есть в плагине', () => {
  const wrong = [];
  for (const feature of FEATURES) {
    if (!feature.present) continue;
    const m = readme.match(feature.denial);
    if (m) wrong.push(`${feature.name}: README.md:${lineOf(readme, m.index)} — «${m[0].trim()}…»`);
  }
  check(wrong.length === 0, wrong.join('\n'));
});

/** Якорь заголовка как у GitHub: строчные, без знаков препинания, пробел → «-». */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~«»]/g, '')
    .replace(/ /g, '-');
}
function anchorsOf(markdown) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

test('ссылки README на разделы руководства ведут на существующие заголовки', () => {
  const broken = [];
  for (const m of readme.matchAll(/\]\(((?:\.\/)?docs\/[^)#\s]+\.md)#([^)\s]+)\)/g)) {
    const target = m[1].replace(/^\.\//, '');
    if (!exists(target)) {
      broken.push(`README.md:${lineOf(readme, m.index)} — нет файла ${target}`);
      continue;
    }
    const anchor = decodeURIComponent(m[2]).toLowerCase();
    if (!anchorsOf(read(target)).has(anchor)) broken.push(`README.md:${lineOf(readme, m.index)} — в ${target} нет #${anchor}`);
  }
  check(broken.length === 0, broken.join('\n'));
});

runAll();
