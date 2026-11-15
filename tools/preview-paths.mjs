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

const stepRows = [
  ['01', '23:50:00.009', '✓', 'сервер', '2 мс', true],
  ['02', '23:50:01.054', '✓', 'остановка', '1.04 с', true],
  ['03', '23:50:02.224', '✓', 'удаление', '720 мс', true],
  ['04', '23:50:02.431', '✓', 'запуск', '207 мс', true],
  ['05', '23:50:03.100', '✕', 'ошибка', '44 мс', false],
]
  .map(
    ([n, clock, icon, label, ms, ok]) => `        <details class="rw-step">
          <summary>
            <span class="rw-step-n">${n}</span>
            <span class="rw-step-clock">${clock}</span>
            <span class="${ok ? 'rw-step-ok' : 'rw-step-bad'}">${icon}</span>
            <span class="${ok ? 'rw-step-label' : 'rw-step-label bad'}">${label}</span>
            <span class="rw-step-ms">${ms}</span>
          </summary>
          <div class="rw-step-body">
            <div class="rw-step-detail">Rust-Test · статус running</div>
            <div class="rw-kv">
              <span class="rw-kv-key">статус</span><span class="rw-kv-val">running</span>
              <span class="rw-kv-key">длительность</span><span class="rw-kv-val">${ms}</span>
            </div>
          </div>
        </details>`,
  )
  .join('\n');

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
  #metrics{font:12px ui-monospace,Menlo,monospace;color:#7ee787;margin-bottom:10px}
  ${css}
</style></head>
<body>
  <div class="frame">
    <div id="metrics">измеряю…</div>
    <div class="label">Что удалять (пути и маски)</div>
    <div class="rw-root">
      <div class="rw-paths">
${rowHtml}
      </div>
      <div class="label" style="margin-top:14px">История · шаги</div>
      <div style="color:#f97316">
        <details class="rw-details" open>
          <summary>шаги (5)</summary>
          <div class="rw-steps">
${stepRows}
          </div>
        </details>
      </div>
    </div>
  </div>
  <script>
    window.addEventListener('load', () => {
      const row = document.querySelector('.rw-path');
      const grip = row.querySelector('.rw-path-grip').getBoundingClientRect();
      const n = row.querySelector('.rw-path-n').getBoundingClientRect();
      const t = row.querySelector('.rw-path-text').getBoundingClientRect();
      const m = document.getElementById('metrics');
      m.textContent = 'gap grip→номер: ' + (n.left - grip.right).toFixed(1) + 'px' +
        ' · gap номер→путь: ' + (t.left - n.right).toFixed(1) + 'px' +
        ' · номер ширина: ' + n.width.toFixed(1) + 'px' +
        ' · высота строки: ' + row.getBoundingClientRect().height.toFixed(1) + 'px';
    });
  </script>
</body></html>`;

const target = process.argv[2] || resolve(here, '../../.dsh-preview-paths.html');
writeFileSync(target, html, 'utf8');
console.log('written:', target);
