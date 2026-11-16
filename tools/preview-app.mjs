#!/usr/bin/env node
/**
 * Локальный стенд плагина: отдаёт настоящий frontend.mjs с мок-API панели.
 * Нужен, чтобы снимать скриншоты и проверять вёрстку без установки в панель.
 *
 * Запуск: node tools/preview-app.mjs [port]
 */
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, '.preview');
const pluginFile = resolve(root, 'rust-autowipe/frontend/frontend.mjs');

mkdirSync(outDir, { recursive: true });
copyFileSync(pluginFile, resolve(outDir, 'frontend.mjs'));

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();

const fixtures = {
  status: {
    server: { id: 'srv-1', name: 'Rust-Test', uuid: 'uuid-1', nodeId: 'node-1', status: 'running', suspended: false },
    version: '1.5.0',
    clock: { offsetMinutes: 300 },
    hasApiKey: true,
    dryRun: false,
    schedulerEnabled: true,
    catchUpMinutes: 120,
    stopTimeoutSec: 300,
    startTimeoutSec: 240,
    running: [],
    profilesCount: 2,
    wipeWarning: { enabled: true, minutes: 5, text: 'Вайп сервера через {minutes} мин', state: { at: iso(3), ok: true, text: 'Вайп сервера через 5 мин' } },
    permissions: { canManage: true, canRun: true },
  },
  profiles: [
    {
      id: 'p-1',
      name: 'Еженедельный вайп карты',
      serverId: 'srv-1',
      serverName: 'Rust-Test',
      enabled: true,
      schedule: { kind: 'weekly', weekday: 4, time: '05:00' },
      scheduleText: 'каждый четверг в 05:00',
      targets: ['/server/*/proceduralmap.*.map', '/server/*/proceduralmap.*.sav', '/server/*/player.blueprints.*.db'],
      excludes: ['/server/*/cfg'],
      mapText: 'сид: случайный, размер: 3000',
      nextRunAt: new Date(now + 26 * 3600000).toISOString(),
      lastRunStatus: 'ok',
      lastRunAt: iso(120),
      options: { stopServer: true, startServer: true, dryRun: false, warnChat: true, commandsAfter: [] },
    },
    {
      id: 'p-2',
      name: 'Полный вайп (карта + игроки)',
      serverId: 'srv-1',
      serverName: 'Rust-Test',
      enabled: false,
      schedule: { kind: 'interval', intervalDays: 14, time: '04:00' },
      scheduleText: 'каждые 14 дней в 04:00',
      targets: ['/server/*'],
      excludes: ['/server/*/cfg/server.cfg'],
      mapText: 'сид: 1234567, размер: 4000',
      nextRunAt: null,
      lastRunStatus: 'failed',
      lastRunAt: iso(2000),
      options: { stopServer: true, startServer: true, dryRun: true, warnChat: false, commandsAfter: [] },
    },
  ],
  presets: [
    { id: 'map', label: 'Карта', description: 'Карта и сохранения мира', targets: ['/server/*/proceduralmap.*.map', '/server/*/proceduralmap.*.sav'] },
    { id: 'bp', label: 'Карта + блюпринты', description: 'Плюс блюпринты игроков', targets: ['/server/*/player.blueprints.*.db'] },
    { id: 'full', label: 'Полный вайп', description: 'Всё, кроме конфигов', targets: ['/server/*'] },
  ],
  runs: [
    {
      id: 'r-1',
      startedAt: iso(26 * 60),
      profileName: 'Еженедельный вайп карты',
      trigger: 'schedule',
      ok: true,
      dryRun: false,
      durationMs: 8420,
      deletedCount: 3,
      deleted: ['/server/rust/proceduralmap.123.map', '/server/rust/proceduralmap.123.sav', '/server/rust/player.blueprints.7656119.db'],
      skipped: [{ path: '/server/rust/proceduralmap.old.sav', reason: 'уже отсутствует' }],
      steps: [
        { at: iso(26 * 60), action: 'server', ok: true, detail: 'Rust-Test · статус running', data: { ms: 2, status: 'running' } },
        { at: iso(26 * 60 - 0.02), action: 'stop', ok: true, detail: 'команда остановки отправлена в панель', data: { ms: 1040, status: 'stopping', timeoutSec: 300 } },
        { at: iso(26 * 60 - 0.05), action: 'stop', ok: true, detail: 'сервер остановлен', data: { ms: 3, status: 'stopped' } },
        { at: iso(26 * 60 - 0.1), action: 'map', ok: true, detail: 'WORLD_SEED=1293442726, WORLD_SIZE=3000', data: { ms: 34, changed: true, seed: 1293442726, size: 3000 } },
        { at: iso(26 * 60 - 0.2), action: 'expand', ok: true, detail: 'найдено путей: 3', data: { ms: 413, paths: 3, truncated: false } },
        { at: iso(26 * 60 - 0.3), action: 'delete', ok: true, detail: 'удалено 3, пропущено 1, ошибок 0', data: { ms: 720, deleted: 3, skipped: 1, errors: 0 } },
        { at: iso(26 * 60 - 0.4), action: 'start', ok: true, detail: 'статус running', data: { ms: 207, status: 'running' } },
        { at: iso(26 * 60 - 0.45), action: 'command', ok: true, detail: 'say Сервер скоро вернётся', data: { ms: 1, command: 'say Сервер скоро вернётся' } },
      ],
      errors: [],
      warnings: [],
    },
    {
      id: 'r-2',
      startedAt: iso(2000),
      profileName: 'Полный вайп (карта + игроки)',
      trigger: 'manual',
      ok: false,
      dryRun: true,
      durationMs: 1371,
      deletedCount: 0,
      steps: [
        { at: iso(2000), action: 'server', ok: true, detail: 'Rust-Test · статус running', data: { ms: 2, status: 'running' } },
        { at: iso(2000 - 0.02), action: 'stop', ok: true, detail: 'режим проверки: сервер не останавливается', data: { ms: 1, dryRun: true } },
        { at: iso(2000 - 0.03), action: 'error', ok: false, detail: 'Не задан API-ключ панели', data: { ms: 1, message: 'Не задан API-ключ панели' } },
      ],
      errors: ['Не задан API-ключ панели'],
      warnings: ['Список путей обрезан лимитом'],
    },
  ],
};

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>Rust AutoWipe preview</title>
<style>
  html{color-scheme:light dark}
  body{margin:0;background:#0e131a;color:#e6ebf2;font-family:ui-sans-serif,system-ui,sans-serif}
  @media (prefers-color-scheme: light){ body{background:#f7f9fc;color:#0f172a} }
  #mount{max-width:1280px;margin:0 auto;min-height:100vh}
</style></head>
<body>
<div id="mount"></div>
<script type="module">
const FIX = ${JSON.stringify(fixtures)};

const ok = (data) => new Response(JSON.stringify({ success: true, data }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

window.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET') return ok({});
  if (url.endsWith('/status')) return ok(FIX.status);
  if (url.endsWith('/profiles')) return ok(FIX.profiles);
  if (url.endsWith('/presets')) return ok(FIX.presets);
  if (url.includes('/runs')) return ok(FIX.runs);
  return ok({});
};

const { default: plugin } = await import('./frontend.mjs');
const tab = plugin.tabs[0];
const element = tab.component({ serverId: 'srv-1' });
const node = document.createElement(element.type);
for (const [key, value] of Object.entries(element.props || {})) {
  if (key === 'class') node.className = value;
  else if (key === 'ref') continue;
  else if (value !== null && value !== undefined) node.setAttribute(key, value);
}
document.getElementById('mount').appendChild(node);
if (element.props && typeof element.props.ref === 'function') element.props.ref(node);
window.__previewReady = true;
</script>
</body></html>`;

writeFileSync(resolve(outDir, 'index.html'), html, 'utf8');

const port = Number(process.argv[2] || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

createServer((req, res) => {
  const path = req.url.split('?')[0];
  const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  try {
    const body = readFileSync(resolve(outDir, file));
    const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '.html';
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port}/`);
});
