/**
 * Ревью RustWipe, гипотеза 21 (раздел 4.2), утверждение H21b:
 * константа версии во frontend (rust-autowipe/frontend/frontend.mjs, объект
 * manifest, `version: '…'`) не сверяется с plugin.json — проверка в CI
 * (tools/check_index.py) её не читает.
 *
 * Правильное поведение (правила ревью, раздел 3.4 «версии сходятся»): каждая
 * `version: 'X.Y.Z'` во frontend равна version из plugin.json (или её нет вовсе),
 * а если её забыли поднять, проверка в CI падает.
 *
 * Как проверяется: (1) сверка в рабочей копии; (2) во временной папке (os.tmpdir,
 * mkdtemp) копия check_index.py, catalyst_manifest.py, rust-autowipe/, CHANGELOG.md,
 * index.json и пакета, где во frontend.mjs (и в исходнике, и в zip) осталась прошлая версия;
 * sha256 пакета пересчитан. Затем `python -I -X utf8 tools/check_index.py`.
 *
 * Запуск: node tools/review/h21b-frontend-version.test.mjs  (нужен Python 3)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

// ── zip: чтение и запись без зависимостей ───────────────────────────────────
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('не zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n += 1) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lp = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.subarray(start, start + compSize);
    files.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function writeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x21, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(comp.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
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
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const VERSION_LITERAL = /\bversion\s*:\s*(['"`])(\d+\.\d+\.\d+)\1/g;
const FRONTEND = path.join(ROOT, 'rust-autowipe', 'frontend', 'frontend.mjs');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'rust-autowipe', 'plugin.json'), 'utf8'));
const frontendText = fs.readFileSync(FRONTEND, 'utf8');
const literals = [...frontendText.matchAll(VERSION_LITERAL)].map((m) => m[2]);

/** Прошлая версия: X.Y.(Z-1), а при Z = 0 — X.(Y-1).9 или (X-1).9.9. */
function previous(version) {
  const [x, y, z] = version.split('.').map(Number);
  if (z > 0) return `${x}.${y}.${z - 1}`;
  if (y > 0) return `${x}.${y - 1}.9`;
  return `${Math.max(x - 1, 0)}.9.9`;
}

test('версия во frontend = version из plugin.json', () => {
  const wrong = literals.filter((value) => value !== manifest.version);
  check(wrong.length === 0, `frontend.mjs: ${wrong.join(', ')}, plugin.json: ${manifest.version}`);
});

test('проверка в CI (check_index.py) падает, если во frontend осталась прошлая версия', () => {
  check(PYTHON, 'Python 3 не найден — проверка не выполнена');
  check(literals.length > 0, 'во frontend нет константы версии — расходиться нечему');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-h21b-'));
  temps.push(base);
  fs.mkdirSync(path.join(base, 'tools'));
  fs.mkdirSync(path.join(base, 'dist'));
  for (const file of ['check_index.py', 'catalyst_manifest.py']) {
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(base, 'tools', file));
  }
  fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(base, 'rust-autowipe'), { recursive: true });
  // Правка F4: исправленный check_index.py читает и CHANGELOG.md — без него он упал бы
  // из-за пропавшего файла, а не из-за версии во frontend.
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(base, 'CHANGELOG.md'));
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'));
  const entry = (index.plugins || index)[0];
  const zipName = path.posix.basename(new URL(entry.downloadUrl).pathname);

  const old = previous(manifest.version);
  const downgrade = (text) => text.replace(VERSION_LITERAL, (_, q) => `version: ${q}${old}${q}`);
  const staleFrontend = downgrade(frontendText);
  fs.writeFileSync(path.join(base, 'rust-autowipe', 'frontend', 'frontend.mjs'), staleFrontend);
  // Пакет собран из тех же исходников: во frontend.mjs внутри zip — тоже прошлая версия.
  const files = readZip(fs.readFileSync(path.join(ROOT, 'dist', zipName))).map((file) =>
    file.name === 'frontend/frontend.mjs' ? { name: file.name, data: Buffer.from(staleFrontend, 'utf8') } : file,
  );
  const zip = writeZip(files);
  const digest = sha256(zip);
  fs.writeFileSync(path.join(base, 'dist', zipName), zip);
  fs.writeFileSync(path.join(base, 'dist', `${zipName}.sha256`), `${digest}  ${zipName}\n`);
  fs.writeFileSync(
    path.join(base, 'index.json'),
    fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8').split(entry.sha256).join(digest),
  );

  const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', path.join('tools', 'check_index.py')], {
    cwd: base,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const first = `${result.stdout}\n${result.stderr}`.split(base).join('<копия>').trim().split('\n')[0];
  check(
    result.status !== 0,
    `check_index.py прошёл (код ${result.status}: «${first}»), хотя во frontend ${old}, а в plugin.json ${manifest.version}`,
  );
});

console.log(`H21b: plugin.json ${manifest.version}, во frontend: ${literals.join(', ') || 'нет'}`);
runAll();
