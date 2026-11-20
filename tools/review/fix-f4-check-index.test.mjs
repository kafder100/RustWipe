/**
 * Исправления F4 в tools/check_index.py (проверка индекса и пакета в CI).
 *
 * H18f: пакет из dist/ сверяется с исходниками rust-autowipe/ — состав и байты.
 * H21a: верхняя запись CHANGELOG.md — версия из plugin.json.
 * H21b: константа version во frontend.mjs — версия из plugin.json.
 *
 * Как проверяется: во временной папке копия tools/check_index.py,
 * tools/catalyst_manifest.py, tools/pack.py, rust-autowipe/ и CHANGELOG.md;
 * пакет и index.json собирает pack.py в этой копии из тех же исходников —
 * такая копия согласована и проверку проходит (контроль). Затем в копии
 * ломается ровно одно место, и check_index.py должен упасть ровно с одной,
 * нужной причиной.
 *
 * Пакеты в dist/ проекта и index.json не трогаются: всё — в копиях.
 * Запуск: node tools/review/fix-f4-check-index.test.mjs  (нужен Python 3)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { test, withTempDir } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'rust-autowipe', 'plugin.json'), 'utf8')).version;
const FRONTEND_VERSION = /\bversion\s*:\s*(['"`])(\d+\.\d+\.\d+)\1/;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const probe = spawnSync(cmd, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return cmd;
  }
  return null;
}
const PYTHON = findPython();

function python(dir, args) {
  const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', ...args], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`.split(dir).join('<копия>').trim() };
}

/** Согласованная копия: пакет собран pack.py из тех же исходников. */
function makeCopy(base) {
  const dir = path.join(base, 'copy');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'));
  for (const file of ['check_index.py', 'catalyst_manifest.py', 'pack.py']) {
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(dir, 'tools', file));
  }
  fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(dir, 'rust-autowipe'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(dir, 'CHANGELOG.md'));
  const built = python(dir, [path.join('tools', 'pack.py'), '--skip-check']);
  assert.equal(built.status, 0, `pack.py в копии упал: ${built.out}`);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const zipName = path.posix.basename(new URL(index.plugins[0].downloadUrl).pathname);
  return { dir, zip: path.join(dir, 'dist', zipName) };
}

const check = (dir) => python(dir, [path.join('tools', 'check_index.py')]);

/** Переписать файлы внутри пакета (имя → текст или null — убрать) и пересчитать sha256 всюду. */
function rewritePackage({ dir, zip }, changes) {
  const before = sha(fs.readFileSync(zip));
  // Правки — через файл, а не аргументом: длинный исходник не влезает в командную
  // строку Windows (около 32 тысяч символов).
  const changesFile = path.join(path.dirname(zip), '..', '.rewrite-changes.json');
  fs.writeFileSync(changesFile, JSON.stringify(changes), 'utf8');
  const script = [
    'import json, sys, zipfile',
    'path = sys.argv[1]',
    'with open(sys.argv[2], encoding="utf-8") as f: changes = json.load(f)',
    'src = zipfile.ZipFile(path); files = {i.filename: src.read(i) for i in src.infolist()}; src.close()',
    'for name, text in changes.items():',
    '    if text is None: files.pop(name, None)',
    '    else: files[name] = text.encode("utf-8")',
    'with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as out:',
    '    for name in sorted(files): out.writestr(name, files[name])',
  ].join('\n');
  const result = spawnSync(PYTHON, ['-I', '-c', script, zip, changesFile], { encoding: 'utf8' });
  fs.rmSync(changesFile, { force: true });
  assert.equal(result.status, 0, `не удалось переписать пакет: ${result.stderr ?? result.error}`);
  const after = sha(fs.readFileSync(zip));
  const indexPath = path.join(dir, 'index.json');
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').split(before).join(after));
  fs.writeFileSync(`${zip}.sha256`, `${after}  ${path.basename(zip)}\n`);
}

const sourcePath = (dir, rel) => path.join(dir, 'rust-autowipe', ...rel.split('/'));

