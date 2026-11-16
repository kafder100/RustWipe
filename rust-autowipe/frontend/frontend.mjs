/**
 * Rust AutoWipe — фронтенд-бандл (self-contained ESM, без импортов).
 *
 * Панель грузит этот файл как /plugins-assets/rust-autowipe/frontend.mjs,
 * когда плагин не вкомпилирован в образ. Такой бандл живёт со своей копией
 * React, поэтому хуки здесь недоступны. Решение: компонент-обёртка отдаёт
 * один div и монтирует в него обычный DOM-интерфейс.
 *
 * Элемент React собирается вручную по форме React 19
 * ($$typeof = Symbol.for('react.transitional.element'), ref в props),
 * чтобы не тащить в бандл копию react.
 */

const REACT_ELEMENT_TYPE = Symbol.for('react.transitional.element');

function h(type, props) {
  const config = props || {};
  const nextProps = {};
  let key = null;
  for (const name in config) {
    if (!Object.prototype.hasOwnProperty.call(config, name)) continue;
    if (name === 'key') {
      key = '' + config[name];
      continue;
    }
    nextProps[name] = config[name];
  }
  const ref = nextProps.ref === undefined ? null : nextProps.ref;
  return { $$typeof: REACT_ELEMENT_TYPE, type, key, ref, props: nextProps };
}

// ── Мелкие DOM-хелперы ────────────────────────────────────────────────────

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── API ───────────────────────────────────────────────────────────────────

const API_BASE = '/api/plugins/rust-autowipe';

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetch(`${API_BASE}/${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok || !json || json.success === false) {
    const message = json?.error || json?.message || `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return json.data !== undefined ? json.data : json;
}

// ── Форматирование ────────────────────────────────────────────────────────

const STATUS_LABELS = {
  running: 'работает',
  starting: 'запускается',
  stopping: 'останавливается',
  stopped: 'остановлен',
  installing: 'установка',
  error: 'ошибка',
  crashed: 'упал',
  suspended: 'приостановлен',
  creating_backup: 'бэкап',
  restoring: 'восстановление',
};

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const NTH_LABELS = { 1: 'первый', 2: 'второй', 3: 'третий', 4: 'четвёртый', '-1': 'последний' };

