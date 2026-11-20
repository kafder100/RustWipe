/**
 * Исправление F4 для H20a и H20c: tools/push_to_github.mjs берёт список файлов
 * у git и никогда не отправляет секреты.
 *
 * Что проверяется (каждый раз — копия скрипта во временной папке, сеть подменена):
 *   - без git скрипт отказывается и не делает ни одного запроса;
 *   - файлы, похожие на секреты (.env, .env.*, .github-token, *.pem, *.key),
 *     не уходят, даже если git их отслеживает, а --dry-run их называет;
 *   - файл, который git отслеживает, но .gitignore исключает, не уходит;
 *   - новый файл без правила в .gitignore уходит, удалённый локально — нет
 *     (публикация по-прежнему «зеркальная»).
 *
 * Сеть: дочерний процесс запускается с node --import <подмена>: fetch отвечает
 * как GitHub API и пишет журнал, net/tls/http/https запрещены. Токен фиктивный,
 * настоящие токены в дочерний процесс не передаются. Настройки git — пустые
 * (GIT_CONFIG_NOSYSTEM, пустой GIT_CONFIG_GLOBAL), поиск репозитория выше
 * временной папки запрещён (GIT_CEILING_DIRECTORIES).
 *
 * Запуск: node tools/review/fix-f4-push-files.test.mjs  (нужен git)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { test, withTempDir } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'push_to_github.mjs');

const MOCK = `
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
const LOG = process.env.REVIEW_MOCK_LOG;
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
let counter = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method || 'GET').toUpperCase();
  let body = init.body ?? null;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
  state.calls.push({ host: url.host, method, path: url.pathname, body });
  save();
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const p = url.pathname;
  const sha = (prefix) => (prefix + String(++counter)).padEnd(40, '0');
  if (method === 'GET' && p === '/user') return reply(200, { login: 'review-user' });
  if (method === 'GET' && /^\\/repos\\/[^/]+\\/[^/]+$/.test(p)) return reply(200, { full_name: p.slice(7), permissions: { push: true } });
  if (method === 'POST' && p.endsWith('/git/blobs')) return reply(201, { sha: sha('b') });
  if (method === 'POST' && p.endsWith('/git/trees')) return reply(201, { sha: sha('e') });
  if (method === 'GET' && p.includes('/git/ref/heads/')) return reply(200, { object: { sha: sha('a') } });
  if (method === 'POST' && p.endsWith('/git/commits')) return reply(201, { sha: sha('c') });
  if (method === 'PATCH' || method === 'POST' || method === 'PUT') return reply(200, {});
  return reply(404, { message: 'нет в подмене' });
};
`;

/** Окружение дочерних процессов: без настоящих токенов, git без чужих настроек. */
function baseEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|CRED|^NODE_OPTIONS$|^GIT_/i.test(key)) continue;
    env[key] = value;
  }
  const emptyConfig = path.join(base, 'empty.gitconfig');
  if (!fs.existsSync(emptyConfig)) fs.writeFileSync(emptyConfig, '');
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = emptyConfig;
  env.GIT_CEILING_DIRECTORIES = base;
  return env;
}

