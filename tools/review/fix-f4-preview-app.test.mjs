/**
 * Исправление F4 для L32-10: стенд tools/preview-app.mjs отдаёт только свои
 * два файла из .preview/ и только при локальном заголовке Host.
 *
 * Сервер не запускается: обработчик servePreview вызывается с подставными
 * req/res, а http.Server#listen на время импорта подменён — импорт не должен
 * ни слушать порт, ни писать в .preview/. Файлы — во временной папке:
 * .preview/ со стендом и «секрет» рядом (.github-token), как в корне проекта.
 *
 * Запуск: node tools/review/fix-f4-preview-app.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, withTempDir } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = `review-token-${Date.now().toString(36)}`;

/** Подставной ответ: код, заголовки и тело. */
function fakeResponse() {
  const res = {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      res.status = status;
      Object.assign(res.headers, headers);
      return res;
    },
    end(chunk = '') {
      res.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      return res;
    },
  };
  return res;
}

let imported = null;
async function loadPreview() {
  if (imported) return imported;
  const listenCalls = [];
  const previewExisted = fs.existsSync(path.join(ROOT, '.preview'));
  const realListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function fakeListen(...args) {
    listenCalls.push(args);
    return this;
  };
  try {
    const module = await import('../preview-app.mjs');
    imported = { module, listenCalls, previewExisted, previewExistsNow: fs.existsSync(path.join(ROOT, '.preview')) };
  } finally {
    http.Server.prototype.listen = realListen;
  }
  return imported;
}

test('импорт стенда не запускает сервер и не пишет в .preview/', async () => {
  const { module, listenCalls, previewExisted, previewExistsNow } = await loadPreview();
  assert.equal(listenCalls.length, 0, 'импорт запустил сервер (listen)');
  if (!previewExisted) assert.equal(previewExistsNow, false, 'импорт создал папку .preview/');
  assert.equal(typeof module.servePreview, 'function', 'нет обработчика servePreview');
});

test('отдаются только index.html и frontend.mjs; файлы вне .preview/ — нет', async () => {
  const { module } = await loadPreview();
  await withTempDir(async (base) => {
    const dir = path.join(base, '.preview');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>стенд</title>');
    fs.writeFileSync(path.join(dir, 'frontend.mjs'), 'export default {};');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'служебный файл стенда');
    fs.writeFileSync(path.join(base, '.github-token'), SECRET);
    const secretUrl = `/${path.join(base, '.github-token').split(path.sep).join('/')}`;
    const call = (url, host = '127.0.0.1:4173', method = 'GET') => {
      const res = fakeResponse();
      module.servePreview({ url, method, headers: { host } }, res, dir);
      return res;
    };

    for (const [url, type] of [
      ['/', 'text/html'],
      ['/index.html?v=1', 'text/html'],
      ['/frontend.mjs', 'text/javascript'],
    ]) {
      const res = call(url);
      assert.equal(res.status, 200, `${url}: код ${res.status}`);
      assert.ok(String(res.headers['content-type']).startsWith(type), `${url}: тип ${res.headers['content-type']}`);
    }
    assert.equal(call('/', 'localhost:4173').status, 200, 'Host localhost не принят');

    for (const url of ['/../.github-token', '/..%2f.github-token', '/%2e%2e/.github-token', '//../.github-token', secretUrl, '/notes.txt']) {
      const res = call(url);
      assert.equal(res.status, 404, `${url}: код ${res.status}, а нужен 404`);
      assert.ok(!res.body.includes(SECRET), `${url}: отдан секрет`);
    }
    assert.equal(call('/frontend.mjs', '127.0.0.1', 'POST').status, 404, 'POST принят');
  }, { prefix: 'rw-fix-f4-preview-' });
});

test('запуск через node по-прежнему готовит стенд и слушает только 127.0.0.1', async () => {
  // Копия во временной папке; listen подменён заранее (node --import): порт не занимается.
  await withTempDir(async (base) => {
    fs.mkdirSync(path.join(base, 'tools'));
    fs.mkdirSync(path.join(base, 'rust-autowipe', 'frontend'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools', 'preview-app.mjs'), path.join(base, 'tools', 'preview-app.mjs'));
    fs.copyFileSync(
      path.join(ROOT, 'rust-autowipe', 'frontend', 'frontend.mjs'),
      path.join(base, 'rust-autowipe', 'frontend', 'frontend.mjs'),
    );
    const logPath = path.join(base, 'listen.json');
    const preload = path.join(base, 'no-listen.mjs');
    fs.writeFileSync(
      preload,
      [
        "import fs from 'node:fs';",
        "import http from 'node:http';",
        'http.Server.prototype.listen = function fakeListen(port, host) {',
        `  fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ port, host }));`,
        '  return this;',
        '};',
      ].join('\n'),
    );
    const { pathToFileURL } = await import('node:url');
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(base, 'tools', 'preview-app.mjs'), '4999'], {
      cwd: base,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `стенд упал: ${result.stderr}`);
    assert.ok(fs.existsSync(logPath), 'запуск через node не вызвал listen');
    assert.deepEqual(JSON.parse(fs.readFileSync(logPath, 'utf8')), { port: 4999, host: '127.0.0.1' });
    for (const file of ['index.html', 'frontend.mjs']) {
      assert.ok(fs.existsSync(path.join(base, '.preview', file)), `стенд не создал .preview/${file}`);
    }
  }, { prefix: 'rw-fix-f4-preview-' });
}, { timeoutMs: 60_000 });

test('чужой Host — 403 (защита от подмены адреса через DNS)', async () => {
  const { module } = await loadPreview();
  for (const host of ['evil.example', 'evil.example:4173', '', '127.0.0.1.evil.example']) {
    const res = fakeResponse();
    module.servePreview({ url: '/', method: 'GET', headers: { host } }, res, ROOT);
    assert.equal(res.status, 403, `Host «${host}»: код ${res.status}`);
  }
});
