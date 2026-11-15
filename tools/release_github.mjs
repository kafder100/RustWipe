#!/usr/bin/env node
/**
 * Публикация GitHub Release и метаданных репозитория для этого плагина.
 * Работает через REST API — git и gh не нужны.
 *
 * Токен: GITHUB_TOKEN / GH_TOKEN либо файл .github-token в корне репозитория.
 *
 *   node tools/release_github.mjs                 # релиз для текущей версии plugin.json
 *   node tools/release_github.mjs --tag v1.0.2    # явный тег
 *   node tools/release_github.mjs --no-meta       # не трогать описание/топики
 *   node tools/release_github.mjs --no-release    # только метаданные
 *
 * Скрипт идемпотентен: существующий релиз не пересоздаётся, уже загруженный
 * ассет с тем же именем пропускается.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'kafder100';
const REPO = 'RustWipe';
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

const DESCRIPTION =
  'Автовайпы Rust для панели Catalyst: расписание вайпов, выбор файлов и каталогов, ' +
  'остановка/запуск сервера, история прогонов';

const TOPICS = [
  'rust',
  'catalyst',
  'game-server',
  'wipe',
  'scheduler',
  'catalyst-panel',
  'server-management',
  'typescript',
];

function parseArgs(argv) {
  const args = { tag: null, meta: true, release: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-meta') args.meta = false;
    else if (arg === '--no-release') args.release = false;
    else if (arg.startsWith('--tag')) {
      const value = arg.includes('=') ? arg.split('=')[1] : argv[++index];
      if (!value) throw new Error('--tag требует значения');
      args.tag = value;
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  return args;
}

function readToken() {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  const file = path.join(ROOT, '.github-token');
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  throw new Error('Токен не найден: задайте GITHUB_TOKEN или положите .github-token в корень');
}

async function api(token, method, endpoint, body, { upload = false, contentType = 'application/json' } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'rust-autowipe-release',
  };
  if (body !== undefined) headers['content-type'] = contentType;

  const response = await fetch(`${upload ? UPLOADS : API}${endpoint}`, {
    method,
    headers,
    body:
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body),
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
    const error = new Error(
      `${method} ${endpoint} → ${response.status}: ${json?.message || text.slice(0, 300)}`,
    );
    error.status = response.status;
    throw error;
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = readToken();

  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'rust-autowipe', 'plugin.json'), 'utf8'),
  );
  const version = manifest.version;
  const tag = args.tag || `v${version}`;
  const pkgName = `${manifest.name}-${version}.catpkg.zip`;
  const pkgPath = path.join(ROOT, 'dist', pkgName);

  if (!fs.existsSync(pkgPath)) {
    throw new Error(`Нет пакета ${pkgName}: сначала выполните python tools/pack.py`);
  }
  const pkg = fs.readFileSync(pkgPath);
  const sha256 = crypto.createHash('sha256').update(pkg).digest('hex');

  if (args.meta) {
    const repo = await api(token, 'PATCH', `/repos/${OWNER}/${REPO}`, {
      description: DESCRIPTION,
    });
    // topics меняются отдельным эндпоинтом — PATCH /repos их игнорирует.
    const topics = await api(token, 'PUT', `/repos/${OWNER}/${REPO}/topics`, {
      names: TOPICS,
    });
    console.log(`Метаданные: ${repo.full_name}`);
    console.log(`Topics: ${(topics.names || []).join(', ')}`);
  }

  if (!args.release) return;

  let release = null;
  try {
    release = await api(token, 'GET', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
    console.log(`Релиз ${tag} уже существует: ${release.html_url}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  if (!release) {
    const body = [
      `Плагин автовайпов Rust для панели [Catalyst](https://catalystctl.com/).`,
      '',
      '**Установка через маркетплейс** — добавьте индекс:',
      '`https://raw.githubusercontent.com/kafder100/RustWipe/main/index.json`',
      '',
      '**Или вручную:** скачайте `' + pkgName + '` ниже и загрузите через',
      '**Admin → Extensions → Marketplace**, либо распакуйте в',
      '`/var/lib/catalyst/plugins/rust-autowipe` и перезапустите backend.',
      '',
      `sha256: \`${sha256}\``,
    ].join('\n');

    release = await api(token, 'POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: tag,
      target_commitish: 'main',
      name: `Rust AutoWipe ${version}`,
      body,
      draft: false,
      prerelease: false,
    });
    console.log(`Релиз создан: ${release.html_url}`);
  }

  const assets = await api(token, 'GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
  const existing = assets.find((asset) => asset.name === pkgName);
  if (existing) {
    console.log(`Ассет уже загружен: ${existing.browser_download_url} (${existing.size} байт)`);
  } else {
    const asset = await api(
      token,
      'POST',
      `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(pkgName)}`,
      pkg,
      { upload: true, contentType: 'application/zip' },
    );
    console.log(`Ассет загружен: ${asset.browser_download_url} (${asset.size} байт)`);
  }

  console.log(`Пакет: ${pkgName}`);
  console.log(`sha256: ${sha256}`);
  console.log(`Страница релиза: ${release.html_url}`);
}

main().catch((error) => {
  console.error(`ОШИБКА: ${error.message}`);
  process.exitCode = 1;
});