function statusLabel(status) {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] || key || 'неизвестно';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatPanelDate(iso, offsetMinutes) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const shifted = new Date(date.getTime() + (offsetMinutes || 0) * 60000);
  const s = shifted.toISOString();
  return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)} ${s.slice(11, 16)}`;
}

function humanDelta(iso, offsetMinutes) {
  if (!iso) return '';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return '';
  const future = diffMs >= 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60000);
  let text;
  if (minutes < 1) text = 'меньше минуты';
  else if (minutes < 60) text = `${minutes} мин`;
  else if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    text = rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  } else {
    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);
    text = hours ? `${days} дн ${hours} ч` : `${days} дн`;
  }
  return future ? `через ${text}` : `${text} назад`;
}

function scheduleText(schedule) {
  if (!schedule) return '—';
  const time = schedule.time || '05:00';
  switch (schedule.kind) {
    case 'monthly_nth_weekday':
      return `ежемесячно: ${NTH_LABELS[String(schedule.nth)] || 'первый'} ${WEEKDAYS[schedule.weekday]}, ${time}`;
    case 'monthly_day':
      return `ежемесячно: ${schedule.day}-е число, ${time}`;
    case 'interval':
      return `каждые ${schedule.intervalDays} дн., ${time}`;
    case 'weekly':
    default:
      return `еженедельно: ${WEEKDAYS[schedule.weekday]}, ${time}`;
  }
}

function bytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

// ── Стили ─────────────────────────────────────────────────────────────────

const STYLE_ID = 'rust-autowipe-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ============ Rust AutoWipe — design system v2 ============
   Токены: палитра, spacing 4/8, радиусы 6/10, тени sm/md.
   Темы: data-rw-theme="dark" | "light" (ставится из JS по теме панели). */

.rw-root{
  --rw-space-1:4px;--rw-space-2:8px;--rw-space-3:12px;--rw-space-4:16px;--rw-space-5:20px;--rw-space-6:24px;--rw-space-8:32px;
  --rw-r-sm:6px;--rw-r-md:10px;
  --rw-fs-11:11px;--rw-fs-12:12px;--rw-fs-13:13px;--rw-fs-14:14px;--rw-fs-16:16px;--rw-fs-20:20px;
  --rw-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;
  --rw-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:flex;flex-direction:column;gap:var(--rw-space-4);
  min-height:100%;min-width:0;padding:var(--rw-space-4);
  font-family:var(--rw-font);font-size:var(--rw-fs-14);line-height:1.5;
  color:var(--rw-text);background:var(--rw-bg);
  -webkit-font-smoothing:antialiased;
}
.rw-root[data-rw-theme="dark"]{
  --rw-bg:#0e131a;--rw-surface:#141a23;--rw-surface-2:#1b2430;--rw-surface-3:#222c3a;
  --rw-border:#2a3441;--rw-border-strong:#3a4657;
  --rw-text:#e6ebf2;--rw-text-dim:#93a1b3;
  --rw-primary:#f97316;--rw-primary-ink:#1a1206;--rw-primary-soft:rgba(249,115,22,.14);
  --rw-danger:#f87171;--rw-ok:#34d399;--rw-warn:#fbbf24;
  --rw-shadow-sm:0 1px 2px rgba(0,0,0,.35);
  --rw-shadow-md:0 8px 24px rgba(0,0,0,.4);
  --rw-overlay:rgba(2,6,12,.6);
}
.rw-root[data-rw-theme="light"]{
  --rw-bg:#f7f9fc;--rw-surface:#ffffff;--rw-surface-2:#f1f5f9;--rw-surface-3:#e7edf4;
  --rw-border:#dbe2ea;--rw-border-strong:#c3cedb;
  --rw-text:#0f172a;--rw-text-dim:#5b6b7f;
  --rw-primary:#ea580c;--rw-primary-ink:#ffffff;--rw-primary-soft:rgba(234,88,12,.12);
  --rw-danger:#dc2626;--rw-ok:#15803d;--rw-warn:#b45309;
  --rw-shadow-sm:0 1px 2px rgba(15,23,42,.06);
  --rw-shadow-md:0 8px 24px rgba(15,23,42,.12);
  --rw-overlay:rgba(15,23,42,.35);
}
.rw-root *{box-sizing:border-box}
.rw-root :focus-visible{outline:2px solid var(--rw-primary);outline-offset:2px}

/* ── Шапка ─────────────────────────────────────────────────────────── */
.rw-root .rw-head{display:flex;align-items:flex-start;gap:var(--rw-space-3);flex-wrap:wrap}
.rw-root .rw-title{display:flex;flex-direction:column;gap:2px;margin-right:auto;min-width:0}
.rw-root .rw-title b{font-size:var(--rw-fs-20);line-height:1.25;letter-spacing:-.01em}
.rw-root .rw-title span{font-size:var(--rw-fs-11);color:var(--rw-text-dim);text-transform:uppercase;letter-spacing:.1em}
.rw-root .rw-chips{display:flex;align-items:center;gap:var(--rw-space-1);flex-wrap:wrap;min-width:0}
.rw-root .rw-head-actions{display:flex;align-items:center;gap:var(--rw-space-2);flex-wrap:wrap}

.rw-root .rw-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;
  border:1px solid var(--rw-border);border-radius:999px;background:var(--rw-surface);
  font-size:var(--rw-fs-12);color:var(--rw-text-dim);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.rw-root .rw-chip.ok{color:var(--rw-ok);border-color:color-mix(in srgb,var(--rw-ok) 45%,transparent);background:color-mix(in srgb,var(--rw-ok) 8%,var(--rw-surface))}
.rw-root .rw-chip.warn{color:var(--rw-warn);border-color:color-mix(in srgb,var(--rw-warn) 45%,transparent);background:color-mix(in srgb,var(--rw-warn) 8%,var(--rw-surface))}
.rw-root .rw-chip.bad{color:var(--rw-danger);border-color:color-mix(in srgb,var(--rw-danger) 45%,transparent);background:color-mix(in srgb,var(--rw-danger) 8%,var(--rw-surface))}
.rw-root .rw-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* ── Кнопки ────────────────────────────────────────────────────────── */
.rw-root .rw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 var(--rw-space-3);border-radius:var(--rw-r-sm);
  border:1px solid var(--rw-border);background:var(--rw-surface);color:var(--rw-text);
  font:500 var(--rw-fs-13)/1 var(--rw-font);cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,color .15s,box-shadow .15s,transform .06s}
.rw-root .rw-btn:hover:not(:disabled){background:var(--rw-surface-2);border-color:var(--rw-border-strong)}
.rw-root .rw-btn:active:not(:disabled){transform:translateY(1px)}
.rw-root .rw-btn:disabled{opacity:.5;cursor:not-allowed}
.rw-root .rw-btn.primary{background:var(--rw-primary);border-color:transparent;color:var(--rw-primary-ink)}
.rw-root .rw-btn.primary:hover:not(:disabled){filter:brightness(1.06)}
.rw-root .rw-btn.danger{color:var(--rw-danger);border-color:color-mix(in srgb,var(--rw-danger) 40%,transparent)}
.rw-root .rw-btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--rw-danger) 10%,var(--rw-surface))}
.rw-root .rw-btn.small{height:26px;padding:0 10px;font-size:var(--rw-fs-12)}

/* ── Раскладка ─────────────────────────────────────────────────────── */
.rw-root .rw-grid{display:grid;grid-template-columns:232px minmax(0,1fr);gap:var(--rw-space-4);align-items:start}
.rw-root .rw-main{display:flex;flex-direction:column;gap:var(--rw-space-3);min-width:0}
.rw-root .rw-toolbar{display:flex;align-items:center;gap:var(--rw-space-3);flex-wrap:wrap;min-width:0}
.rw-root .rw-toolbar h3{margin:0;font-size:var(--rw-fs-16);font-weight:600;line-height:1.3}
.rw-root .rw-spacer{flex:1}

/* ── Карточки ──────────────────────────────────────────────────────── */
.rw-root .rw-card,.rw-root .rw-panel-block{border:1px solid var(--rw-border);border-radius:var(--rw-r-md);
  background:var(--rw-surface);box-shadow:var(--rw-shadow-sm);padding:var(--rw-space-4);min-width:0}
.rw-root .rw-card{display:flex;flex-direction:column;gap:var(--rw-space-3)}
.rw-root .rw-card-head{display:flex;align-items:flex-start;gap:var(--rw-space-3);min-width:0}
.rw-root .rw-card-head .rw-grow{flex:1;min-width:0}
.rw-root .rw-card h4{margin:0;font-size:var(--rw-fs-16);font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-root .rw-meta{font-size:var(--rw-fs-12);color:var(--rw-text-dim);display:flex;gap:var(--rw-space-3);flex-wrap:wrap;min-width:0}
.rw-root .rw-actions{display:flex;gap:var(--rw-space-2);flex-wrap:wrap}
.rw-root .rw-empty{border:1px dashed var(--rw-border-strong);border-radius:var(--rw-r-md);
  padding:var(--rw-space-6);text-align:center;color:var(--rw-text-dim);background:var(--rw-surface)}
.rw-root .rw-panel-block h3{margin:0 0 var(--rw-space-3);font-size:var(--rw-fs-12);font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;color:var(--rw-text-dim);display:flex;align-items:center;gap:var(--rw-space-2)}
.rw-root .rw-panel-block{overflow-x:auto}

.rw-root .rw-side{border:1px solid var(--rw-border);border-radius:var(--rw-r-md);background:var(--rw-surface);overflow:hidden}
.rw-root .rw-side-head{padding:10px var(--rw-space-3);font-size:var(--rw-fs-11);letter-spacing:.1em;
  text-transform:uppercase;color:var(--rw-text-dim);border-bottom:1px solid var(--rw-border)}
.rw-root .rw-server{display:flex;align-items:center;gap:var(--rw-space-2);padding:10px var(--rw-space-3);
  cursor:pointer;border-left:2px solid transparent}
.rw-root .rw-server:hover{background:var(--rw-surface-2)}
.rw-root .rw-server.active{background:var(--rw-surface-2);border-left-color:var(--rw-primary)}
.rw-root .rw-server .rw-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-root .rw-server .rw-count{font-size:var(--rw-fs-11);color:var(--rw-text-dim)}

/* ── Таблицы ───────────────────────────────────────────────────────── */
.rw-root .rw-table{width:100%;min-width:600px;border-collapse:collapse;font-size:var(--rw-fs-13)}
.rw-root .rw-table th,.rw-root .rw-table td{text-align:left;padding:10px var(--rw-space-2);
  border-bottom:1px solid var(--rw-border);vertical-align:top}
.rw-root .rw-table th{font-size:var(--rw-fs-11);letter-spacing:.08em;text-transform:uppercase;
  color:var(--rw-text-dim);font-weight:600;white-space:nowrap}
.rw-root .rw-table tr:last-child td{border-bottom:none}
.rw-root .rw-table tbody tr:hover{background:var(--rw-surface-2)}

.rw-root .rw-badge{display:inline-flex;align-items:center;height:22px;padding:0 var(--rw-space-2);
  border-radius:999px;font-size:var(--rw-fs-11);border:1px solid var(--rw-border);color:var(--rw-text-dim);white-space:nowrap}
.rw-root .rw-badge.ok{color:var(--rw-ok);border-color:color-mix(in srgb,var(--rw-ok) 45%,transparent)}
.rw-root .rw-badge.bad{color:var(--rw-danger);border-color:color-mix(in srgb,var(--rw-danger) 45%,transparent)}
.rw-root .rw-badge.warn{color:var(--rw-warn);border-color:color-mix(in srgb,var(--rw-warn) 45%,transparent)}

/* ── Модальные окна ────────────────────────────────────────────────── */
.rw-root .rw-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;
  padding:var(--rw-space-6) var(--rw-space-4);overflow:auto;background:var(--rw-overlay);backdrop-filter:blur(2px)}
.rw-root .rw-modal{width:min(760px,100%);max-height:calc(100dvh - 48px);overflow:auto;
  background:var(--rw-surface);border:1px solid var(--rw-border);border-radius:var(--rw-r-md);
  box-shadow:var(--rw-shadow-md);padding:var(--rw-space-4) var(--rw-space-5);color:var(--rw-text)}
.rw-root .rw-modal.wide{width:min(880px,100%)}
.rw-root .rw-modal h3{margin:0;font-size:var(--rw-fs-16);font-weight:600}
.rw-root .rw-modal-head{display:flex;align-items:center;gap:var(--rw-space-3);margin-bottom:var(--rw-space-3);min-width:0}
.rw-root .rw-modal-head>h3,.rw-root .rw-modal-head>div{flex:1;min-width:0}
.rw-root .rw-modal-actions{display:flex;gap:var(--rw-space-2);justify-content:flex-end;
  margin-top:var(--rw-space-4);flex-wrap:wrap}

/* ── Формы ─────────────────────────────────────────────────────────── */
.rw-root .rw-form{display:grid;grid-template-columns:1fr 1fr;gap:var(--rw-space-3) var(--rw-space-4)}
.rw-root .rw-field{display:flex;flex-direction:column;gap:var(--rw-space-1);min-width:0}
.rw-root .rw-field.full{grid-column:1/-1}
.rw-root .rw-field label{font-size:var(--rw-fs-12);font-weight:500;color:var(--rw-text-dim)}
.rw-root .rw-field input,.rw-root .rw-field select,.rw-root .rw-field textarea,
.rw-root .rw-path input{width:100%;min-height:34px;border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);
  background:var(--rw-surface-2);color:var(--rw-text);padding:6px 10px;font:inherit;font-size:var(--rw-fs-13);
  transition:border-color .15s,box-shadow .15s}
.rw-root .rw-field input:hover,.rw-root .rw-field select:hover,.rw-root .rw-field textarea:hover,
.rw-root .rw-path input:hover{border-color:var(--rw-border-strong)}
.rw-root .rw-field input:focus,.rw-root .rw-field select:focus,.rw-root .rw-field textarea:focus,
.rw-root .rw-path input:focus{border-color:var(--rw-primary);box-shadow:0 0 0 3px var(--rw-primary-soft);outline:none}
.rw-root .rw-field textarea{min-height:64px;resize:vertical}
.rw-root .rw-hint{font-size:var(--rw-fs-11);color:var(--rw-text-dim);line-height:1.45}
.rw-root .rw-checks{display:flex;flex-direction:column;gap:var(--rw-space-2)}
.rw-root .rw-check{display:flex;align-items:center;gap:var(--rw-space-2);font-size:var(--rw-fs-13);cursor:pointer}
.rw-root .rw-check input{width:16px;height:16px;accent-color:var(--rw-primary);cursor:pointer}
.rw-root .rw-row{display:flex;gap:var(--rw-space-2);flex-wrap:wrap;align-items:center;min-width:0}

/* ── Список путей ──────────────────────────────────────────────────── */
.rw-root .rw-paths{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;
  border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);padding:var(--rw-space-1);background:var(--rw-surface-2)}
.rw-root .rw-path{display:grid;grid-template-columns:max-content minmax(0,1fr) auto;
  align-items:center;gap:6px;padding:4px 6px;border-radius:var(--rw-r-sm);font-size:var(--rw-fs-12);position:relative}
.rw-root .rw-path:hover{background:var(--rw-surface-3)}
.rw-root .rw-path.editing{grid-template-columns:max-content max-content minmax(0,1fr);background:var(--rw-surface-3)}
.rw-root .rw-path-main{display:flex;align-items:baseline;gap:5px;min-width:0}
.rw-root .rw-path-main .rw-path-text{flex:1}
.rw-root .rw-path-grip{color:var(--rw-text-dim);cursor:grab;user-select:none;text-align:center;font-size:12px;line-height:1;flex:none}
.rw-root .rw-path-grip:active{cursor:grabbing}
.rw-root .rw-path-n{color:var(--rw-text-dim);font-variant-numeric:tabular-nums;flex:none;min-width:0}
.rw-root .rw-path-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--rw-text);font-family:var(--rw-mono)}
.rw-root .rw-path-actions{display:flex;align-items:center;gap:1px;justify-self:end}
.rw-root .rw-path-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  border:none;background:transparent;color:var(--rw-text-dim);cursor:pointer;font-size:13px;line-height:1;border-radius:4px;flex:none;
  transition:background .12s,color .12s}
.rw-root .rw-path-btn:hover:not(:disabled){background:var(--rw-surface-3);color:var(--rw-text)}
.rw-root .rw-path-btn:disabled{opacity:.3;cursor:default}
.rw-root .rw-path-btn.danger:hover:not(:disabled){color:var(--rw-danger)}
.rw-root .rw-path.dragging{opacity:.45}
.rw-root .rw-path.drop-above::before,.rw-root .rw-path.drop-below::after{content:'';position:absolute;left:0;right:0;height:2px;background:var(--rw-primary);border-radius:1px}
.rw-root .rw-path.drop-above::before{top:-1px}
.rw-root .rw-path.drop-below::after{bottom:-1px}

/* ── Уведомления ───────────────────────────────────────────────────── */
.rw-root .rw-notice{border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);
  padding:var(--rw-space-2) 10px;font-size:var(--rw-fs-12);color:var(--rw-text-dim);background:var(--rw-surface-2)}
.rw-root .rw-notice.warn{color:var(--rw-warn);border-color:color-mix(in srgb,var(--rw-warn) 40%,transparent)}
.rw-root .rw-notice.bad{color:var(--rw-danger);border-color:color-mix(in srgb,var(--rw-danger) 40%,transparent)}
.rw-root .rw-toast{position:fixed;right:var(--rw-space-4);bottom:var(--rw-space-4);z-index:90;
  border:1px solid var(--rw-border);border-left:3px solid var(--rw-border-strong);border-radius:var(--rw-r-sm);
  padding:10px var(--rw-space-3);background:var(--rw-surface);color:var(--rw-text);
  box-shadow:var(--rw-shadow-md);max-width:min(420px,calc(100vw - 32px));font-size:var(--rw-fs-13)}
.rw-root .rw-toast.ok{border-left-color:var(--rw-ok)}
.rw-root .rw-toast.bad{border-left-color:var(--rw-danger)}

/* ── Пикер файлов ──────────────────────────────────────────────────── */
.rw-root .rw-picker-list{border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);max-height:340px;overflow:auto;margin-top:var(--rw-space-2)}
.rw-root .rw-picker-row{display:flex;align-items:center;gap:var(--rw-space-2);padding:7px 10px;
  border-bottom:1px solid var(--rw-border);cursor:default;font-size:var(--rw-fs-13)}
.rw-root .rw-picker-row:last-child{border-bottom:none}
.rw-root .rw-picker-row:hover{background:var(--rw-surface-2)}
.rw-root .rw-picker-row .rw-ico{width:16px;text-align:center;opacity:.8;flex:none}
.rw-root .rw-picker-row .rw-pname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--rw-mono);font-size:var(--rw-fs-12)}
.rw-root .rw-picker-row .rw-psize{font-size:var(--rw-fs-11);color:var(--rw-text-dim);flex:none}
.rw-root .rw-crumbs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;font-size:var(--rw-fs-12);margin-top:var(--rw-space-2)}
.rw-root .rw-crumbs button{border:none;background:transparent;color:var(--rw-primary);cursor:pointer;font:inherit;padding:2px 4px;border-radius:4px}
.rw-root .rw-crumbs button:hover{background:var(--rw-surface-2)}
.rw-root .rw-crumbs span{color:var(--rw-text-dim)}
.rw-root .rw-pre{font-family:var(--rw-mono);font-size:var(--rw-fs-12);white-space:pre-wrap;word-break:break-word;
  max-height:320px;overflow:auto;border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);
  padding:10px;background:var(--rw-surface-2);color:var(--rw-text)}

/* ── Шаги истории ──────────────────────────────────────────────────── */
.rw-root .rw-steps{display:flex;flex-direction:column;gap:2px;font-size:var(--rw-fs-13);margin-top:var(--rw-space-2);color:var(--rw-text)}
.rw-root .rw-step{border-radius:var(--rw-r-sm);border:1px solid transparent}
.rw-root .rw-step[open]{background:var(--rw-surface-2);border-color:var(--rw-border)}
.rw-root .rw-step>summary{cursor:pointer;display:grid;
  grid-template-columns:2.1rem 6.8rem 1rem max-content minmax(0,1fr) auto;
  gap:var(--rw-space-2);align-items:center;list-style:none;
  padding:6px var(--rw-space-2);border-radius:var(--rw-r-sm);color:var(--rw-text)}
.rw-root .rw-step>summary::-webkit-details-marker{display:none}
.rw-root .rw-step>summary:hover{background:var(--rw-surface-3)}
.rw-root .rw-step-n{justify-self:start;min-width:1.9rem;text-align:center;font-family:var(--rw-mono);
  font-size:var(--rw-fs-11);color:var(--rw-text-dim);background:var(--rw-surface-3);
  border-radius:4px;padding:2px 4px;font-variant-numeric:tabular-nums}
.rw-root .rw-step-clock{font-family:var(--rw-mono);font-size:var(--rw-fs-12);
  color:var(--rw-text-dim);font-variant-numeric:tabular-nums}
.rw-root .rw-step-ok{color:var(--rw-ok);font-weight:700}
.rw-root .rw-step-bad{color:var(--rw-danger);font-weight:700}
.rw-root .rw-step-label{color:var(--rw-text);font-weight:600;white-space:nowrap}
.rw-root .rw-step-label.bad{color:var(--rw-danger)}
.rw-root .rw-step-hint{color:var(--rw-text-dim);font-size:var(--rw-fs-12);min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* В раскрытом шаге полный текст уже есть в теле — подсказку убираем. */
.rw-root .rw-step[open] .rw-step-hint{display:none}
.rw-root .rw-step-ms{justify-self:end;font-family:var(--rw-mono);font-size:var(--rw-fs-12);
  color:var(--rw-text-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
.rw-root .rw-step-body{display:flex;flex-direction:column;gap:var(--rw-space-3);
  padding:var(--rw-space-1) var(--rw-space-2) var(--rw-space-3) calc(2.1rem + var(--rw-space-2))}
.rw-root .rw-step-detail{font-size:var(--rw-fs-12);line-height:1.55;word-break:break-word;color:var(--rw-text)}
.rw-root .rw-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 20px;
  border-top:1px solid var(--rw-border);padding-top:var(--rw-space-2);
  font-size:var(--rw-fs-12);align-items:baseline}
.rw-root .rw-kv-key{color:var(--rw-text-dim)}
.rw-root .rw-kv-key::after{content:':'}
.rw-root .rw-kv-val{font-variant-numeric:tabular-nums;word-break:break-word;color:var(--rw-text)}
.rw-root .rw-step-lists{display:flex;flex-direction:column;gap:var(--rw-space-1)}
.rw-root .rw-step-paths summary{cursor:pointer;color:var(--rw-primary);font-size:var(--rw-fs-12)}
.rw-root .rw-details summary{cursor:pointer;color:var(--rw-primary);font-size:var(--rw-fs-12)}
.rw-root .rw-inline{display:inline-flex;align-items:center;gap:6px}
.rw-root .rw-dim{color:var(--rw-text-dim)}

/* ── Адаптив ───────────────────────────────────────────────────────── */
@media (max-width:980px){
  .rw-root .rw-grid{grid-template-columns:1fr}
  .rw-root .rw-form{grid-template-columns:1fr}
}
@media (max-width:720px){
  .rw-root{padding:var(--rw-space-3)}
  .rw-root .rw-head{flex-direction:column;align-items:stretch;gap:var(--rw-space-2)}
  .rw-root .rw-title{margin-right:0}
  .rw-root .rw-head-actions{justify-content:flex-start}
  .rw-root .rw-card-head{flex-wrap:wrap}
  .rw-root .rw-card h4{white-space:normal}
  .rw-root .rw-actions .rw-btn{flex:1 1 auto}
  .rw-root .rw-step>summary{grid-template-columns:1.9rem 4.6rem 1rem minmax(0,max-content) auto;row-gap:2px}
  .rw-root .rw-step-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .rw-root .rw-step-hint{display:none}
  .rw-root .rw-step-body{padding-left:var(--rw-space-2)}
  .rw-root .rw-overlay{padding:0}
  .rw-root .rw-modal,.rw-root .rw-modal.wide{width:100%;max-height:100dvh;min-height:100dvh;
    border-radius:0;border:none;padding:var(--rw-space-4)}
  .rw-root .rw-table{min-width:520px}
  .rw-root .rw-toast{left:var(--rw-space-2);right:var(--rw-space-2);bottom:var(--rw-space-2);max-width:none}
}
@media (max-width:420px){
  .rw-root .rw-title b{font-size:var(--rw-fs-16)}
  .rw-root .rw-actions{gap:var(--rw-space-1)}
  .rw-root .rw-actions .rw-btn{flex:1 1 100%}
  .rw-root .rw-path{gap:4px;padding:4px}
  .rw-root .rw-path-actions{gap:0}
}

@media (max-width:480px){
  /* На телефоне время шага переносим под подпись, чтобы она не сжималась. */
  .rw-root .rw-step>summary{
    grid-template-columns:1.9rem 1rem minmax(0,1fr) auto;
    grid-template-areas:"n s l m" ". . t .";
    row-gap:2px;align-items:center}
  .rw-root .rw-step-n{grid-area:n}
  .rw-root .rw-step-ok,.rw-root .rw-step-bad{grid-area:s}
  .rw-root .rw-step-label{grid-area:l;white-space:normal;overflow:visible}
  .rw-root .rw-step-ms{grid-area:m}
  .rw-root .rw-step-clock{grid-area:t;justify-self:start;font-size:var(--rw-fs-11)}
}
@media (prefers-reduced-motion:reduce){
  .rw-root *{transition:none !important}
}

/* Колонка «Детали» не должна сжиматься в ноль на узких экранах. */
.rw-root .rw-table th:last-child,.rw-root .rw-table td:last-child{min-width:220px}
@media (max-width:720px){
  .rw-root .rw-meta{gap:4px 10px}
}
/* Футер модалки остаётся видимым при прокрутке формы. */
.rw-root .rw-modal-actions{position:sticky;bottom:calc(var(--rw-space-4) * -1);
  padding:var(--rw-space-3) 0 var(--rw-space-1);background:var(--rw-surface)}
`;
  document.head.appendChild(style);
}