/** Убрать из CHANGELOG первый раздел «## X.Y.Z» — как будто запись забыли. */
function dropTopSection(changelog) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => /^##\s+\d+\.\d+\.\d+/.test(line));
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** Каждый случай: своя согласованная копия, одна поломка, ожидаемая причина. */
const CASES = [
  {
    name: 'код в пакете подменён (sha256 пересчитана)',
    spoil: (copy) =>
      rewritePackage(copy, {
        'backend/index.js': `${fs.readFileSync(sourcePath(copy.dir, 'backend/index.js'), 'utf8')}\nglobalThis.tampered = 1;\n`,
      }),
    reason: /отличается от rust-autowipe\/: backend\/index\.js/,
  },
  {
    name: 'в пакете лишний файл',
    spoil: (copy) => rewritePackage(copy, { 'backend/lib/extra.js': 'export const extra = 1;\n' }),
    reason: /лишнее в пакете \(нет в rust-autowipe\/\): backend\/lib\/extra\.js/,
  },
  {
    name: 'в исходниках новый файл, а пакет старый',
    spoil: ({ dir }) => fs.writeFileSync(sourcePath(dir, 'backend/lib/added.js'), 'export {};\n'),
    reason: /нет в пакете: backend\/lib\/added\.js/,
  },
  {
    name: 'исходник поправлен после сборки пакета',
    spoil: ({ dir }) => fs.appendFileSync(sourcePath(dir, 'backend/lib/wipe.js'), '\n// правка\n'),
    reason: /отличается от rust-autowipe\/: backend\/lib\/wipe\.js/,
  },
  {
    name: 'в CHANGELOG.md нет записи текущей версии',
    spoil: ({ dir }) => {
      const file = path.join(dir, 'CHANGELOG.md');
      fs.writeFileSync(file, dropTopSection(fs.readFileSync(file, 'utf8')));
    },
    reason: new RegExp(`CHANGELOG\\.md: верхняя запись — [\\d.]+, а version в plugin\\.json — ${escape(VERSION)}`),
  },
  {
    name: 'CHANGELOG.md нет вовсе',
    spoil: ({ dir }) => fs.rmSync(path.join(dir, 'CHANGELOG.md')),
    reason: /CHANGELOG\.md: файл не найден/,
  },
  {
    name: 'во frontend.mjs осталась прошлая версия (и в пакете тоже)',
    spoil: ({ dir }) => {
      const file = sourcePath(dir, 'frontend/frontend.mjs');
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(FRONTEND_VERSION.test(text), 'во frontend.mjs нет константы version');
      fs.writeFileSync(file, text.replace(FRONTEND_VERSION, (_, quote) => `version: ${quote}0.0.1${quote}`));
      // Пакет пересобран из этих же исходников: падать должно только из-за версии.
      const rebuilt = python(dir, [path.join('tools', 'pack.py'), '--skip-check', '--allow-repack']);
      assert.equal(rebuilt.status, 0, `pack.py не пересобрал пакет: ${rebuilt.out}`);
    },
    reason: new RegExp(`frontend\\.mjs: version 0\\.0\\.1, а в plugin\\.json — ${escape(VERSION)}`),
  },
];

test('контроль: согласованная копия проходит check_index.py', async () => {
  assert.ok(PYTHON, 'Python 3 не найден — проверка не выполнена');
  await withTempDir(async (base) => {
    const { dir } = makeCopy(base);
    const { status, out } = check(dir);
    assert.equal(status, 0, `check_index.py упал на согласованной копии: ${out}`);
  }, { prefix: 'rw-fix-f4-index-' });
}, { timeoutMs: 120_000 });

test('контроль: диапазон в заголовке CHANGELOG.md засчитывается по последней версии', async () => {
  assert.ok(PYTHON, 'Python 3 не найден — проверка не выполнена');
  await withTempDir(async (base) => {
    const { dir } = makeCopy(base);
    const file = path.join(dir, 'CHANGELOG.md');
    const text = fs.readFileSync(file, 'utf8');
    const heading = new RegExp(`^##\\s+${escape(VERSION)}\\b`, 'm');
    assert.ok(heading.test(text), `в CHANGELOG.md нет раздела ${VERSION}`);
    fs.writeFileSync(file, text.replace(heading, `## 0.0.9–${VERSION}`));
    const { status, out } = check(dir);
    assert.equal(status, 0, `check_index.py не принял диапазон «0.0.9–${VERSION}»: ${out}`);
  }, { prefix: 'rw-fix-f4-index-' });
}, { timeoutMs: 120_000 });

for (const item of CASES) {
  test(`check_index.py падает: ${item.name}`, async () => {
    assert.ok(PYTHON, 'Python 3 не найден — проверка не выполнена');
    await withTempDir(async (base) => {
      const copy = makeCopy(base);
      item.spoil(copy);
      const { status, out } = check(copy.dir);
      assert.notEqual(status, 0, `check_index.py прошёл: ${out}`);
      assert.match(out, item.reason, `нет нужной причины в выводе:\n${out}`);
      const reasons = out.split('\n').filter((line) => line.trim().startsWith('- '));
      assert.equal(reasons.length, 1, `ожидалась одна причина, а их ${reasons.length}:\n${out}`);
    }, { prefix: 'rw-fix-f4-index-' });
  }, { timeoutMs: 120_000 });
}
