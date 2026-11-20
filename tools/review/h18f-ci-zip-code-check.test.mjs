/**
 * Ревью RustWipe, гипотеза 18 (раздел 4.2), утверждение H18f:
 * CI не сверяет код внутри zip с исходниками, которые он тестирует.
 * tools/test.mjs и tools/ui-smoke.mjs проверяют rust-autowipe/, а пакет из dist/
 * (его и ставят панели) смотрит только tools/check_index.py — по sha256, составу
 * и plugin.json, но не по коду.
 *
 * Правильное поведение: если в пакете другой код, чем в rust-autowipe/, проверка
 * пакета в CI падает — даже когда sha256 в index.json и .sha256 пересчитаны.
 *
 * Как проверяется: во временной папке (os.tmpdir, mkdtemp) — копия check_index.py,
 * catalyst_manifest.py, pack.py, rust-autowipe/ и CHANGELOG.md; пакет и index.json собирает
 * pack.py в этой копии из тех же исходников. В пакете меняется backend/index.js,
 * sha256 пересчитывается (как сделал бы обычный push), затем запускается
 * `python -I -X utf8 tools/check_index.py` в этой копии.
 * Контроль: на неизменённой копии та же проверка проходит.
 *
 * Правка исполнителя F4: раньше в копию клали закоммиченный пакет из dist/.
 * На ветке с правками кода без новой версии он законно отличается от исходников,
 * и исправленный check_index.py (он теперь сверяет пакет с исходниками) падал
 * бы уже на контроле. Поэтому пакет собирается в копии. Суть проверки та же:
 * подменённый код в пакете с пересчитанной sha256 должен ронять проверку.
 *
 * Запуск: node tools/review/h18f-ci-zip-code-check.test.mjs  (нужен Python 3)
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

// ── Python и временная копия проекта ────────────────────────────────────────
function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const probe = spawnSync(cmd, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '3') return cmd;
  }
  return null;
}
const PYTHON = findPython();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const temps = [];

function makeCopy() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-h18f-'));
  temps.push(base);
  fs.mkdirSync(path.join(base, 'tools'));
  fs.mkdirSync(path.join(base, 'dist'));
  for (const file of ['check_index.py', 'catalyst_manifest.py', 'pack.py']) {
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(base, 'tools', file));
  }
  fs.cpSync(path.join(ROOT, 'rust-autowipe'), path.join(base, 'rust-autowipe'), { recursive: true });
  // check_index.py сверяет версию и с CHANGELOG.md — копия получает и его.
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(base, 'CHANGELOG.md'));
  // Пакет, sha256 и index.json собираются из этих же исходников (pack.py в копии).
  const built = spawnSync(PYTHON, ['-I', '-X', 'utf8', path.join('tools', 'pack.py'), '--skip-check'], {
    cwd: base,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) {
    const out = `${built.stdout}
${built.stderr}`.split(base).join('<копия>').trim();
    throw new Error(`pack.py в копии упал (код ${built.status}): ${out}`);
  }
  const index = JSON.parse(fs.readFileSync(path.join(base, 'index.json'), 'utf8'));
  const entry = (index.plugins || index)[0];
  const zipName = path.posix.basename(new URL(entry.downloadUrl).pathname);
  return { base, zipName, oldSha: entry.sha256 };
}

function runCheckIndex(base) {
  const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', path.join('tools', 'check_index.py')], {
    cwd: base,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const clean = (text) => String(text || '').split(base).join('<копия>').trim();
  return { status: result.status, out: clean(`${result.stdout}\n${result.stderr}`) };
}

test('контроль: на неизменённой копии check_index.py проходит', () => {
  check(PYTHON, 'Python 3 не найден — проверка не выполнена');
  const { base } = makeCopy();
  const { status, out } = runCheckIndex(base);
  check(status === 0, `check_index.py упал на чистой копии (код ${status}): ${out}`);
});

test('CI-проверка пакета падает, если код в zip не совпадает с исходниками', () => {
  check(PYTHON, 'Python 3 не найден — проверка не выполнена');
  const { base, zipName, oldSha } = makeCopy();
  const zipPath = path.join(base, 'dist', zipName);
  const files = readZip(fs.readFileSync(zipPath)).map((file) =>
    file.name === 'backend/index.js'
      ? { name: file.name, data: Buffer.concat([file.data, Buffer.from('\nglobalThis.reviewTampered = true;\n')]) }
      : file,
  );
  const tampered = writeZip(files);
  fs.writeFileSync(zipPath, tampered);
  const newSha = sha256(tampered);
  // Как при обычном push: сумма в index.json и .sha256 пересчитана под новый архив.
  const indexPath = path.join(base, 'index.json');
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').split(oldSha).join(newSha));
  fs.writeFileSync(`${zipPath}.sha256`, `${newSha}  ${zipName}\n`);
  const source = fs.readFileSync(path.join(base, 'rust-autowipe', 'backend', 'index.js'));
  check(!source.equals(files.find((f) => f.name === 'backend/index.js').data), 'подмена не удалась');

  const { status, out } = runCheckIndex(base);
  const firstLine = out.split('\n')[0];
  check(
    status !== 0,
    `check_index.py прошёл (код ${status}: «${firstLine}»), хотя backend/index.js в ${zipName} ≠ rust-autowipe/backend/index.js`,
  );
});

// Остальные шаги ci.yml пакет не открывают вовсе — для отчёта.
for (const file of ['test.mjs', 'ui-smoke.mjs']) {
  const text = fs.readFileSync(path.join(ROOT, 'tools', file), 'utf8');
  const touches = /catpkg|['"`/]dist['"`/]/.test(text);
  console.log(`  инфо  tools/${file} ${touches ? 'упоминает пакет из dist/' : 'не читает пакет из dist/'}`);
}
console.log(`H18f: Python — ${PYTHON ?? 'не найден'}`);

// Уборка временных папок — при любом выходе, в том числе если тест завис.
process.on('exit', () => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});
runAll();
