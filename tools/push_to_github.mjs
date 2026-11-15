#!/usr/bin/env node
/**
 * Публикация содержимого этого каталога в GitHub через REST API (Git Data API),
 * без установленного git.
 *
 * Токен берётся из переменной окружения GITHUB_TOKEN / GH_TOKEN либо из файла
 * `.github-token` в корне репозитория (или в родительском каталоге).
 * В вывод токен не попадает.
 *
 * Команды:
 *   node tools/push_to_github.mjs --check      # проверить токен и права на push
 *   node tools/push_to_github.mjs --dry-run    # показать, что будет отправлено
 *   node tools/push_to_github.mjs              # создать коммит и обновить ветку
 *
 * Параметры: --owner kafder100 --repo RustWipe --branch main --message "..."
 *
 * Публикация «зеркальная»: дерево коммита собирается только из файлов этого
 * каталога, поэтому файлы, удалённые локально, исчезнут и в репозитории.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.github-token',
  '.DS_Store',
  'Thumbs.db',
]);

const DEFAULTS = {
  owner: 'kafder100',
  repo: 'RustWipe',
  branch: 'main',
  message: 'feat: Rust AutoWipe 1.0.0 — плагин автовайпов Rust для Catalyst',
  description:
    'Автовайпы Rust для панели Catalyst: расписание, выбор файлов и каталогов, остановка/запуск сервера',
  topics: 'rust,catalyst,game-server,wipe,scheduler,catalyst-panel',
};

function parseArgs(argv) {
  const parsed = { ...DEFAULTS, check: false, dryRun: false, meta: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') parsed.check = true;
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--no-meta') parsed.meta = false;
    else if (arg.startsWith('--')) {
      const [rawKey, rawValue] = arg.slice(2).split('=');
      const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const value = rawValue !== undefined ? rawValue : argv[++index];
      if (value === undefined) throw new Error(`Не хватает значения для --${rawKey}`);
      parsed[key] = value;
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  return parsed;
}

function readToken() {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  for (const candidate of [
    path.join(ROOT, '.github-token'),
    path.join(ROOT, '..', '.github-token'),
  ]) {
    if (fs.existsSync(candidate)) {
      const value = fs.readFileSync(candidate, 'utf8').trim();
      if (value) return value;
    }
  }
  throw new Error(
    'Токен не найден. Задайте GITHUB_TOKEN или сохраните токен в .github-token в корне репозитория',
  );
}

function collectFiles(dir = ROOT, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    if (entry.name.endsWith('.pyc') || entry.name.endsWith('.log')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, files);
    else files.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return files.sort();
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(2)} МБ`;
}

async function api(token, method, endpoint, body, attempt = 1) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'rust-autowipe-publisher',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    if ((response.status === 502 || response.status === 503) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      return api(token, method, endpoint, body, attempt + 1);
    }
    const message = json?.message || text.slice(0, 300) || `HTTP ${response.status}`;
    const error = new Error(`${method} ${endpoint} → ${response.status}: ${message}`);
    error.status = response.status;
    error.body = json;
    throw error;
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = collectFiles();

  if (!files.length) throw new Error('Нечего публиковать: каталог пуст');
  const totalBytes = files.reduce(
    (sum, file) => sum + fs.statSync(path.join(ROOT, file)).size,
    0,
  );

  if (args.dryRun) {
    console.log(`Репозиторий: ${args.owner}/${args.repo} (ветка ${args.branch})`);
    console.log(`Файлов: ${files.length}, ${humanSize(totalBytes)}`);
    for (const file of files) {
      const size = fs.statSync(path.join(ROOT, file)).size;
      console.log(`  ${file}  ${humanSize(size)}`);
    }
    return;
  }

  const token = readToken();
  const user = await api(token, 'GET', '/user');
  const repoInfo = await api(token, 'GET', `/repos/${args.owner}/${args.repo}`);
  const canPush = Boolean(repoInfo.permissions?.push);
  console.log(`Токен: ${user.login} · репозиторий: ${repoInfo.full_name} (push: ${canPush})`);

  if (!canPush) {
    throw new Error(
      `У токена ${user.login} нет прав на push в ${repoInfo.full_name}. Нужен fine-grained PAT с Contents: Read and write на этот репозиторий`,
    );
  }

  if (args.check) {
    console.log('Проверка пройдена: токен валиден и может писать в репозиторий.');
    return;
  }

  console.log(`Файлов: ${files.length} · ${humanSize(totalBytes)} · ветка ${args.branch}`);

  const treeEntries = [];
  for (const file of files) {
    const absolute = path.join(ROOT, file);
    const content = fs.readFileSync(absolute).toString('base64');
    const blob = await api(token, 'POST', `/repos/${args.owner}/${args.repo}/git/blobs`, {
      content,
      encoding: 'base64',
    });
    treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`  blob ${blob.sha.slice(0, 8)}  ${file}`);
  }

  const tree = await api(token, 'POST', `/repos/${args.owner}/${args.repo}/git/trees`, {
    tree: treeEntries,
  });

  let parent = null;
  try {
    const ref = await api(token, 'GET', `/repos/${args.owner}/${args.repo}/git/ref/heads/${args.branch}`);
    parent = ref.object.sha;
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error;
    console.log('Ветка ещё не существует — это первый коммит.');
  }

  const commit = await api(token, 'POST', `/repos/${args.owner}/${args.repo}/git/commits`, {
    message: args.message,
    tree: tree.sha,
    parents: parent ? [parent] : [],
  });

  if (parent) {
    await api(token, 'PATCH', `/repos/${args.owner}/${args.repo}/git/refs/heads/${args.branch}`, {
      sha: commit.sha,
      force: false,
    });
  } else {
    await api(token, 'POST', `/repos/${args.owner}/${args.repo}/git/refs`, {
      ref: `refs/heads/${args.branch}`,
      sha: commit.sha,
    });
  }

  if (args.meta) {
    await api(token, 'PATCH', `/repos/${args.owner}/${args.repo}`, {
      description: args.description,
      topics: String(args.topics)
        .split(',')
        .map((topic) => topic.trim().replace(/[^a-z0-9-]/gi, ''))
        .filter(Boolean)
        .slice(0, 20),
    });
  }

  console.log('');
  console.log(`Коммит: ${commit.sha}`);
  console.log(`Ветка:  ${args.branch}`);
  console.log(`URL:    https://github.com/${args.owner}/${args.repo}/commit/${commit.sha}`);
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.message}`);
  if (error.status === 401) {
    console.error('Токен не принят GitHub (истёк или отозван).');
  }
  process.exitCode = 1;
});
