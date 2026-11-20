/**
 * Исправление F4 для H18g: tools/pack.py собирает пакет воспроизводимо и
 * сравнивает уже собранный пакет той же версии по содержимому.
 *
 * Что проверяется (копии проекта во временных папках, python -I):
 *   - у записей архива постоянные дата (1980-01-01), права (0o100644),
 *     система «Unix» и порядок по имени — от дат и прав файлов на диске
 *     архив не зависит;
 *   - пакет той же версии с теми же файлами, но сжатый иначе (как другим zlib),
 *     остаётся как есть: байты и sha256 в index.json не меняются;
 *   - пакет той же версии с другим содержимым — сборка останавливается,
 *     пакет на диске не меняется; с --allow-repack — заменяется.
 *
 * Пакеты в dist/ проекта и index.json не трогаются: всё — в копиях.
 * Запуск: node tools/review/fix-f4-pack.test.mjs  (нужен Python 3)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { test, withTempDir } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const probe = spawnSync(cmd, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return cmd;
  }
  return null;
}
const PYTHON = findPython();

function setTimesAndModes(dir, when, mode) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) setTimesAndModes(full, when, mode);
    else {
      fs.chmodSync(full, mode);
      fs.utimesSync(full, when, when);
    }
  }
}

/** Копия: tools/pack.py, tools/catalyst_manifest.py, rust-autowipe/ и пустой dist/. */
function makeCopy(base, name, when, mode) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'));
  for (const file of ['pack.py', 'catalyst_manifest.py']) {
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(dir, 'tools', file));
  }
  fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(dir, 'rust-autowipe'), { recursive: true });
  setTimesAndModes(path.join(dir, 'rust-autowipe'), when, mode);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'rust-autowipe', 'plugin.json'), 'utf8'));
  return { dir, zip: path.join(dir, 'dist', `${manifest.name}-${manifest.version}.catpkg.zip`) };
}

function pack(dir, ...args) {
  const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', path.join('tools', 'pack.py'), '--skip-check', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`.split(dir).join('<копия>').trim() };
}

/** Записи центрального каталога zip: имя, дата, время, система, права. */
function centralEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'не zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    const madeBy = buf.readUInt16LE(p + 4);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const nameLen = buf.readUInt16LE(p + 28);
    const attr = buf.readUInt32LE(p + 38);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), system: madeBy >> 8, date, time, mode: attr >>> 16 });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

const JAN = new Date('2026-01-10T08:00:00Z');
const JUN = new Date('2026-06-20T15:30:00Z');

test('архив не зависит от дат и прав файлов; у записей постоянные свойства', async () => {
  assert.ok(PYTHON, 'Python 3 не найден — проверка не выполнена');
  await withTempDir(async (base) => {
    const a = makeCopy(base, 'a', JAN, 0o644);
    const b = makeCopy(base, 'b', JUN, 0o755);
    for (const copy of [a, b]) {
      const { status, out } = pack(copy.dir);
      assert.equal(status, 0, `pack.py упал: ${out}`);
    }
    const zipA = fs.readFileSync(a.zip);
    const zipB = fs.readFileSync(b.zip);
    assert.equal(sha(zipA), sha(zipB), 'одинаковые исходники дали разные архивы');
    const entries = centralEntries(zipA);
    const names = entries.map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort(), 'записи не по порядку имён');
    for (const entry of entries) {
      assert.equal(entry.date, (0 << 9) | (1 << 5) | 1, `${entry.name}: дата не 1980-01-01`);
      assert.equal(entry.time, 0, `${entry.name}: время не 00:00`);
      assert.equal(entry.system, 3, `${entry.name}: система не Unix`);
      assert.equal(entry.mode, 0o100644, `${entry.name}: права ${entry.mode.toString(8)}`);
    }
  }, { prefix: 'rw-fix-f4-pack-' });
}, { timeoutMs: 120_000 });

test('тот же пакет, сжатый иначе, остаётся как есть; другой — сборка останавливается', async () => {
  assert.ok(PYTHON, 'Python 3 не найден — проверка не выполнена');
  await withTempDir(async (base) => {
    const copy = makeCopy(base, 'c', JAN, 0o644);
    let result = pack(copy.dir);
    assert.equal(result.status, 0, `первая сборка упала: ${result.out}`);

    // Те же файлы без сжатия — как пакет, собранный другим zlib: байты другие, содержимое то же.
    const restore = spawnSync(
      PYTHON,
      [
        '-I',
        '-c',
        'import sys, zipfile\n' +
          'src = zipfile.ZipFile(sys.argv[1]); files = [(i, src.read(i)) for i in src.infolist()]; src.close()\n' +
          'with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_STORED) as out:\n' +
          '    for info, data in files: out.writestr(info.filename, data)\n',
        copy.zip,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(restore.status, 0, `не удалось пересжать пакет: ${restore.stderr}`);
    const stored = fs.readFileSync(copy.zip);
    result = pack(copy.dir);
    assert.equal(result.status, 0, `сборка при том же содержимом упала: ${result.out}`);
    assert.match(result.out, /оставлен как есть/);
    assert.equal(sha(fs.readFileSync(copy.zip)), sha(stored), 'пакет с тем же содержимым перезаписан');
    const index = JSON.parse(fs.readFileSync(path.join(copy.dir, 'index.json'), 'utf8'));
    assert.equal(index.plugins[0].sha256, sha(stored), 'в index.json не sha256 оставленного пакета');
    const sidecar = fs.readFileSync(`${copy.zip}.sha256`, 'utf8').split(/\s+/)[0];
    assert.equal(sidecar, sha(stored), '.sha256 не совпадает с оставленным пакетом');

    // Другое содержимое при той же версии — отказ, пакет не меняется.
    fs.appendFileSync(path.join(copy.dir, 'rust-autowipe', 'backend', 'index.js'), '\n// правка без новой версии\n');
    result = pack(copy.dir);
    assert.notEqual(result.status, 0, `сборка с другим содержимым прошла: ${result.out}`);
    assert.match(result.out, /уже собран с другим содержимым/);
    assert.equal(sha(fs.readFileSync(copy.zip)), sha(stored), 'пакет изменился, хотя сборка остановлена');
    assert.deepEqual(fs.readdirSync(path.join(copy.dir, 'dist')).filter((name) => name.includes('.tmp')), [], 'остался временный файл');

    // С --allow-repack — пакет заменяется новым содержимым.
    result = pack(copy.dir, '--allow-repack');
    assert.equal(result.status, 0, `сборка с --allow-repack упала: ${result.out}`);
    assert.notEqual(sha(fs.readFileSync(copy.zip)), sha(stored), 'с --allow-repack пакет не заменён');
  }, { prefix: 'rw-fix-f4-pack-' });
}, { timeoutMs: 120_000 });
