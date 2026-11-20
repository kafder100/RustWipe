/**
 * Ревью RustWipe, гипотеза 21 (раздел 4.2), утверждение H21a:
 * CHANGELOG.md не сверяется с plugin.json — проверка индекса и пакета в CI
 * (tools/check_index.py) смотрит plugin.json, index.json и zip, но не CHANGELOG.md.
 *
 * Правильное поведение (правила ревью, раздел 3.4: «версии сходятся в plugin.json,
 * index.json, CHANGELOG.md, имени архива в dist/»): верхняя запись CHANGELOG.md —
 * текущая версия plugin.json, а если её забыли добавить, проверка в CI падает.
 *
 * Как проверяется: (1) сверка в рабочей копии; (2) во временной папке (os.tmpdir,
 * mkdtemp) копия check_index.py, catalyst_manifest.py, rust-autowipe/, index.json,
 * пакета и CHANGELOG.md, из которого убрана запись текущей версии (её «забыли»);
 * затем `python -I -X utf8 tools/check_index.py` в этой копии.
 * CHANGELOG.md проекта не меняется.
 *
 * Запуск: node tools/review/h21a-changelog-version.test.mjs  (нужен Python 3)
 */

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

/** Верхняя версия CHANGELOG: первый заголовок «## X.Y.Z» (у диапазона — конец). */
function topChangelogVersion(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^##\s+(\d+\.\d+\.\d+)(?:\s*[–-]\s*(\d+\.\d+\.\d+))?/);
    if (m) return m[2] || m[1];
  }
  return null;
}

/** Убрать из CHANGELOG раздел версии version — как будто его забыли добавить. */
function dropSection(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${version.replace(/\./g, '\\.')}\\b`).test(line));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'rust-autowipe', 'plugin.json'), 'utf8'));
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

test('верхняя запись CHANGELOG.md = version из plugin.json', () => {
  const top = topChangelogVersion(changelog);
  check(top === manifest.version, `CHANGELOG.md: ${top}, plugin.json: ${manifest.version}`);
});

test('проверка в CI (check_index.py) падает, если в CHANGELOG.md нет записи текущей версии', () => {
  check(PYTHON, 'Python 3 не найден — проверка не выполнена');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-h21a-'));
  temps.push(base);
  fs.mkdirSync(path.join(base, 'tools'));
  fs.mkdirSync(path.join(base, 'dist'));
  for (const file of ['check_index.py', 'catalyst_manifest.py']) {
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(base, 'tools', file));
  }
  fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(base, 'rust-autowipe'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.json'), path.join(base, 'index.json'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
  const zipName = path.posix.basename(new URL((index.plugins || index)[0].downloadUrl).pathname);
  for (const file of [zipName, `${zipName}.sha256`]) {
    fs.copyFileSync(path.join(ROOT, 'dist', file), path.join(base, 'dist', file));
  }
  const stale = dropSection(changelog, manifest.version);
  fs.writeFileSync(path.join(base, 'CHANGELOG.md'), stale);
  const top = topChangelogVersion(stale);
  check(top && top !== manifest.version, 'не удалось подготовить расхождение');

  const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', path.join('tools', 'check_index.py')], {
    cwd: base,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const first = `${result.stdout}\n${result.stderr}`.split(base).join('<копия>').trim().split('\n')[0];
  check(
    result.status !== 0,
    `check_index.py прошёл (код ${result.status}: «${first}»), хотя CHANGELOG.md начинается с ${top}, а plugin.json — ${manifest.version}`,
  );
});

console.log(`H21a: plugin.json ${manifest.version}, CHANGELOG.md ${topChangelogVersion(changelog)}`);
runAll();
