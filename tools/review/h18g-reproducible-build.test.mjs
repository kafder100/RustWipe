/**
 * Ревью RustWipe, гипотеза 18 (раздел 4.2), утверждение H18g:
 * сборка пакета не воспроизводима — tools/pack.py кладёт в zip даты файлов
 * (ZipFile.write в main(), pack.py:148-150), поэтому одни и те же исходники,
 * взятые в разное время (git checkout ставит дату checkout), дают разные байты
 * и разный sha256. Пересобрать пакет и сверить его с dist/ по sha256 нельзя.
 *
 * Правильное поведение: одинаковые исходники → одинаковый архив (тот же sha256).
 *
 * Как проверяется: две копии проекта во временных папках (os.tmpdir, mkdtemp):
 * rust-autowipe/, tools/pack.py, tools/catalyst_manifest.py и пустой dist/.
 * Содержимое одно и то же, у файлов разные даты изменения (как после checkout
 * в разное время). В каждой копии `python -I -X utf8 tools/pack.py --skip-check`,
 * затем сравниваются sha256. Контроль: повторная сборка в первой копии (те же даты)
 * даёт тот же sha256 — значит, разница именно в датах.
 *
 * Запуск: node tools/review/h18g-reproducible-build.test.mjs  (нужен Python 3)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const probe = spawnSync(cmd, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return cmd;
  }
  return null;
}
const PYTHON = findPython();
const temps = [];
process.on('exit', () => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function setTimes(dir, when) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) setTimes(full, when);
    else fs.utimesSync(full, when, when);
  }
}

/** Копия проекта во временной папке; у всех файлов rust-autowipe/ дата `when`. */
function makeCopy(when) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-h18g-'));
  temps.push(base);
  fs.mkdirSync(path.join(base, 'tools'));
  fs.mkdirSync(path.join(base, 'dist'));
  for (const file of ['pack.py', 'catalyst_manifest.py']) {
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(base, 'tools', file));
  }
  fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(base, 'rust-autowipe'), { recursive: true });
  setTimes(path.join(base, 'rust-autowipe'), when);
  return base;
}

/**
 * Сборка pack.py в копии; возвращает байты архива. Повторная сборка в той же копии
 * без --allow-repack сама упадёт, если архив вышел другим.
 */
function pack(base) {
  const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', path.join('tools', 'pack.py'), '--skip-check'], {
    cwd: base,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${result.stdout}\n${result.stderr}`.split(base).join('<копия>').trim();
  check(result.status === 0, `pack.py упал (код ${result.status}): ${out}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'rust-autowipe', 'plugin.json'), 'utf8'));
  const zipName = `${manifest.name}-${manifest.version}.catpkg.zip`;
  return { zip: fs.readFileSync(path.join(base, 'dist', zipName)), zipName };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Даты записей из центрального каталога zip (DOS-время, как пишет zipfile). */
function zipDates(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const pad = (v) => String(v).padStart(2, '0');
    out.set(
      name,
      `${(date >> 9) + 1980}-${pad((date >> 5) & 15)}-${pad(date & 31)} ${pad(time >> 11)}:${pad((time >> 5) & 63)}`,
    );
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const JAN = new Date('2026-01-10T08:00:00Z');
const JUN = new Date('2026-06-20T15:30:00Z');
let first = null;

test('контроль: повторная сборка тех же файлов с теми же датами даёт тот же sha256', () => {
  check(PYTHON, 'Python 3 не найден — проверка не выполнена');
  const copyA = makeCopy(JAN);
  first = pack(copyA);
  const again = pack(copyA);
  check(sha(first.zip) === sha(again.zip), `разные sha256 даже при одинаковых датах: ${sha(first.zip)} / ${sha(again.zip)}`);
});

test('те же исходники, взятые в другое время, дают тот же sha256', () => {
  check(PYTHON, 'Python 3 не найден — проверка не выполнена');
  if (!first) first = pack(makeCopy(JAN));
  const later = pack(makeCopy(JUN));
  const a = sha(first.zip);
  const b = sha(later.zip);
  if (a !== b) {
    const datesA = zipDates(first.zip);
    const datesB = zipDates(later.zip);
    const sample = [...datesA.keys()].slice(0, 2).map((name) => `${name}: ${datesA.get(name)} → ${datesB.get(name)}`);
    throw new Error(
      `${first.zipName}: sha256 ${a.slice(0, 12)}… ≠ ${b.slice(0, 12)}… при одинаковом содержимом;\n` +
        `в архиве разные даты файлов: ${sample.join('; ')}`,
    );
  }
});

console.log(`H18g: Python — ${PYTHON ?? 'не найден'}; сборка во временных копиях`);
await runAll();
// Для отчёта: совпадает ли пересборка с закоммиченным пакетом (на проверку не влияет).
if (first) {
  const committed = path.join(ROOT, 'dist', first.zipName);
  if (fs.existsSync(committed)) {
    const same = sha(fs.readFileSync(committed)) === sha(first.zip);
    console.log(`  инфо  пересборка из исходников ${same ? 'совпала' : 'не совпала'} с dist/${first.zipName} по sha256`);
  }
}