// ── Приложение ────────────────────────────────────────────────────────────

// ── Шаги вайпа: подписи и форматирование ──────────────────────────────────

const STEP_LABELS = {
  server: 'Сервер',
  stop: 'Остановка',
  map: 'Сид и размер',
  expand: 'Поиск путей',
  delete: 'Удаление',
  start: 'Запуск',
  command: 'Команда в консоль',
  error: 'Ошибка',
  'restore-start': 'Восстановление запуска',
};

const DATA_LABELS = {
  status: 'Статус',
  changed: 'Изменено',
  seed: 'Сид',
  size: 'Размер',
  paths: 'Найдено путей',
  truncated: 'Список обрезан',
  deleted: 'Удалено',
  skipped: 'Пропущено',
  errors: 'Ошибок',
  dryRun: 'Режим проверки',
  started: 'Запуск',
  timeoutSec: 'Таймаут, с',
  command: 'Команда',
  message: 'Сообщение',
};

/** Первая буква заглавная — тексты шагов приходят из бэкенда строчными. */
function sentence(text) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} с`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} мин ${seconds} с`;
}

function fmtDataValue(value) {
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function fmtClock(iso, offsetMinutes) {
  const raw = String(iso || '');
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(11, 19) || '—';
  const shifted = new Date(t + (Number(offsetMinutes) || 0) * 60000).toISOString();
  return `${shifted.slice(11, 19)}.${shifted.slice(20, 23)}`;
}

function buildKvList(data) {
  const rows = Object.entries(data).filter(
    ([key, value]) => key !== 'ms' && value !== null && value !== undefined && value !== '',
  );
  if (!rows.length) return null;
  return el(
    'div',
    { class: 'rw-kv' },
    ...rows.flatMap(([key, value]) => [
      el('span', { class: 'rw-kv-key', text: DATA_LABELS[key] || key }),
      el('span', { class: 'rw-kv-val', text: fmtDataValue(value) }),
    ]),
  );
}

function pathList(title, items) {
  return el(
    'details',
    { class: 'rw-step-paths' },
    el('summary', null, `${title} (${items.length})`),
    el('div', { class: 'rw-pre' }, items.join('\n')),
  );
}

function blankDraft(serverId) {
  return {
    id: null,
    name: '',
    serverId: serverId || '',
    enabled: true,
    schedule: {
      kind: 'weekly',
      weekday: 4,
      nth: 1,
      day: 1,
      time: '05:00',
      intervalDays: 7,
      anchorDate: null,
    },
    targets: [],
    excludes: [],
    options: { stopServer: true, startServer: true, dryRun: false, warnChat: true, commandsAfter: [] },
    map: {
      seed: { mode: 'random', value: null, values: [] },
      size: { mode: 'fixed', value: 3000, values: [2000, 3000, 4000, 5000, 6000] },
      vars: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
    },
  };
}

class App {
  constructor(root, serverId) {
    this.root = root;
    this.serverId = String(serverId || '');
    this.state = {
      loading: true,
      error: null,
      status: null,
      server: null,
      profiles: [],
      runs: [],
      presets: [],
      modal: null,
      picker: null,
      pathEdit: null,
      preview: null,
      toast: null,
      busy: false,
    };
    this.toastTimer = null;
  }

  apiBase() {
    return `servers/${encodeURIComponent(this.serverId)}`;
  }

  async start() {
    ensureStyles();
    this.applyTheme();
    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', () => this.applyTheme());
      }
    }
    // Панель переключает тему без перезагрузки: следим за атрибутами html.
    if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.documentElement) {
      this.themeObserver = new MutationObserver(() => this.applyTheme());
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'data-mode', 'data-color-scheme'],
      });
    }
    this.render();
    await this.reload();
    this.clockTimer = setInterval(() => {
      if (!this.root.isConnected) {
        clearInterval(this.clockTimer);
        return;
      }
      const chip = this.root.querySelector('[data-rw-clock]');
      if (chip && this.state.status) chip.textContent = this.panelClockText();
      // Страховка для панелей, меняющих тему без атрибутов на html.
      this.applyTheme();
    }, 15000);
  }

  applyTheme() {
    this.root.dataset.rwTheme = detectTheme();
  }

  panelClockText() {
    const offset = Number(this.state.status?.clock?.offsetMinutes ?? 0);
    const shifted = new Date(Date.now() + offset * 60000).toISOString();
    return `${shifted.slice(11, 16)} · UTC${offset >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  }

  async reload() {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    if (!this.serverId) {
      this.state.loading = false;
      this.state.error = 'Вкладка открыта без сервера: плагин работает только в контексте сервера.';
      this.render();
      return;
    }

    const base = this.apiBase();
    try {
      const [status, profiles, presets] = await Promise.all([
        api(`${base}/status`),
        api(`${base}/profiles`),
        api('presets'),
      ]);
      this.state.status = status;
      this.state.server = status?.server || null;
      this.state.profiles = Array.isArray(profiles) ? profiles : [];
      this.state.presets = Array.isArray(presets) ? presets : [];
      this.state.runs = await api(`${base}/runs?limit=60`);
    } catch (error) {
      this.state.error = error.message;
    }
    this.state.loading = false;
    this.render();
  }

  async refreshRuns() {
    const base = this.apiBase();
    try {
      this.state.runs = await api(`${base}/runs?limit=60`);
      this.state.profiles = await api(`${base}/profiles`);
    } catch (error) {
      this.toast('bad', error.message);
    }
    this.render();
  }

  toast(type, text) {
    this.state.toast = { type, text };
    this.render();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.state.toast = null;
      this.render();
    }, 4500);
  }

  render() {
    clear(this.root);
    this.root.classList.add('rw-root');

    if (this.state.loading && !this.state.status) {
      append(this.root, [el('div', { class: 'rw-empty', text: 'Загружаю данные плагина…' })]);
      return;
    }
    if (this.state.error && !this.state.status) {
      append(this.root, [
        el('div', { class: 'rw-notice bad', text: `Не удалось загрузить данные: ${this.state.error}` }),
        el('div', { class: 'rw-actions' }, el('button', { class: 'rw-btn', onclick: () => this.reload() }, 'Повторить')),
      ]);
      return;
    }

    append(this.root, [
      this.renderHeader(),
      this.renderMain(),
      this.renderRuns(),
      this.state.toast
        ? el('div', { class: `rw-toast ${this.state.toast.type}` }, this.state.toast.text)
        : null,
      this.renderModal(),
    ]);

    // Инлайн-правка пути: после перерисовки возвращаем фокус в поле.
    const editInput = this.root.querySelector('[data-rw-path-edit]');
    if (editInput) {
      editInput.focus();
      if (typeof editInput.setSelectionRange === 'function') {
        const end = editInput.value.length;
        editInput.setSelectionRange(end, end);
      }
    }
  }

  renderHeader() {
    const status = this.state.status || {};
    const chips = [];
    if (this.state.server) {
      chips.push(
        el(
          'span',
          { class: 'rw-chip' },
          `${this.state.server.name} · ${statusLabel(this.state.server.status)}`,
        ),
      );
    }
    chips.push(el('span', { class: 'rw-chip', 'data-rw-clock': '1' }, this.panelClockText()));
    chips.push(
      status.hasApiKey
        ? el('span', { class: 'rw-chip ok' }, el('i', { class: 'rw-dot' }), 'API-ключ задан')
        : el('span', { class: 'rw-chip bad' }, el('i', { class: 'rw-dot' }), 'Нет API-ключа'),
    );
    if (status.dryRun) {
      chips.push(el('span', { class: 'rw-chip warn' }, 'Глобальный dry-run'));
    }
    const warnState = status.wipeWarning && status.wipeWarning.state;
    if (warnState && warnState.ok === false) {
      chips.push(
        el(
          'span',
          {
            class: 'rw-chip bad',
            title: `${warnState.error || 'ошибка'}${warnState.at ? ` · ${warnState.at}` : ''}`,
          },
          el('i', { class: 'rw-dot' }),
          'Чат: ошибка предупреждения',
        ),
      );
    } else if (warnState && warnState.ok === true) {
      chips.push(
        el(
          'span',
          {
            class: 'rw-chip ok',
            title: `${warnState.text || ''}${warnState.at ? ` · ${warnState.at}` : ''}`,
          },
          el('i', { class: 'rw-dot' }),
          'Чат: ок',
        ),
      );
    }
    if (status.schedulerEnabled === false) {
      chips.push(el('span', { class: 'rw-chip warn' }, 'Планировщик выключен'));
    }
    if (status.permissions && status.permissions.canManage === false) {
      chips.push(el('span', { class: 'rw-chip' }, 'Только просмотр'));
    }
    if (status.version) chips.push(el('span', { class: 'rw-chip' }, `v${status.version}`));

    return el(
      'header',
      { class: 'rw-head' },
      el(
        'div',
        { class: 'rw-title' },
        el('b', null, 'Rust AutoWipe'),
        el('span', null, 'расписание вайпов и удаление файлов'),
      ),
      el('div', { class: 'rw-chips' }, ...chips),
      el(
        'div',
        { class: 'rw-head-actions' },
        status.permissions?.canManage === true
          ? el(
              'button',
              {
                class: 'rw-btn',
                title: 'Проверить API-ключ панели',
                onclick: () => this.checkPanel(),
              },
              'Диагностика',
            )
          : null,
        el('button', { class: 'rw-btn', onclick: () => this.reload() }, 'Обновить'),
      ),
    );
  }

  renderMain() {
    const profiles = this.state.profiles;
    const canManage = this.state.status?.permissions?.canManage === true;
    const canRun = this.state.status?.permissions?.canRun === true;

    const header = el(
      'div',
      { class: 'rw-toolbar' },
      el(
        'h3',
        null,
        'Профили вайпа',
        this.state.server
          ? el('span', { class: 'rw-dim' }, ` · ${this.state.server.name}`)
          : null,
      ),
      el('span', { class: 'rw-spacer' }),
      canManage
        ? el(
            'button',
            { class: 'rw-btn primary', onclick: () => this.openEditor(null) },
            '+ Новый профиль',
          )
        : el(
            'span',
            { class: 'rw-dim' },
            'Изменение профилей — только у роли с rust-autowipe.manage',
          ),
    );

    const body = [];
    if (!profiles.length) {
      body.push(
        el(
          'div',
          { class: 'rw-empty' },
          'Профилей пока нет. Создайте профиль: расписание и файлы/каталоги, которые удаляются при вайпе этого сервера.',
        ),
      );
    } else {
      for (const profile of profiles) body.push(this.renderProfileCard(profile, { canManage, canRun }));
    }

    return el('main', { class: 'rw-main' }, header, ...body);
  }

  renderProfileCard(profile, { canManage, canRun }) {
    const offset = Number(this.state.status?.clock?.offsetMinutes ?? 0);
    const statusChip = profile.running
      ? el('span', { class: 'rw-badge warn' }, 'выполняется')
      : profile.lastRunStatus === 'ok'
        ? el('span', { class: 'rw-badge ok' }, 'последний: ок')
        : profile.lastRunStatus === 'failed'
          ? el('span', { class: 'rw-badge bad' }, 'последний: ошибка')
          : el('span', { class: 'rw-badge' }, 'ещё не запускался');

    const actions = [];
    if (canRun) {
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn',
            disabled: profile.running || this.state.busy,
            onclick: () => this.runProfile(profile),
          },
          'Запустить сейчас',
        ),
      );
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn',
            disabled: this.state.busy,
            onclick: () => this.runProfile(profile, true),
          },
          'Проверка (dry-run)',
        ),
      );
    }
    actions.push(
      el('button', { class: 'rw-btn', disabled: this.state.busy, onclick: () => this.previewProfile(profile) }, 'Что будет удалено'),
    );
    if (canRun) {
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn',
            disabled: this.state.busy,
            title: 'Отправить одно предупреждение в чат сервера прямо сейчас',
            onclick: () => this.testWarn(profile),
          },
          'Тест предупреждения',
        ),
      );
    }
    if (canManage) {
      actions.push(el('button', { class: 'rw-btn', onclick: () => this.openEditor(profile) }, 'Изменить'));
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn',
            onclick: () => this.toggleProfile(profile),
          },
          profile.enabled ? 'Выключить' : 'Включить',
        ),
      );
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn danger',
            onclick: () => this.confirmDelete(profile),
          },
          'Удалить',
        ),
      );
    }

    return el(
      'div',
      { class: 'rw-card' },
      el(
        'div',
        { class: 'rw-card-head' },
        el('span', {
          class: 'rw-dot',
          style: { background: profile.enabled ? 'var(--rw-ok)' : 'rgba(148,163,184,.5)' },
        }),
        el(
          'div',
          { class: 'rw-grow' },
          el('h4', null, profile.name),
          el(
            'div',
            { class: 'rw-meta' },
            el('span', null, profile.serverName || this.state.server?.name || '—'),
            el('span', null, scheduleText(profile.schedule)),
            el('span', null, `путей: ${(profile.targets || []).length}`),
            profile.mapText ? el('span', null, profile.mapText) : null,
            el('span', null, profile.enabled ? 'включён' : 'выключен'),
          ),
        ),
        statusChip,
      ),
      el(
        'div',
        { class: 'rw-meta' },
        el(
          'span',
          null,
          'Следующий запуск: ',
          el('b', null, formatPanelDate(profile.nextRunAt, offset)),
          profile.nextRunAt ? ` (${humanDelta(profile.nextRunAt)})` : '',
        ),
        profile.lastRunAt
          ? el('span', null, `Последний: ${formatPanelDate(profile.lastRunAt, offset)}`)
          : null,
        profile.lastError
          ? el('span', { style: { color: 'var(--rw-danger)' } }, `Ошибка: ${profile.lastError}`)
          : null,
      ),
      el('div', { class: 'rw-actions' }, ...actions),
    );
  }

  /** Один шаг вайпа: сводная строка + раскрытие с полным текстом и метриками. */
  renderStep(step, index, run, offset) {
    const ok = step.ok !== false;
    const label = STEP_LABELS[step.action] || step.action || 'шаг';
    const data = step.data && typeof step.data === 'object' ? step.data : {};
    const ms = typeof data.ms === 'number' ? data.ms : null;

    const detailText = sentence(step.detail);
    const head = [
      el('span', { class: 'rw-step-n', text: pad2(index + 1) }),
      el('span', { class: 'rw-step-clock', text: fmtClock(step.at, offset) }),
      el('span', { class: ok ? 'rw-step-ok' : 'rw-step-bad', text: ok ? '✓' : '✕' }),
      el('span', { class: ok ? 'rw-step-label' : 'rw-step-label bad' }, label),
      detailText ? el('span', { class: 'rw-step-hint', title: detailText, text: detailText }) : null,
      ms !== null ? el('span', { class: 'rw-step-ms', text: fmtDuration(ms) }) : null,
    ];

    const body = [detailText ? el('div', { class: 'rw-step-detail' }, detailText) : null, buildKvList(data)];

    if (step.action === 'delete' && run) {
      const lists = [];
      const deleted = Array.isArray(run.deleted) ? run.deleted : [];
      if (deleted.length) lists.push(pathList('Удалённые пути', deleted));
      const skipped = Array.isArray(run.skipped) ? run.skipped : [];
      if (skipped.length) {
        lists.push(
          pathList(
            'Пропущенные пути',
            skipped.map((item) => `${item.path}${item.reason ? ` — ${sentence(item.reason)}` : ''}`),
          ),
        );
      }
      if (lists.length) body.push(el('div', { class: 'rw-step-lists' }, ...lists));
    }

    const children = body.filter(Boolean);

    return el(
      'details',
      { class: 'rw-step' },
      el('summary', null, ...head),
      children.length ? el('div', { class: 'rw-step-body' }, ...children) : null,
    );
  }

  renderRuns() {
    const offset = Number(this.state.status?.clock?.offsetMinutes ?? 0);
    const rows = this.state.runs.slice(0, 30).map((run) =>
      el(
        'tr',
        null,
        el('td', { text: formatPanelDate(run.startedAt, offset) }),
        el('td', { text: run.profileName || run.profileId }),
        el('td', { text: run.trigger === 'schedule' ? 'расписание' : 'вручную' }),
        el(
          'td',
          null,
          el(
            'span',
            { class: `rw-badge ${run.ok ? 'ok' : 'bad'}` },
            run.dryRun ? 'dry-run' : run.ok ? 'успешно' : 'ошибка',
          ),
        ),
        el('td', { text: String(run.deletedCount ?? (run.deleted || []).length) }),
        el(
          'td',
          null,
          el(
            'details',
            { class: 'rw-details' },
            el('summary', null, `шаги (${(run.steps || []).length})`),
            el(
              'div',
              { class: 'rw-steps' },
              ...(run.steps || []).map((step, index) => this.renderStep(step, index, run, offset)),
              ...(run.errors || []).map((error) =>
                el(
                  'div',
                  { class: 'rw-step' },
                  el('div', { class: 'rw-step-detail', style: { color: 'var(--rw-danger)' } }, `✕ ${error}`),
                ),
              ),
              ...(run.warnings || []).map((warning) =>
                el(
                  'div',
                  { class: 'rw-step' },
                  el('div', { class: 'rw-step-detail', style: { color: 'var(--rw-warn)' } }, `! ${warning}`),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    return el(
      'div',
      { class: 'rw-panel-block' },
      el(
        'h3',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        'История запусков',
        el(
          'button',
          { class: 'rw-btn small', style: { marginLeft: 'auto', textTransform: 'none' }, onclick: () => this.refreshRuns() },
          'обновить',
        ),
      ),
      this.state.runs.length
        ? el(
            'table',
            { class: 'rw-table' },
            el(
              'thead',
              null,
              el(
                'tr',
                null,
                el('th', null, 'Когда'),
                el('th', null, 'Профиль'),
                el('th', null, 'Запуск'),
                el('th', null, 'Результат'),
                el('th', null, 'Удалено'),
                el('th', null, 'Детали'),
              ),
            ),
            el('tbody', null, ...rows),
          )
        : el('div', { class: 'rw-dim' }, 'Запусков ещё не было.'),
    );
  }

  // ── Модальные окна ──────────────────────────────────────────────────────

  closeModal() {
    this.state.modal = null;
    this.state.preview = null;
    this.state.pathEdit = null;
    this.render();
  }

  /** Вернуться из выбора файлов в редактор, сохранив черновик профиля. */
  backToEditor() {
    const picker = this.state.modal;
    if (!picker || picker.type !== 'picker') return;
    this.state.pathEdit = null;
    this.state.modal = { type: 'editor', draft: picker.draft };
    this.render();
  }

  /** Список путей: перемещение, дублирование, правка и удаление строк. */
  movePathItem(kind, index, delta) {
    const draft = this.draft();
    const list = draft && draft[kind];
    const next = index + delta;
    if (!Array.isArray(list) || next < 0 || next >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(next, 0, item);
    this.state.pathEdit = null;
    this.render();
  }

  duplicatePathItem(kind, index) {
    const draft = this.draft();
    const list = draft && draft[kind];
    if (!Array.isArray(list) || list[index] === undefined) return;
    list.splice(index + 1, 0, list[index]);
    this.state.pathEdit = null;
    this.render();
  }

  /** Перетаскивание: вставить строку до или после targetIndex. */
  dropPathItem(kind, targetIndex, after) {
    const source = this.dragPath;
    this.dragPath = null;
    const draft = this.draft();
    const list = draft && draft[kind];
    if (!source || source.kind !== kind || !Array.isArray(list)) {
      this.render();
      return;
    }
    let to = targetIndex + (after ? 1 : 0);
    if (source.index < to) to -= 1;
    if (to === source.index) {
      this.render();
      return;
    }
    const [item] = list.splice(source.index, 1);
    list.splice(to, 0, item);
    this.state.pathEdit = null;
    this.render();
  }

  removePathItem(kind, index) {
    const draft = this.draft();
    const list = draft && draft[kind];
    if (!Array.isArray(list)) return;
    list.splice(index, 1);
    this.state.pathEdit = null;
    this.render();
  }

  startPathEdit(kind, index) {
    this.state.pathEdit = { kind, index };
    this.render();
  }

  commitPathEdit(value) {
    const edit = this.state.pathEdit;
    if (!edit) return;
    const draft = this.draft();
    const list = draft && draft[edit.kind];
    const next = String(value == null ? '' : value).trim();
    this.state.pathEdit = null;
    if (Array.isArray(list) && next && list[edit.index] !== undefined) {
      list[edit.index] = next;
      // Одинаковые пути в списке бессмысленны — схлопываем, сохраняя порядок.
      const unique = list.filter((item, position) => list.indexOf(item) === position);
      if (unique.length !== list.length) list.splice(0, list.length, ...unique);
    }
    this.render();
  }

  cancelPathEdit() {
    if (!this.state.pathEdit) return;
    this.state.pathEdit = null;
    this.render();
  }

  renderModal() {
    if (this.state.preview) return this.renderPreviewModal();
    if (!this.state.modal) return null;
    if (this.state.modal.type === 'editor') return this.renderEditorModal();
    if (this.state.modal.type === 'picker') return this.renderPickerModal();
    if (this.state.modal.type === 'confirm') return this.renderConfirmModal();
    return null;
  }

  renderConfirmModal() {
    const { title, text, confirmLabel, onConfirm } = this.state.modal;
    return el(
      'div',
      {
        class: 'rw-overlay',
        onclick: (event) => {
          if (event.target === event.currentTarget) this.closeModal();
        },
      },
      el(
        'div',
        { class: 'rw-modal' },
        el('div', { class: 'rw-modal-head' }, el('h3', null, title)),
        el('p', null, text),
        el(
          'div',
          { class: 'rw-modal-actions' },
          el('button', { class: 'rw-btn', onclick: () => this.closeModal() }, 'Отмена'),
          el(
            'button',
            {
              class: 'rw-btn danger',
              onclick: async () => {
                this.closeModal();
                await onConfirm();
              },
            },
            confirmLabel || 'Удалить',
          ),
        ),
      ),
    );
  }

  openEditor(profile) {
    const draft = profile
      ? {
          ...clone(profile),
          schedule: clone(profile.schedule || blankDraft().schedule),
          options: { ...clone(profile.options || {}), commandsAfter: clone(profile.options?.commandsAfter || []) },
          map: clone(profile.map || blankDraft().map),
        }
      : blankDraft(this.serverId);
    if (!draft.name) draft.name = '';
    draft.serverId = this.serverId;
    this.state.pathEdit = null;
    this.state.modal = { type: 'editor', draft };
    this.render();
  }

  draft() {
    return this.state.modal && this.state.modal.type === 'editor' ? this.state.modal.draft : null;
  }

  /** Блок «Карта»: режимы сида/размера и имена переменных шаблона. */
  renderMapFields(draft) {
    const map = draft.map || (draft.map = blankDraft().map);
    const seed = map.seed;
    const size = map.size;
    const rerender = () => this.render();
    const field = (label, control) =>
      el('div', { class: 'rw-field' }, el('label', null, label), control);

    const seedMode = el(
      'select',
      {
        onchange: (event) => {
          seed.mode = event.target.value;
          rerender();
        },
      },
      el('option', { value: 'keep', selected: seed.mode === 'keep' ? '' : null }, 'Не менять сид'),
      el('option', { value: 'random', selected: seed.mode === 'random' ? '' : null }, 'Случайный при каждом вайпе'),
      el('option', { value: 'fixed', selected: seed.mode === 'fixed' ? '' : null }, 'Фиксированный'),
      el('option', { value: 'rotate', selected: seed.mode === 'rotate' ? '' : null }, 'По списку по очереди'),
    );

    const sizeMode = el(
      'select',
      {
        onchange: (event) => {
          size.mode = event.target.value;
          rerender();
        },
      },
      el('option', { value: 'keep', selected: size.mode === 'keep' ? '' : null }, 'Не менять размер'),
      el('option', { value: 'fixed', selected: size.mode === 'fixed' ? '' : null }, 'Фиксированный'),
      el('option', { value: 'random', selected: size.mode === 'random' ? '' : null }, 'Случайный из набора'),
    );

    const seedExtras = [];
    if (seed.mode === 'fixed') {
      seedExtras.push(
        field(
          'Значение сида (1…2147483647)',
          el('input', {
            type: 'number',
            min: '1',
            value: seed.value == null ? '' : String(seed.value),
            oninput: (event) => {
              seed.value = Number(event.target.value) || null;
            },
          }),
        ),
      );
    }
    if (seed.mode === 'rotate') {
      seedExtras.push(
        el(
          'div',
          { class: 'rw-field', style: { flex: '1', minWidth: '260px' } },
          el('label', null, 'Список сидов через запятую'),
          el(
            'textarea',
            {
              placeholder: '123456789, 987654321, 555000111',
              oninput: (event) => {
                seed.values = event.target.value
                  .split(/[\s,;]+/)
                  .map((part) => Number(part))
                  .filter((value) => Number.isInteger(value) && value >= 1 && value <= 2147483647);
              },
            },
            (seed.values || []).join(', '),
          ),
          el('span', { class: 'rw-hint' }, 'Сид выбирается по кругу: следующий вайп берёт следующий из списка.'),
        ),
      );
    }

    const sizeExtras = [];
    if (size.mode === 'fixed') {
      sizeExtras.push(
        field(
          'Размер (1000…6000)',
          el('input', {
            type: 'number',
            min: '1000',
            max: '6000',
            value: size.value == null ? '3000' : String(size.value),
            oninput: (event) => {
              size.value = Number(event.target.value) || null;
            },
          }),
        ),
      );
    }
    if (size.mode === 'random') {
      sizeExtras.push(
        el(
          'div',
          { class: 'rw-field', style: { flex: '1' } },
          el('label', null, 'Размеры в наборе'),
          el(
            'div',
            { class: 'rw-row' },
            ...[2000, 3000, 3500, 4000, 4500, 5000, 6000].map((value) =>
              el(
                'button',
                {
                  class: `rw-btn small${(size.values || []).includes(value) ? ' primary' : ''}`,
                  type: 'button',
                  onclick: () => {
                    const list = size.values || (size.values = []);
                    const index = list.indexOf(value);
                    if (index >= 0) list.splice(index, 1);
                    else list.push(value);
                    list.sort((a, b) => a - b);
                    rerender();
                  },
                },
                String(value),
              ),
            ),
          ),
        ),
      );
    }

    return el(
      'div',
      { class: 'rw-field full' },
      el('label', null, 'Карта (сид и размер)'),
      el(
        'div',
        { class: 'rw-row' },
        field('Сид', seedMode),
        ...seedExtras,
      ),
      el(
        'div',
        { class: 'rw-row' },
        field('Размер', sizeMode),
        ...sizeExtras,
      ),
      el(
        'div',
        { class: 'rw-row' },
        field(
          'Переменная сида',
          el('input', {
            type: 'text',
            value: map.vars.seed,
            placeholder: 'WORLD_SEED',
            oninput: (event) => {
              map.vars.seed = event.target.value.trim();
            },
          }),
        ),
        field(
          'Переменная размера',
          el('input', {
            type: 'text',
            value: map.vars.size,
            placeholder: 'WORLD_SIZE',
            oninput: (event) => {
              map.vars.size = event.target.value.trim();
            },
          }),
        ),
        el(
          'button',
          {
            class: 'rw-btn small',
            type: 'button',
            style: { alignSelf: 'flex-end' },
            onclick: () => this.detectMapVariables(draft),
          },
          'Определить из шаблона',
        ),
      ),
      el(
        'span',
        { class: 'rw-hint' },
        'Значения записываются в переменные шаблона перед запуском (нужно право server.startup у API-ключа). ' +
          'Если в startup шаблона нет {{WORLD_SEED}} / {{WORLD_SIZE}} — карта не изменится.',
      ),
    );
  }

  async detectMapVariables(draft) {
    try {
      const data = await api(`${this.apiBase()}/map-variables`);
      const detected = data?.detected || {};
      const names = (data?.variables || []).map((item) => item.name);
      if (detected.seed) draft.map.vars.seed = detected.seed;
      if (detected.size) draft.map.vars.size = detected.size;
      this.render();
      this.toast(
        detected.seed && detected.size ? 'ok' : 'warn',
        names.length
          ? `Переменные шаблона: ${names.join(', ')}`
          : 'В шаблоне не нашлось переменных — проверьте World Seed / World Size',
      );
    } catch (error) {
      this.toast('bad', error.message);
    }
  }

  renderEditorModal() {
    const draft = this.draft();
    if (!draft) return null;
    const canManage = this.state.status?.permissions?.canManage === true;

    const schedule = draft.schedule;

    const kindSelect = el(
      'select',
      {
        onchange: (event) => {
          draft.schedule.kind = event.target.value;
          this.render();
        },
      },
      el('option', { value: 'weekly', selected: schedule.kind === 'weekly' ? '' : null }, 'Каждую неделю'),
      el('option', { value: 'monthly_nth_weekday', selected: schedule.kind === 'monthly_nth_weekday' ? '' : null }, 'N-й день недели месяца'),
      el('option', { value: 'monthly_day', selected: schedule.kind === 'monthly_day' ? '' : null }, 'День месяца'),
      el('option', { value: 'interval', selected: schedule.kind === 'interval' ? '' : null }, 'Каждые N дней'),
    );

    const scheduleFields = [];
    if (schedule.kind === 'weekly' || schedule.kind === 'monthly_nth_weekday') {
      if (schedule.kind === 'monthly_nth_weekday') {
        scheduleFields.push(
          el(
            'div',
            { class: 'rw-field' },
            el('label', null, 'Какой по счёту'),
            el(
              'select',
              {
                onchange: (event) => {
                  draft.schedule.nth = Number(event.target.value);
                  this.render();
                },
              },
              ...[1, 2, 3, 4, -1].map((nth) =>
                el(
                  'option',
                  { value: String(nth), selected: Number(schedule.nth) === nth ? '' : null },
                  NTH_LABELS[String(nth)],
                ),
              ),
            ),
          ),
        );
      }
      scheduleFields.push(
        el(
          'div',
          { class: 'rw-field' },
          el('label', null, 'День недели'),
          el(
            'select',
            {
              onchange: (event) => {
                draft.schedule.weekday = Number(event.target.value);
                this.render();
              },
            },
            ...WEEKDAYS.map((name, index) =>
              el(
                'option',
                { value: String(index), selected: Number(schedule.weekday) === index ? '' : null },
                name,
              ),
            ),
          ),
        ),
      );
    }
    if (schedule.kind === 'monthly_day') {
      scheduleFields.push(
        el(
          'div',
          { class: 'rw-field' },
          el('label', null, 'Число месяца (1–31)'),
          el('input', {
            type: 'number',
            min: '1',
            max: '31',
            value: String(schedule.day ?? 1),
            oninput: (event) => {
              draft.schedule.day = Number(event.target.value) || 1;
            },
          }),
          el('span', { class: 'rw-hint' }, 'В коротких месяцах число поджимается к последнему дню.'),
        ),
      );
    }
    if (schedule.kind === 'interval') {
      scheduleFields.push(
        el(
          'div',
          { class: 'rw-field' },
          el('label', null, 'Интервал, дней'),
          el('input', {
            type: 'number',
            min: '1',
            max: '365',
            value: String(schedule.intervalDays ?? 7),
            oninput: (event) => {
              draft.schedule.intervalDays = Number(event.target.value) || 7;
            },
          }),
        ),
      );
      scheduleFields.push(
        el(
          'div',
          { class: 'rw-field' },
          el('label', null, 'Точка отсчёта (необязательно)'),
          el('input', {
            type: 'date',
            value: schedule.anchorDate || '',
            oninput: (event) => {
              draft.schedule.anchorDate = event.target.value || null;
            },
          }),
        ),
      );
    }
    scheduleFields.push(
      el(
        'div',
        { class: 'rw-field' },
        el('label', null, 'Время (часовой пояс панели)'),
        el('input', {
          type: 'time',
          value: schedule.time || '05:00',
          oninput: (event) => {
            draft.schedule.time = event.target.value || '05:00';
          },
        }),
      ),
    );

    const pathList = (list, kind) => {
      const edit = this.state.pathEdit;
      if (!list.length) {
        return el(
          'div',
          { class: 'rw-paths' },
          el('div', { class: 'rw-dim', style: { padding: '4px 6px' } }, 'Список пуст'),
        );
      }
      return el(
        'div',
        { class: 'rw-paths' },
        ...list.map((path, index) => {
          if (edit && edit.kind === kind && edit.index === index) {
            return el(
              'div',
              { class: 'rw-path editing' },
              el('span', { class: 'rw-path-grip', style: { opacity: '.35' }, 'aria-hidden': 'true' }, '⠿'),
              el('span', { class: 'rw-path-n', text: `${index + 1}.` }),
              el('input', {
                type: 'text',
                value: path,
                'data-rw-path-edit': '1',
                onkeydown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    this.commitPathEdit(event.target.value);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    this.cancelPathEdit();
                  }
                },
                onblur: (event) => this.commitPathEdit(event.target.value),
              }),
            );
          }
          const grip = el(
            'span',
            {
              class: 'rw-path-grip',
              title: 'Перетащите мышью, чтобы изменить порядок',
              draggable: 'true',
              ondragstart: (event) => {
                this.dragPath = { kind, index };
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                  // Firefox без данных не начинает перетаскивание.
                  event.dataTransfer.setData('text/plain', path);
                }
              },
              ondragend: () => {
                this.dragPath = null;
                this.render();
              },
            },
            '⠿',
          );

          const buttons = [
            {
              title: 'Переместить выше',
              sign: '↑',
              disabled: index === 0,
              action: () => this.movePathItem(kind, index, -1),
            },
            {
              title: 'Переместить ниже',
              sign: '↓',
              disabled: index === list.length - 1,
              action: () => this.movePathItem(kind, index, 1),
            },
            { title: 'Изменить путь', sign: '✎', action: () => this.startPathEdit(kind, index) },
            { title: 'Дублировать', sign: '⧉', action: () => this.duplicatePathItem(kind, index) },
            { title: 'Убрать из списка', sign: '×', danger: true, action: () => this.removePathItem(kind, index) },
          ];

          return el(
            'div',
            {
              class: 'rw-path',
              'data-path-index': String(index),
              ondragover: (event) => {
                const drag = this.dragPath;
                if (!drag || drag.kind !== kind) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                const box = event.currentTarget.getBoundingClientRect();
                const after = event.clientY - box.top > box.height / 2;
                event.currentTarget.classList.toggle('drop-above', !after);
                event.currentTarget.classList.toggle('drop-below', after);
              },
              ondragleave: (event) => {
                event.currentTarget.classList.remove('drop-above', 'drop-below');
              },
              ondrop: (event) => {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                const after = event.clientY - box.top > box.height / 2;
                event.currentTarget.classList.remove('drop-above', 'drop-below');
                this.dropPathItem(kind, index, after);
              },
            },
            grip,
            el(
              'div',
              { class: 'rw-path-main' },
              el('span', { class: 'rw-path-n', text: `${index + 1}.` }),
              el('span', { class: 'rw-path-text', title: path, text: path }),
            ),
            el(
              'div',
              { class: 'rw-path-actions' },
              ...buttons.map((button) =>
                el(
                  'button',
                  {
                    class: button.danger ? 'rw-path-btn danger' : 'rw-path-btn',
                    title: button.title,
                    'aria-label': button.title,
                    disabled: button.disabled ? '' : null,
                    onclick: button.action,
                  },
                  button.sign,
                ),
              ),
            ),
          );
        }),
      );
    };

    const presetButtons = this.state.presets.map((preset) =>
      el(
        'button',
        {
          class: 'rw-btn small',
          title: preset.description,
          onclick: () => {
            let added = 0;
            for (const target of preset.targets) {
              if (!draft.targets.includes(target)) {
                draft.targets.push(target);
                added += 1;
              }
            }
            for (const exclude of preset.excludes || []) {
              if (!draft.excludes.includes(exclude)) draft.excludes.push(exclude);
            }
            if (!draft.targets.length) draft.targets.push(...preset.targets);
            this.render();
            this.toast('ok', added ? `Пресет «${preset.label}» добавлен` : 'Пресет уже добавлен');
          },
        },
        preset.label,
      ),
    );

    const excludeInput = el('input', {
      type: 'text',
      placeholder: 'например /server/*/cfg',
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const value = event.target.value.trim();
        if (!value) return;
        if (!draft.excludes.includes(value)) draft.excludes.push(value);
        this.render();
      },
    });

    return el(
      'div',
      { class: 'rw-overlay' },
      el(
        'div',
        { class: 'rw-modal wide' },
        el(
          'div',
          { class: 'rw-modal-head' },
          el('h3', null, draft.id ? 'Изменить профиль вайпа' : 'Новый профиль вайпа'),
          el('button', { class: 'rw-btn small', onclick: () => this.closeModal() }, 'Закрыть'),
        ),
        el(
          'div',
          { class: 'rw-form' },
          el(
            'div',
            { class: 'rw-field full' },
            el('label', null, 'Название'),
            el('input', {
              type: 'text',
              value: draft.name,
              placeholder: 'например Еженедельный вайп карты',
              oninput: (event) => {
                draft.name = event.target.value;
              },
            }),
          ),
          el('div', { class: 'rw-field' }, el('label', null, 'Тип расписания'), kindSelect),
          ...scheduleFields,
          el(
            'div',
            { class: 'rw-field full' },
            el('label', null, 'Что удалять (пути и маски)'),
            pathList(draft.targets, 'targets'),
            el(
              'div',
              { class: 'rw-row' },
              el(
                'button',
                { class: 'rw-btn small', onclick: () => this.openPicker('targets') },
                'Выбрать в файлах…',
              ),
              el(
                'button',
                {
                  class: 'rw-btn small',
                  onclick: () => {
                    const value = window.prompt('Путь или маска (например /server/*/proceduralmap.*.sav)');
                    if (!value) return;
                    const trimmed = value.trim();
                    if (!trimmed) return;
                    if (!draft.targets.includes(trimmed)) draft.targets.push(trimmed);
                    this.render();
                  },
                },
                'Добавить вручную',
              ),
            ),
            el('span', { class: 'rw-hint' }, 'Маски: * — любые символы в имени, ? — один символ, ** — любая глубина. Пресеты:'),
            el('div', { class: 'rw-row' }, ...presetButtons),
          ),
          el(
            'div',
            { class: 'rw-field full' },
            el('label', null, 'Исключения (не удалять)'),
            pathList(draft.excludes, 'excludes'),
            el('div', { class: 'rw-row' }, excludeInput),
            el(
              'span',
              { class: 'rw-hint' },
              'Исключение каталога защищает и всё его содержимое. Enter — добавить.',
            ),
          ),
          this.renderMapFields(draft),
          el(
            'div',
            { class: 'rw-field full' },
            el('label', null, 'Поведение'),
            el(
              'div',
              { class: 'rw-checks' },
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  checked: draft.options.stopServer ? '' : null,
                  onchange: (event) => {
                    draft.options.stopServer = event.target.checked;
                    this.render();
                  },
                }),
                'Останавливать сервер перед удалением',
              ),
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  checked: draft.options.startServer ? '' : null,
                  onchange: (event) => {
                    draft.options.startServer = event.target.checked;
                    this.render();
                  },
                }),
                'Запускать сервер после вайпа',
              ),
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  checked: draft.options.warnChat === false ? null : '',
                  onchange: (event) => {
                    draft.options.warnChat = event.target.checked;
                    this.render();
                  },
                }),
                'Предупреждать в чате сервера перед вайпом (за 5 минут, раз в минуту)',
              ),
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  checked: draft.options.dryRun ? '' : null,
                  onchange: (event) => {
                    draft.options.dryRun = event.target.checked;
                    this.render();
                  },
                }),
                'Только проверка (dry-run): ничего не удалять и не останавливать',
              ),
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  checked: draft.enabled ? '' : null,
                  onchange: (event) => {
                    draft.enabled = event.target.checked;
                    this.render();
                  },
                }),
                'Профиль включён (участвует в расписании)',
              ),
            ),
          ),
          el(
            'div',
            { class: 'rw-field full' },
            el('label', null, 'Команды в консоль после запуска (по одной в строке)'),
            el('textarea', {
              placeholder: 'oxide.reload *',
              oninput: (event) => {
                draft.options.commandsAfter = event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean);
              },
            }, (draft.options.commandsAfter || []).join('\n')),
            el('span', { class: 'rw-hint' }, 'Необязательно. Нужен console.write у API-ключа.'),
          ),
        ),
        el(
          'div',
          { class: 'rw-modal-actions' },
          el('button', { class: 'rw-btn', onclick: () => this.closeModal() }, 'Отмена'),
          canManage
            ? el(
                'button',
                {
                  class: 'rw-btn primary',
                  disabled: this.state.busy,
                  onclick: () => this.saveProfile(),
                },
                'Сохранить',
              )
            : null,
        ),
      ),
    );
  }

  async saveProfile() {
    const draft = this.draft();
    if (!draft) return;
    if (!draft.name.trim()) {
      this.toast('bad', 'Укажите название профиля');
      return;
    }
    if (!draft.targets.length) {
      this.toast('bad', 'Добавьте хотя бы один путь или маску');
      return;
    }
    this.state.busy = true;
    this.render();
    try {
      const payload = {
        name: draft.name.trim(),
        serverId: draft.serverId,
        enabled: draft.enabled !== false,
        schedule: draft.schedule,
        targets: draft.targets,
        excludes: draft.excludes,
        options: draft.options,
        map: draft.map,
      };
      const base = this.apiBase();
      if (draft.id) await api(`${base}/profiles/${encodeURIComponent(draft.id)}`, { method: 'PUT', body: payload });
      else await api(`${base}/profiles`, { method: 'POST', body: payload });
      this.state.busy = false;
      this.state.modal = null;
      await this.reload();
      this.toast('ok', 'Профиль сохранён');
    } catch (error) {
      this.state.busy = false;
      this.toast('bad', error.message);
      this.render();
    }
  }

  async toggleProfile(profile) {
    try {
      await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}`, {
        method: 'PUT',
        body: { enabled: !profile.enabled },
      });
      await this.reload();
    } catch (error) {
      this.toast('bad', error.message);
    }
  }

  confirmDelete(profile) {
    this.state.modal = {
      type: 'confirm',
      title: 'Удалить профиль?',
      text: `Профиль «${profile.name}» будет удалён. История прогонов останется.`,
      confirmLabel: 'Удалить профиль',
      onConfirm: async () => {
        try {
          await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
          await this.reload();
          this.toast('ok', 'Профиль удалён');
        } catch (error) {
          this.toast('bad', error.message);
        }
      },
    };
    this.render();
  }

  async runProfile(profile, dryRun = false) {
    try {
      const result = await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}/run`, {
        method: 'POST',
        body: dryRun ? { dryRun: true } : {},
      });
      this.toast('ok', result.message || 'Вайп запущен');
      setTimeout(() => this.refreshRuns(), 2500);
      setTimeout(() => this.refreshRuns(), 9000);
    } catch (error) {
      this.toast('bad', error.message);
    }
  }

  /** Проверка доставки предупреждения: одно сообщение в чат прямо сейчас. */
  async testWarn() {
    this.state.busy = true;
    this.render();
    try {
      const data = await api(`${this.apiBase()}/warn-test`, { method: 'POST' });
      this.toast('ok', `В чат отправлено: ${data?.text || 'предупреждение'}`);
    } catch (error) {
      this.toast('bad', `Не отправлено: ${error.message}`);
    }
    this.state.busy = false;
    this.render();
  }

  async previewProfile(profile) {
    this.state.busy = true;
    this.render();
    try {
      const data = await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}/preview`, { method: 'POST' });
      this.state.preview = { profile, data };
    } catch (error) {
      this.toast('bad', error.message);
    }
    this.state.busy = false;
    this.render();
  }

  renderPreviewModal() {
    const { profile, data } = this.state.preview;
    const paths = data.paths || [];
    return el(
      'div',
      {
        class: 'rw-overlay',
        onclick: (event) => {
          if (event.target === event.currentTarget) {
            this.state.preview = null;
            this.render();
          }
        },
      },
      el(
        'div',
        { class: 'rw-modal wide' },
        el(
          'div',
          { class: 'rw-modal-head' },
          el('h3', null, `Что будет удалено — ${profile.name}`),
          el(
            'button',
            {
              class: 'rw-btn small',
              onclick: () => {
                this.state.preview = null;
                this.render();
              },
            },
            'Закрыть',
          ),
        ),
        el(
          'div',
          { class: 'rw-meta', style: { marginBottom: '8px' } },
          el(
            'span',
            null,
            `Сервер: ${data.server?.name || profile.serverName || '—'}` +
              (data.server?.status ? ` (${statusLabel(data.server.status)})` : ''),
          ),
          el('span', null, `Найдено путей: ${data.count ?? paths.length}`),
        ),
        data.truncated
          ? el('div', { class: 'rw-notice warn' }, 'Список обрезан лимитом (500 путей) — часть файлов не показана.')
          : null,
        el('div', { class: 'rw-pre' }, paths.length ? paths.join('\n') : 'Ничего не найдено — проверьте маски.'),
      ),
    );
  }

  // ── Файловый пикер ──────────────────────────────────────────────────────

  openPicker(mode) {
    const draft = this.draft();
    if (!draft) return;
    if (!draft.serverId) {
      this.toast('bad', 'Сначала выберите сервер');
      return;
    }
    this.state.modal = {
      type: 'picker',
      mode,
      draft,
      serverId: draft.serverId,
      path: '/',
      entries: [],
      breadcrumbs: [],
      selected: new Set(),
      loading: true,
      error: null,
    };
    this.render();
    this.loadPicker('/');
  }

  async loadPicker(path) {
    const picker = this.state.modal;
    if (!picker || picker.type !== 'picker') return;
    picker.loading = true;
    picker.error = null;
    this.render();
    try {
      const data = await api(
        `${this.apiBase()}/files?path=${encodeURIComponent(path)}`,
      );
      picker.path = data.path;
      picker.entries = data.entries || [];
      picker.breadcrumbs = data.breadcrumbs || [];
      picker.selected = new Set();
    } catch (error) {
      picker.error = error.message;
      picker.entries = [];
    }
    picker.loading = false;
    this.render();
  }

  pickerAdd(paths) {
    const picker = this.state.modal;
    if (!picker || picker.type !== 'picker') return;
    const draft = picker.draft;
    const list = picker.mode === 'targets' ? draft.targets : draft.excludes;
    let added = 0;
    for (const path of paths) {
      if (!path) continue;
      if (!list.includes(path)) {
        list.push(path);
        added += 1;
      }
    }
    this.state.modal = { type: 'editor', draft };
    this.render();
    this.toast(added ? 'ok' : 'warn', added ? `Добавлено путей: ${added}` : 'Эти пути уже добавлены');
  }

  renderPickerModal() {
    const picker = this.state.modal;
    if (!picker || picker.type !== 'picker') return null;
    const draft = picker.draft;

    const crumbs = el(
      'div',
      { class: 'rw-crumbs' },
      el(
        'button',
        { onclick: () => this.loadPicker('/') },
        'корень сервера',
      ),
      ...(picker.breadcrumbs || []).map((crumb) =>
        el(
          'span',
          { class: 'rw-inline' },
          el('span', null, '/'),
          el('button', { onclick: () => this.loadPicker(crumb.path) }, crumb.name),
        ),
      ),
    );

    // «На уровень выше»: путь родителя берём из хлебных крошек, чтобы не
    // разбирать путь вручную и не выйти за корень сервера.
    const crumbsList = picker.breadcrumbs || [];
    const parentPath = crumbsList.length > 1 ? crumbsList[crumbsList.length - 2].path : '/';
    const upRow =
      picker.path === '/'
        ? null
        : el(
            'div',
            { class: 'rw-picker-row' },
            el('span', { class: 'rw-ico', text: '↩' }),
            el(
              'button',
              {
                class: 'rw-pname',
                style: {
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--rw-accent)',
                  font: 'inherit',
                  textAlign: 'left',
                  cursor: 'pointer',
                  padding: '0',
                },
                onclick: () => this.loadPicker(parentPath),
              },
              'На уровень выше',
            ),
          );

    const rows = picker.entries.map((entry) => {
      const checkbox = el('input', {
        type: 'checkbox',
        checked: picker.selected.has(entry.path) ? '' : null,
        onchange: (event) => {
          if (event.target.checked) picker.selected.add(entry.path);
          else picker.selected.delete(entry.path);
          this.render();
        },
      });
      const name = entry.isDirectory
        ? el(
            'button',
            {
              class: 'rw-ppath rw-pname',
              style: {
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                padding: '0',
              },
              onclick: () => this.loadPicker(entry.path),
            },
            entry.name,
          )
        : el('span', { class: 'rw-pname' }, entry.name);
      return el(
        'div',
        { class: 'rw-picker-row' },
        checkbox,
        el('span', { class: 'rw-ico', text: entry.isDirectory ? '📁' : '📄' }),
        name,
        entry.isDirectory ? null : el('span', { class: 'rw-psize', text: bytes(entry.size) }),
      );
    });

    const selectedCount = picker.selected.size;

    return el(
      'div',
      {
        class: 'rw-overlay',
        onclick: (event) => {
          if (event.target === event.currentTarget) this.backToEditor();
        },
      },
      el(
        'div',
        { class: 'rw-modal wide' },
        el(
          'div',
          { class: 'rw-modal-head' },
          el(
            'button',
            { class: 'rw-btn small', onclick: () => this.backToEditor() },
            '← Назад к профилю',
          ),
          el(
            'h3',
            { style: { flex: '1', margin: '0' } },
            picker.mode === 'targets' ? 'Выбор файлов и каталогов для удаления' : 'Выбор исключений',
          ),
        ),
        el('div', { class: 'rw-notice' }, 'Клик по каталогу — перейти внутрь. Чекбокс — отметить для добавления.'),
        crumbs,
        picker.error ? el('div', { class: 'rw-notice bad', style: { marginTop: '8px' } }, picker.error) : null,
        el(
          'div',
          { class: 'rw-picker-list' },
          picker.loading
            ? el('div', { class: 'rw-dim', style: { padding: '12px' } }, 'Читаю каталог…')
            : [
                upRow,
                ...rows,
                rows.length
                  ? null
                  : el('div', { class: 'rw-dim', style: { padding: '12px' } }, 'Пусто'),
              ],
        ),
        el(
          'div',
          { class: 'rw-row', style: { marginTop: '10px' } },
          el(
            'button',
            {
              class: 'rw-btn',
              disabled: picker.loading,
              onclick: () => this.pickerAdd(picker.selected.size ? [...picker.selected] : [picker.path]),
            },
            selectedCount ? `Добавить выбранные (${selectedCount})` : 'Добавить текущий каталог',
          ),
          el(
            'button',
            {
              class: 'rw-btn',
              disabled: picker.loading || picker.path === '/',
              title:
                picker.path === '/'
                  ? 'Нельзя добавить маску на весь корень сервера — выберите каталог'
                  : 'Добавить «всё содержимое» текущего каталога',
              onclick: () => this.pickerAdd([`${picker.path === '/' ? '' : picker.path}/*`]),
            },
            'Добавить маску «всё внутри»',
          ),
          el('span', { class: 'rw-dim', style: { fontSize: '11.5px' } }, picker.path),
        ),
      ),
    );
  }

  async checkPanel() {
    try {
      const data = await api(`${this.apiBase()}/panel-check`, { method: 'POST' });
      if (data.ok) this.toast('ok', 'API-ключ работает, панель отвечает');
      else this.toast('bad', data.error || 'Проверка не прошла');
    } catch (error) {
      this.toast('bad', error.message);
    }
  }
}

