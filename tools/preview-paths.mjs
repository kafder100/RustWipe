/**
 * Снимает CSS из frontend.mjs и собирает автономную страницу с разметкой
 * строки пути — чтобы проверять вёрстку скриншотом без запуска панели.
 *
 * Запуск: node tools/preview-paths.mjs [out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../rust-autowipe/frontend/frontend.mjs'), 'utf8');

const start = source.indexOf('style.textContent = `');
if (start < 0) throw new Error('не нашёл блок стилей в frontend.mjs');
const cssStart = start + 'style.textContent = `'.length;
const cssEnd = source.indexOf('`;', cssStart);
if (cssEnd < 0) throw new Error('не нашёл конец блока стилей');
const css = source.slice(cssStart, cssEnd);

const rows = [
  '/server/*/proceduralmap.*.map',
  '/server/*/proceduralmap.*.sav',
  '/server/*/player.blueprints.*.db',
];

const rowHtml = rows
  .map(
    (path, index) => `      <div class="rw-path">
        <span class="rw-path-grip" title="Перетащите">⠿</span>
        <div class="rw-path-main">
          <span class="rw-path-n">${index + 1}.</span>
          <span class="rw-path-text" title="${path}">${path}</span>
        </div>
        <div class="rw-path-actions">
          <button class="rw-path-btn" title="Выше">↑</button>
          <button class="rw-path-btn" title="Ниже">↓</button>
          <button class="rw-path-btn" title="Изменить">✎</button>
          <button class="rw-path-btn" title="Дублировать">⧉</button>
          <button class="rw-path-btn danger" title="Удалить">×</button>
        </div>
      </div>`,
  )
  .join('\n');

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>paths preview</title>
<style>
  body{margin:0;background:#0b0f14;color:#e5e9f0;font-family:Inter,system-ui,sans-serif;padding:18px}
  .frame{width:800px;background:#141a23;border:1px solid #253040;border-radius:10px;padding:14px}
  .label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b98a9;margin-bottom:8px}
  ${css}
</style></head>
<body>
  <div class="frame">
    <div class="label">Что удалять (пути и маски)</div>
    <div class="rw-root">
      <div class="rw-paths">
${rowHtml}
      </div>
    </div>
  </div>
</body></html>`;

const target = process.argv[2] || resolve(here, '../../.dsh-preview-paths.html');
writeFileSync(target, html, 'utf8');
console.log('written:', target);