function git(base, proj, args) {
  const result = spawnSync('git', ['-C', proj, ...args], { env: baseEnv(base), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error}`);
}

/** «Проект» во временной папке: файлы, копия скрипта, подмена сети рядом. */
function makeProject(base, files, { gitInit = true } = {}) {
  const proj = path.join(base, 'proj');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(proj, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(path.join(proj, 'tools'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(proj, 'tools', 'push_to_github.mjs'));
  fs.writeFileSync(path.join(base, 'mock-fetch.mjs'), MOCK);
  if (gitInit) git(base, proj, ['init', '-q']);
  return proj;
}

function runPush(base, proj, args) {
  const logPath = path.join(base, 'calls.json');
  fs.rmSync(logPath, { force: true });
  const env = { ...baseEnv(base), GITHUB_TOKEN: 'review-fake-token', REVIEW_MOCK_LOG: logPath };
  const mock = pathToFileURL(path.join(base, 'mock-fetch.mjs')).href;
  const common = ['--owner', 'review-owner', '--repo', 'review-repo', '--branch', 'main', '--no-meta'];
  const result = spawnSync(process.execPath, ['--import', mock, path.join(proj, 'tools', 'push_to_github.mjs'), ...common, ...args], {
    cwd: proj,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : null;
  assert.ok(log && log.loaded, 'подмена сети не загрузилась');
  assert.deepEqual(log.blocked, [], 'были попытки настоящих соединений');
  const out = `${result.stdout}\n${result.stderr}`.split(base).join('<врем>');
  return { status: result.status, out, log };
}

/** Строки списка --dry-run: «  <путь>  <размер>». */
function listedInDryRun(out) {
  return out
    .split('\n')
    .filter((line) => /^ {2}\S/.test(line) && /\s(Б|КБ|МБ)$/.test(line.trim()))
    .map((line) => line.trim().split(/\s+/)[0]);
}

/** Что ушло бы в GitHub: пути дерева коммита и тексты blob. */
function sent(log) {
  const tree = log.calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/trees'));
  const blobs = log.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/git/blobs'));
  return {
    paths: tree ? tree.body.tree.map((item) => item.path).sort() : [],
    contents: blobs.map((call) => Buffer.from(call.body.content, 'base64').toString('utf8')),
  };
}

const SECRET = `review-secret-${Date.now().toString(36)}`;

test('без git: скрипт отказывается и не делает ни одного запроса', async () => {
  await withTempDir(async (base) => {
    const proj = makeProject(base, { 'README.md': '# проект\n', '.env': `KEY=${SECRET}\n` }, { gitInit: false });
    for (const args of [['--dry-run'], []]) {
      const { status, out, log } = runPush(base, proj, args);
      assert.notEqual(status, 0, `скрипт без git завершился с кодом 0 (${args.join(' ') || 'отправка'}): ${out}`);
      assert.match(out, /git/, 'в сообщении об ошибке нет слова git');
      assert.equal(log.calls.length, 0, `были запросы к API: ${log.calls.map((c) => `${c.method} ${c.path}`).join(', ')}`);
      assert.ok(!out.includes(SECRET), 'секрет попал в вывод');
    }
  }, { prefix: 'rw-fix-f4-push-' });
}, { timeoutMs: 60_000 });

test('секреты не уходят, даже если git их отслеживает; --dry-run их называет', async () => {
  await withTempDir(async (base) => {
    const secrets = ['.env', '.github-token', 'config/.env.production', 'keys/deploy.pem', 'ssl/server.key'];
    const files = { 'README.md': '# проект\n', 'rust-autowipe/plugin.json': '{"name":"rust-autowipe"}\n' };
    for (const file of secrets) files[file] = `${SECRET}\n`;
    const proj = makeProject(base, files);
    git(base, proj, ['add', '-A']);

    const dry = runPush(base, proj, ['--dry-run']);
    assert.equal(dry.status, 0, `--dry-run завершился с кодом ${dry.status}: ${dry.out}`);
    assert.equal(dry.log.calls.length, 0, 'в --dry-run были запросы к API');
    const listed = listedInDryRun(dry.out);
    assert.ok(listed.includes('README.md'), `в списке нет README.md: ${dry.out}`);
    assert.deepEqual(secrets.filter((file) => listed.includes(file)), [], 'секреты в списке на отправку');
    const warning = dry.out.split('\n').find((line) => line.includes('похожие на секреты'));
    assert.ok(warning, `нет предупреждения о секретах: ${dry.out}`);
    for (const file of secrets) assert.ok(warning.includes(file), `в предупреждении нет ${file}`);

    const push = runPush(base, proj, []);
    assert.equal(push.status, 0, `отправка завершилась с кодом ${push.status}: ${push.out}`);
    const { paths, contents } = sent(push.log);
    assert.ok(paths.includes('README.md'), 'в дереве коммита нет README.md');
    assert.deepEqual(secrets.filter((file) => paths.includes(file)), [], 'секреты в дереве коммита');
    assert.equal(contents.filter((text) => text.includes(SECRET)).length, 0, 'blob с секретом ушёл в GitHub');
  }, { prefix: 'rw-fix-f4-push-' });
}, { timeoutMs: 60_000 });

test('отслеживаемое, но исключённое .gitignore не уходит; новое и удалённое — как в зеркале', async () => {
  await withTempDir(async (base) => {
    const proj = makeProject(base, {
      'README.md': '# проект\n',
      '.preview/index.html': '<!doctype html>\n',
      'gone.txt': 'будет удалён\n',
    });
    git(base, proj, ['add', '-A']);
    // Правило появилось после того, как файлы уже добавили в git (как было с .preview/).
    fs.writeFileSync(path.join(proj, '.gitignore'), '.preview/\n');
    fs.writeFileSync(path.join(proj, 'new.txt'), 'новый файл\n');
    fs.rmSync(path.join(proj, 'gone.txt'));

    const dry = runPush(base, proj, ['--dry-run']);
    assert.equal(dry.status, 0, `--dry-run завершился с кодом ${dry.status}: ${dry.out}`);
    const warning = dry.out.split('\n').find((line) => line.includes('исключает .gitignore'));
    assert.ok(warning && warning.includes('.preview/index.html'), `нет предупреждения об исключённом файле: ${dry.out}`);

    const push = runPush(base, proj, []);
    assert.equal(push.status, 0, `отправка завершилась с кодом ${push.status}: ${push.out}`);
    const { paths } = sent(push.log);
    assert.deepEqual(paths, ['.gitignore', 'README.md', 'new.txt', 'tools/push_to_github.mjs']);
  }, { prefix: 'rw-fix-f4-push-' });
}, { timeoutMs: 60_000 });
