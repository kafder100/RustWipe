/**
 * Ревью RustWipe, гипотеза 20 (раздел 4.2), утверждение H20a:
 * tools/push_to_github.mjs выкладывает папку в обход .gitignore — в коммит
 * попадают файлы, которые .gitignore исключает (стенд .preview/, временные
 * dist/*.tmp). Список исключений в скрипте свой (IGNORED_NAMES, collectFiles).
 *
 * Правильное поведение (ответ владельца №21: «.preview/ — убрать;
 * push_to_github.mjs — учитывать .gitignore»): файлы, которые исключает .gitignore,
 * не попадают ни в список --dry-run, ни в дерево коммита.
 *
 * Как проверяется: во временной папке (os.tmpdir, mkdtemp) — «проект» с .gitignore
 * и копией скрипта. Сеть подменена: node --import с модулем-подменой fetch,
 * настоящие соединения запрещены. Токен фиктивный, настоящие токены из окружения
 * дочернему процессу не передаются. Отправка запускается только после того,
 * как --dry-run показал, что подмена загрузилась.
 *
 * Правка исполнителя F4: «проект» во временной папке — репозиторий git
 * (git init без коммитов), как настоящая копия проекта: исправленный скрипт
 * берёт список файлов у git (git ls-files). Суть проверки не изменилась.
 *
 * Запуск: node tools/review/h20a-push-gitignore.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ── Подмена сети: подключается в дочерний процесс через node --import ──────
// fetch отвечает как GitHub API и записывает запросы; любые настоящие
// соединения (net, tls, http, https) запрещены и тоже записываются.
const MOCK = [
  "import fs from 'node:fs';",
  "import net from 'node:net';",
  "import tls from 'node:tls';",
  "import http from 'node:http';",
  "import https from 'node:https';",
  'const LOG = process.env.REVIEW_MOCK_LOG;',
  'const state = { loaded: true, calls: [], blocked: [] };',
  'const save = () => fs.writeFileSync(LOG, JSON.stringify(state));',
  'save();',
  'const deny = (what) => function denied() {',
  '  state.blocked.push(what);',
  '  save();',
  "  throw new Error('настоящая сеть в тесте запрещена: ' + what);",
  '};',
  "net.connect = deny('net.connect');",
  "net.createConnection = deny('net.createConnection');",
  "net.Socket.prototype.connect = deny('net.Socket#connect');",
  "tls.connect = deny('tls.connect');",
  "http.request = deny('http.request');",
  "http.get = deny('http.get');",
  "https.request = deny('https.request');",
  "https.get = deny('https.get');",
  'let counter = 0;',
  'globalThis.fetch = async (input, init = {}) => {',
  '  const url = new URL(String(input));',
  "  const method = String(init.method || 'GET').toUpperCase();",
  '  let body = init.body ?? null;',
  "  if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }",
  '  state.calls.push({ host: url.host, method, path: url.pathname, body });',
  '  save();',
  '  const reply = (status, data) =>',
  "    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });",
  '  const p = url.pathname;',
  "  const sha = (prefix) => (prefix + String(++counter)).padEnd(40, '0');",
  "  if (method === 'GET' && p === '/user') return reply(200, { login: 'review-user' });",
  "  if (method === 'GET' && /^\\/repos\\/[^/]+\\/[^/]+$/.test(p)) {",
  '    return reply(200, { full_name: p.slice(7), permissions: { push: true } });',
  '  }',
  "  if (method === 'POST' && p.endsWith('/git/blobs')) return reply(201, { sha: sha('b') });",
  "  if (method === 'POST' && p.endsWith('/git/trees')) return reply(201, { sha: sha('e') });",
  "  if (method === 'GET' && p.includes('/git/ref/heads/')) return reply(200, { object: { sha: sha('a') } });",
  "  if (method === 'POST' && p.endsWith('/git/commits')) return reply(201, { sha: sha('c') });",
  "  if (method === 'PATCH' || method === 'POST' || method === 'PUT') return reply(200, {});",
  "  return reply(404, { message: 'нет в подмене' });",
  '};',
  '',
].join('\n');

const temps = [];
process.on('exit', () => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** Временная папка: base/proj — «проект» с файлами files, рядом подмена сети. */
function makeProject(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-h20-'));
  temps.push(base);
  const proj = path.join(base, 'proj');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(proj, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(path.join(proj, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'push_to_github.mjs'), path.join(proj, 'tools', 'push_to_github.mjs'));
  fs.writeFileSync(path.join(base, 'mock-fetch.mjs'), MOCK);
  const init = spawnSync('git', ['init', '-q', proj], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init не выполнился (код ${init.status}): ${init.stderr || init.error}`);
  return { base, proj };
}

/** Окружение дочернего процесса: без настоящих токенов и NODE_OPTIONS, токен фиктивный. */
function childEnv(logPath) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|CRED|^NODE_OPTIONS$/i.test(key)) continue;
    env[key] = value;
  }
  env.GITHUB_TOKEN = 'review-fake-token';
  env.REVIEW_MOCK_LOG = logPath;
  return env;
}

/** Контроль подмены без единого запроса: fetch подменён, соединение к 127.0.0.1:9 запрещено. */
function probeMock({ base }) {
  const logPath = path.join(base, 'probe.json');
  const probe = [
    "const net = require('node:net');",
    'let blocked = false;',
    "try { net.connect(9, '127.0.0.1'); } catch (error) { blocked = /запрещена/.test(error.message); }",
    "console.log(JSON.stringify({ mockFetch: String(globalThis.fetch).includes('state.calls.push'), blocked }));",
  ].join('\n');
  const mock = pathToFileURL(path.join(base, 'mock-fetch.mjs')).href;
  const result = spawnSync(process.execPath, ['--import', mock, '-e', probe], {
    env: childEnv(logPath),
    encoding: 'utf8',
    timeout: 30_000,
  });
  try {
    return JSON.parse(result.stdout.trim().split('\n').pop());
  } catch {
    return { mockFetch: false, blocked: false, error: `${result.stdout}${result.stderr}`.split(base).join('<врем>') };
  }
}

/** Запуск push_to_github.mjs с подменой сети; токен фиктивный, настоящие убраны. */
function runPush({ base, proj }, args) {
  const logPath = path.join(base, 'calls.json');
  fs.rmSync(logPath, { force: true });
  const env = childEnv(logPath);
  const script = path.join(proj, 'tools', 'push_to_github.mjs');
  const mock = pathToFileURL(path.join(base, 'mock-fetch.mjs')).href;
  const common = ['--owner', 'review-owner', '--repo', 'review-repo', '--branch', 'main', '--no-meta'];
  const result = spawnSync(process.execPath, ['--import', mock, script, ...common, ...args], {
    cwd: proj,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : null;
  const out = `${result.stdout}\n${result.stderr}`.split(base).join('<врем>').trim();
  return { status: result.status, out, log };
}

/** Что ушло бы в GitHub: пути из дерева коммита и содержимое blob. */
function sent(log) {
  const tree = log.calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/trees'));
  const blobs = log.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/blobs'));
  return {
    paths: tree ? tree.body.tree.map((item) => item.path).sort() : [],
    contents: blobs.map((c) =>
      Buffer.from(c.body.content, c.body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'),
    ),
  };
}

function assertNoRealNetwork(log) {
  check(log && log.loaded, 'подмена сети не загрузилась');
  check(log.blocked.length === 0, `были попытки настоящих соединений: ${log.blocked.join(', ')}`);
}

const FILES = {
  '.gitignore': '# как в проекте\n.env\n.env.*\ndist/*.tmp\n.preview/\n',
  'README.md': '# проект\n',
  'rust-autowipe/plugin.json': '{"name":"rust-autowipe"}\n',
  'dist/rust-autowipe-0.0.1.catpkg.zip': 'zip',
  '.preview/index.html': '<!doctype html><title>стенд</title>\n',
  'dist/build.tmp': 'временный файл сборки\n',
};
const IGNORED = ['.preview/index.html', 'dist/build.tmp'];
const KEPT = ['README.md', 'rust-autowipe/plugin.json', 'dist/rust-autowipe-0.0.1.catpkg.zip'];
const project = makeProject(FILES);
let mockLoaded = false;

test('контроль: подмена загружается — fetch подменён, настоящие соединения запрещены', () => {
  const probe = probeMock(project);
  check(probe.mockFetch && probe.blocked, `подмена не работает: ${JSON.stringify(probe)}`);
});

test('--dry-run: в списке нет файлов, исключённых .gitignore', () => {
  const { status, out, log } = runPush(project, ['--dry-run']);
  check(status === 0, `скрипт завершился с кодом ${status}: ${out}`);
  assertNoRealNetwork(log);
  mockLoaded = true;
  check(log.calls.length === 0, 'в --dry-run были запросы к API');
  const missing = KEPT.filter((file) => !out.includes(file));
  check(missing.length === 0, `в списке нет обычных файлов: ${missing.join(', ')}`);
  const leaked = IGNORED.filter((file) => out.includes(file));
  check(leaked.length === 0, `в списке на отправку есть исключённые .gitignore: ${leaked.join(', ')}`);
});

test('отправка (fetch подменён): в дерево коммита не попадают исключённые .gitignore', () => {
  check(mockLoaded, 'подмена сети не подтверждена в --dry-run — отправку не запускаю');
  const { status, out, log } = runPush(project, []);
  assertNoRealNetwork(log);
  check(status === 0, `скрипт завершился с кодом ${status}: ${out}`);
  const hosts = [...new Set(log.calls.map((c) => c.host))];
  check(hosts.every((host) => host === 'api.github.com'), `неожиданные адреса: ${hosts.join(', ')}`);
  const { paths } = sent(log);
  const missing = KEPT.filter((file) => !paths.includes(file));
  check(missing.length === 0, `в дереве нет обычных файлов: ${missing.join(', ')}`);
  const leaked = IGNORED.filter((file) => paths.includes(file));
  check(leaked.length === 0, `в дерево коммита ушли исключённые .gitignore: ${leaked.join(', ')}`);
});

runAll();