// ── Точка входа ───────────────────────────────────────────────────────────

function mountRoot(node, serverId) {
  if (!node) return;
  if (node.dataset.rwMounted === '1' && node.dataset.rwServer === serverId) return;
  node.dataset.rwMounted = '1';
  node.dataset.rwServer = serverId;
  node.dataset.rwTheme = detectTheme();
  const app = new App(node, serverId);
  void app.start();
}

/** Тема панели: класс на html, затем фон body, color-scheme и системная настройка. */
function detectTheme() {
  const root = typeof document !== 'undefined' && document.documentElement ? document.documentElement : null;

  // 1. Явный класс темы на html — самый надёжный признак.
  if (root && root.classList) {
    if (root.classList.contains('dark')) return 'dark';
    if (root.classList.contains('light')) return 'light';
  }

  // 2. Фон body: панели часто меняют только CSS-переменные, без класса.
  try {
    const bg = String(getComputedStyle(document.body).backgroundColor || '');
    const parts = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    if (parts) {
      const [, r, g, b, a] = parts.map(Number);
      const alpha = Number.isFinite(a) ? a : 1;
      if (alpha > 0.5) {
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return luminance > 140 ? 'light' : 'dark';
      }
    }
  } catch {
    /* фон недоступен — идём дальше */
  }

  // 3. color-scheme (может отставать от класса, поэтому после фона).
  if (root) {
    try {
      const scheme = String(getComputedStyle(root).colorScheme || '').toLowerCase();
      if (scheme.includes('dark') && !scheme.includes('light')) return 'dark';
      if (scheme.includes('light') && !scheme.includes('dark')) return 'light';
    } catch {
      /* игнорируем */
    }
  }

  // 4. Системная настройка.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

const manifest = {
  name: 'rust-autowipe',
  version: '1.5.6',
  displayName: 'Rust AutoWipe',
  description: 'Расписание вайпов Rust и удаление выбранных файлов/каталогов для конкретного сервера',
  author: 'H1NZON',
};

/**
 * Вкладка сервера: панель передаёт serverId, плагин работает только с ним.
 * templateFilter показывает вкладку лишь на серверах, чей шаблон (яйцо)
 * похож на Rust. Если шаблон назван иначе — поправьте namePattern.
 */
function ServerTab(props) {
  const serverId = String(props?.serverId || '');
  return h('div', {
    class: 'rw-root',
    ref: (node) => mountRoot(node, serverId),
  });
}

export default {
  manifest,
  tabs: [
    {
      id: 'rust-autowipe-server',
      label: 'Rust AutoWipe',
      component: ServerTab,
      location: 'server',
      order: 60,
      requiredPermissions: ['server.read'],
      templateFilter: { namePattern: 'rust' },
    },
  ],
};
