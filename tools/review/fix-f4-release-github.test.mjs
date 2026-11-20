/**
 * Исправление F4 для L34-11 (часть про tools/release_github.mjs): выпуск
 * создаётся только из коммита на GitHub, где index.json ведёт ровно на этот
 * пакет, метка ставится на этот коммит по SHA, а уже загруженный файл
 * сверяется по sha256 и не заменяется.
 *
 * Как проверяется: копия скрипта во временной папке (tools/release_github.mjs,
 * rust-autowipe/plugin.json, dist/<пакет>). Сеть подменена: node --import
 * с модулем-подменой fetch отвечает как GitHub API по описанию состояния
 * (есть ли метка, что лежит в index.json на main, есть ли выпуск и файл),
 * net/tls/http/https запрещены. Токен фиктивный, --no-meta.
 *
 * Запуск: node tools/review/fix-f4-release-github.test.mjs
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { test, withTempDir } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'rust-autowipe', 'plugin.json'), 'utf8'));
const VERSION = MANIFEST.version;
const TAG = `v${VERSION}`;
const PKG = `${MANIFEST.name}-${VERSION}.catpkg.zip`;
const PKG_BYTES = Buffer.from('пакет для проверки выпуска\n');
const PKG_SHA = crypto.createHash('sha256').update(PKG_BYTES).digest('hex');
const MAIN_SHA = 'a'.repeat(40);
const TAG_SHA = 'b'.repeat(40);

const MOCK = `
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
const LOG = process.env.REVIEW_MOCK_LOG;
const S = JSON.parse(process.env.REVIEW_MOCK_STATE);
const state = { loaded: true, calls: [], blocked: [] };
const save = () => fs.writeFileSync(LOG, JSON.stringify(state));
save();
const deny = (what) => function denied() {
  state.blocked.push(what);
  save();
  throw new Error('настоящая сеть в тесте запрещена: ' + what);
};
net.connect = deny('net.connect');
net.createConnection = deny('net.createConnection');
net.Socket.prototype.connect = deny('net.Socket#connect');
tls.connect = deny('tls.connect');
http.request = deny('http.request');
http.get = deny('http.get');
https.request = deny('https.request');
https.get = deny('https.get');
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  let body = init.body ?? null;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  else if (body) body = '<байты>';
  state.calls.push({ host: url.host, method, path: url.pathname, search: url.search, body });
  save();
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const p = url.pathname;
  const repo = '/repos/kafder100/RustWipe';
  if (method === 'GET' && p === repo + '/git/ref/tags/' + S.tag) {
    return S.tagCommit ? json(200, { object: { type: 'commit', sha: S.tagCommit } }) : json(404, { message: 'Not Found' });
  }
  if (method === 'GET' && p === repo + '/git/ref/heads/main') return json(200, { object: { type: 'commit', sha: S.mainSha } });
  if (method === 'GET' && p === repo + '/contents/index.json') {
    const ref = url.searchParams.get('ref');
    const index = S.indexByCommit[ref];
    if (!index) return json(404, { message: 'нет index.json в коммите ' + ref });
    return json(200, { content: Buffer.from(JSON.stringify(index)).toString('base64'), encoding: 'base64' });
  }
  if (method === 'GET' && p === repo + '/releases/tags/' + S.tag) {
    return S.release ? json(200, { id: 1, html_url: 'https://example.invalid/release' }) : json(404, { message: 'Not Found' });
  }
  if (method === 'POST' && p === repo + '/releases') return json(201, { id: 1, html_url: 'https://example.invalid/release' });
  if (method === 'GET' && p === repo + '/releases/1/assets') {
    return json(200, (S.release?.assets || []).map((a) => ({ id: a.id, name: a.name, size: 1, browser_download_url: 'https://example.invalid/' + a.name })));
  }
  const asset = (S.release?.assets || []).find((a) => p === repo + '/releases/assets/' + a.id);
  if (method === 'GET' && asset) return new Response(Buffer.from(asset.base64, 'base64'), { status: 200 });
  if (method === 'POST' && url.host === 'uploads.github.com') return json(201, { browser_download_url: 'https://example.invalid/asset', size: 1 });
  return json(404, { message: 'нет в подмене: ' + method + ' ' + p });
};
`;

function makeCopy(base) {
  const dir = path.join(base, 'proj');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'rust-autowipe'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'release_github.mjs'), path.join(dir, 'tools', 'release_github.mjs'));
  fs.copyFileSync(path.join(ROOT, 'rust-autowipe', 'plugin.json'), path.join(dir, 'rust-autowipe', 'plugin.json'));
  fs.writeFileSync(path.join(dir, 'dist', PKG), PKG_BYTES);
  fs.writeFileSync(path.join(base, 'mock-fetch.mjs'), MOCK);
  return dir;
}

function run(base, dir, githubState) {
  const logPath = path.join(base, 'calls.json');
  fs.rmSync(logPath, { force: true });
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|CRED|^NODE_OPTIONS$/i.test(key)) continue;
    env[key] = value;
  }
  env.GITHUB_TOKEN = 'review-fake-token';
  env.REVIEW_MOCK_LOG = logPath;
  env.REVIEW_MOCK_STATE = JSON.stringify({ tag: TAG, ...githubState });
  const mock = pathToFileURL(path.join(base, 'mock-fetch.mjs')).href;
  const result = spawnSync(process.execPath, ['--import', mock, path.join(dir, 'tools', 'release_github.mjs'), '--no-meta'], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : null;
  assert.ok(log && log.loaded, 'подмена сети не загрузилась');
  assert.deepEqual(log.blocked, [], 'были попытки настоящих соединений');
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`.split(base).join('<врем>'), calls: log.calls };
}

const entry = (version, sha256) => ({ schemaVersion: 1, plugins: [{ name: MANIFEST.name, version, sha256 }] });
const created = (calls) => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/releases'));
const uploads = (calls) => calls.filter((call) => call.method === 'POST' && call.host === 'uploads.github.com');

test('main на GitHub со старой версией: выпуск не создаётся', async () => {
  await withTempDir(async (base) => {
    const dir = makeCopy(base);
    const { status, out, calls } = run(base, dir, {
      tagCommit: null,
      mainSha: MAIN_SHA,
      indexByCommit: { [MAIN_SHA]: entry('0.0.1', 'c'.repeat(64)) },
      release: null,
    });
    assert.notEqual(status, 0, `скрипт завершился с кодом 0: ${out}`);
    assert.match(out, /сначала отправьте коммит выпуска в main/);
    assert.equal(created(calls).length, 0, 'выпуск создан, хотя в main другой пакет');
    assert.equal(uploads(calls).length, 0, 'файл загружен');
  }, { prefix: 'rw-fix-f4-release-' });
}, { timeoutMs: 60_000 });

test('main с этим же пакетом: метка ставится на его коммит по SHA', async () => {
  await withTempDir(async (base) => {
    const dir = makeCopy(base);
    const { status, out, calls } = run(base, dir, {
      tagCommit: null,
      mainSha: MAIN_SHA,
      indexByCommit: { [MAIN_SHA]: entry(VERSION, PKG_SHA) },
      release: null,
    });
    assert.equal(status, 0, `скрипт упал: ${out}`);
    const [release] = created(calls);
    assert.ok(release, 'выпуск не создан');
    assert.equal(release.body.tag_name, TAG);
    assert.equal(release.body.target_commitish, MAIN_SHA, 'метка не на проверенном коммите');
    assert.equal(uploads(calls).length, 1, 'файл не загружен');
  }, { prefix: 'rw-fix-f4-release-' });
}, { timeoutMs: 60_000 });

test('метка уже стоит на коммите с другим пакетом: выпуск не создаётся', async () => {
  await withTempDir(async (base) => {
    const dir = makeCopy(base);
    const { status, out, calls } = run(base, dir, {
      tagCommit: TAG_SHA,
      mainSha: MAIN_SHA,
      indexByCommit: { [TAG_SHA]: entry(VERSION, 'd'.repeat(64)), [MAIN_SHA]: entry(VERSION, PKG_SHA) },
      release: null,
    });
    assert.notEqual(status, 0, `скрипт завершился с кодом 0: ${out}`);
    assert.match(out, /метка стоит не на коммите этого пакета/);
    assert.equal(created(calls).length, 0, 'выпуск создан на чужом коммите');
  }, { prefix: 'rw-fix-f4-release-' });
}, { timeoutMs: 60_000 });

test('в выпуске уже другой файл с тем же именем: ошибка, файл не заменяется', async () => {
  await withTempDir(async (base) => {
    const dir = makeCopy(base);
    const { status, out, calls } = run(base, dir, {
      tagCommit: TAG_SHA,
      mainSha: MAIN_SHA,
      indexByCommit: { [TAG_SHA]: entry(VERSION, PKG_SHA) },
      release: { assets: [{ id: 7, name: PKG, base64: Buffer.from('другой пакет').toString('base64') }] },
    });
    assert.notEqual(status, 0, `скрипт завершился с кодом 0: ${out}`);
    assert.match(out, /уже есть другой/);
    assert.equal(uploads(calls).length, 0, 'файл загружен поверх');
  }, { prefix: 'rw-fix-f4-release-' });
}, { timeoutMs: 60_000 });

test('контроль: в выпуске уже этот же файл — ничего не меняется', async () => {
  await withTempDir(async (base) => {
    const dir = makeCopy(base);
    const { status, out, calls } = run(base, dir, {
      tagCommit: TAG_SHA,
      mainSha: MAIN_SHA,
      indexByCommit: { [TAG_SHA]: entry(VERSION, PKG_SHA) },
      release: { assets: [{ id: 7, name: PKG, base64: PKG_BYTES.toString('base64') }] },
    });
    assert.equal(status, 0, `скрипт упал: ${out}`);
    assert.equal(created(calls).length, 0, 'выпуск пересоздан');
    assert.equal(uploads(calls).length, 0, 'файл загружен повторно');
  }, { prefix: 'rw-fix-f4-release-' });
}, { timeoutMs: 60_000 });
