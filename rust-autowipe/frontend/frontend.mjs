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

/** Узлы с атрибутом attr внутри root; без querySelectorAll — пустой список. */
function markedNodes(root, attr) {
  try {
    return typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll(`[${attr}]`)] : [];
  } catch {
    return [];
  }
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
    const error = new Error(String(message));
    // Код ответа и code backend (например PROFILE_CHANGED) — чтобы показать понятный текст.
    error.status = response.status;
    error.code = json?.code || null;
    throw error;
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

const zoneFormatters = new Map();

/**
 * Части даты (день, месяц, год, часы, минуты, секунды) в часовом поясе zone.
 * Смещение пояса берётся на саму дату, поэтому переход на летнее и зимнее
 * время учтён. null — пояс не задан или браузер его не знает.
 */
function zoneParts(date, zone) {
  if (!zone) return null;
  if (!zoneFormatters.has(zone)) {
    let formatter = null;
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      formatter = null;
    }
    zoneFormatters.set(zone, formatter);
  }
  const formatter = zoneFormatters.get(zone);
  if (!formatter) return null;
  const parts = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  if (parts.hour === '24') parts.hour = '00'; // старые браузеры пишут полночь как 24
  return parts;
}

/** «дд.мм.гггг чч:мм» в поясе zone; без пояса — по смещению «на сейчас», как раньше. */
function formatZonedDate(iso, zone, offsetMinutes) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const p = zoneParts(date, zone);
  if (!p) return formatPanelDate(iso, offsetMinutes);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

/** Смещение пояса zone от UTC в минутах на момент date; null — пояс неизвестен. */
function zoneOffsetMinutes(date, zone) {
  const p = zoneParts(date, zone);
  if (!p) return null;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
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
  const time = `${schedule.time || '05:00'}${schedule.timeZone ? ` (${schedule.timeZone})` : ''}`;
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

let timeZoneCache;

/** Пояса IANA браузера для выпадающего списка; null — браузер списка не даёт. */
function timeZoneList() {
  if (timeZoneCache !== undefined) return timeZoneCache;
  timeZoneCache = null;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
      const list = Intl.supportedValuesOf('timeZone');
      if (Array.isArray(list) && list.length) timeZoneCache = list;
    }
  } catch {
    /* старый браузер — будет текстовое поле */
  }
  return timeZoneCache;
}

/**
 * Путь, выбранный в пикере, — буквальный: «*», «?» и «[» в именах файлов не
 * маска. В шаблоне «[x]» означает ровно символ x (договорённость К1), поэтому
 * «*» → «[*]», «?» → «[?]», «[» → «[[]». Остальные символы не меняются.
 */
function literalPath(path) {
  return String(path ?? '')
    .split('/')
    .map((segment) => segment.replace(/[*?[]/g, (char) => `[${char}]`))
    .join('/');
}

/** Снимок черновика для сравнения «есть ли несохранённые правки». */
function draftSnapshot(draft) {
  return JSON.stringify({
    name: draft.name,
    enabled: draft.enabled,
    schedule: draft.schedule,
    targets: draft.targets,
    excludes: draft.excludes,
    options: draft.options,
    map: draft.map,
    excludeInput: String(draft.excludeInput || '').trim(),
    targetInput: String(draft.targetInput || '').trim(),
  });
}

/** Число из поля ввода; пустое или не число — null (поле не подменяет ввод). */
function numberOrNull(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const isIntIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** Проверка полей редактора до отправки: текст ошибки или null. */
function draftProblem(draft) {
  const schedule = draft.schedule || {};
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(schedule.time ?? '').trim())) return 'Укажите время вайпа';
  if (schedule.kind === 'monthly_day' && !isIntIn(schedule.day, 1, 31)) return 'Укажите число месяца от 1 до 31';
  if (schedule.kind === 'interval' && !isIntIn(schedule.intervalDays, 1, 365)) {
    return 'Укажите интервал от 1 до 365 дней';
  }
  const map = draft.map || {};
  if (map.size?.mode === 'fixed' && !isIntIn(map.size.value, 1000, 6000)) {
    return 'Карта: укажите размер от 1000 до 6000';
  }
  if (map.seed?.mode === 'fixed' && !isIntIn(map.seed.value, 1, 2147483647)) {
    return 'Карта: укажите сид от 1 до 2147483647';
  }
  return null;
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
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
/* ============ Rust AutoWipe — design system v3 ============
   Цвета, радиус, тени и шрифт — токены панели Catalyst (hsl(var(--…))):
   вкладка выглядит частью панели и меняется вместе с её темой и палитрой.
   Второе значение в var() — запас для стенда без панели (значения Catalyst
   v1.89.2). Своего фона и полей у вкладки нет: их даёт панель.
   Темы: data-rw-theme="dark" | "light" (ставится из JS по теме панели). */

.rw-root{
  --rw-space-1:4px;--rw-space-2:8px;--rw-space-3:12px;--rw-space-4:16px;--rw-space-5:20px;--rw-space-6:24px;--rw-space-8:32px;
  --rw-r-sm:var(--deck-radius,4px);--rw-r-md:var(--deck-radius,4px);
  --rw-fs-11:11px;--rw-fs-12:12px;--rw-fs-13:13px;--rw-fs-14:14px;--rw-fs-16:16px;--rw-fs-20:20px;
  --rw-mono:"JetBrains Mono Variable","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:flex;flex-direction:column;gap:var(--rw-space-2);
  min-width:0;padding:0;
  font-size:var(--rw-fs-14);line-height:1.5;
  color:var(--rw-text);
}
.rw-root[data-rw-theme="dark"]{
  color-scheme:dark;
  --rw-surface:hsl(var(--card,218 2% 11%));
  --rw-surface-2:hsl(var(--surface-2,217 4% 17%));
  --rw-surface-3:hsl(var(--surface-3,217 6% 21%));
  --rw-border:hsl(var(--border,215 5% 21%));
  --rw-border-strong:hsl(var(--muted-foreground,216 13% 63%) / .45);
  --rw-text:hsl(var(--foreground,220 20% 93%));
  --rw-text-dim:hsl(var(--muted-foreground,216 13% 63%));
  --rw-primary:hsl(var(--primary,340 100% 62%));
  --rw-primary-ink:hsl(var(--primary-foreground,217 2% 7%));
  --rw-primary-soft:hsl(var(--primary,340 100% 62%) / .16);
  --rw-danger:hsl(var(--danger,0 100% 68%));
  --rw-ok:hsl(var(--success,153 60% 53%));
  --rw-warn:hsl(var(--warning,39 100% 56%));
  --rw-shadow-sm:var(--shadow-surface,0 1px 2px 0 rgb(0 0 0 / .4));
  --rw-shadow-md:var(--shadow-elevated,0 14px 34px -14px rgb(0 0 0 / .6));
  --rw-overlay:hsl(var(--scrim,217 20% 4% / .62));
}
.rw-root[data-rw-theme="light"]{
  color-scheme:light;
  --rw-surface:hsl(var(--card,210 25% 99%));
  --rw-surface-2:hsl(var(--surface-2,214 16% 92%));
  --rw-surface-3:hsl(var(--surface-3,214 12% 86%));
  --rw-border:hsl(var(--border,214 14% 85%));
  --rw-border-strong:hsl(var(--muted-foreground,215 12% 42%) / .45);
  --rw-text:hsl(var(--foreground,216 28% 12%));
  --rw-text-dim:hsl(var(--muted-foreground,215 12% 42%));
  --rw-primary:hsl(var(--primary,340 82% 47%));
  --rw-primary-ink:hsl(var(--primary-foreground,0 0% 100%));
  --rw-primary-soft:hsl(var(--primary,340 82% 47%) / .15);
  --rw-danger:hsl(var(--danger,0 72% 48%));
  --rw-ok:hsl(var(--success,153 55% 32%));
  --rw-warn:hsl(var(--warning,39 92% 42%));
  --rw-shadow-sm:var(--shadow-surface,0 1px 2px 0 rgb(14 17 22 / .06));
  --rw-shadow-md:var(--shadow-elevated,0 10px 30px -12px rgb(14 17 22 / .22));
  --rw-overlay:hsl(var(--scrim,217 20% 4% / .62));
}
.rw-root *{box-sizing:border-box}
.rw-root :focus-visible{outline:2px solid var(--rw-primary);outline-offset:2px}

/* ── Шапка ─────────────────────────────────────────────────────────── */
.rw-root .rw-head{display:flex;align-items:flex-start;gap:var(--rw-space-3);flex-wrap:wrap}
.rw-root .rw-title{display:flex;flex-direction:column;gap:2px;margin-right:auto;min-width:0}
.rw-root .rw-title h2{margin:0;font-size:var(--rw-fs-20);font-weight:600;line-height:1.25;letter-spacing:-.01em}
.rw-root .rw-title span{font-size:var(--rw-fs-11);color:var(--rw-text-dim);text-transform:uppercase;letter-spacing:.1em}
.rw-root .rw-chips{display:flex;align-items:center;gap:var(--rw-space-1);flex-wrap:wrap;min-width:0}
.rw-root .rw-head-actions{display:flex;align-items:center;gap:var(--rw-space-2);flex-wrap:wrap}

.rw-root .rw-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;
  border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);background:var(--rw-surface);
  font-size:var(--rw-fs-12);color:var(--rw-text-dim);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.rw-root .rw-chip.ok{color:var(--rw-ok);border-color:color-mix(in srgb,var(--rw-ok) 45%,transparent);background:color-mix(in srgb,var(--rw-ok) 8%,var(--rw-surface))}
.rw-root .rw-chip.warn{color:var(--rw-warn);border-color:color-mix(in srgb,var(--rw-warn) 45%,transparent);background:color-mix(in srgb,var(--rw-warn) 8%,var(--rw-surface))}
.rw-root .rw-chip.bad{color:var(--rw-danger);border-color:color-mix(in srgb,var(--rw-danger) 45%,transparent);background:color-mix(in srgb,var(--rw-danger) 8%,var(--rw-surface))}
.rw-root .rw-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* ── Кнопки ────────────────────────────────────────────────────────── */
.rw-root .rw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 var(--rw-space-3);border-radius:var(--rw-r-sm);
  border:1px solid var(--rw-border);background:var(--rw-surface);color:var(--rw-text);
  font:inherit;font-weight:500;font-size:var(--rw-fs-13);line-height:1;cursor:pointer;white-space:nowrap;
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
  border-radius:var(--rw-r-sm);font-size:var(--rw-fs-11);border:1px solid var(--rw-border);color:var(--rw-text-dim);white-space:nowrap}
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
.rw-root .rw-modal p{margin:0 0 var(--rw-space-2)}
.rw-root .rw-list{margin:0 0 var(--rw-space-3);padding-left:1.25em;list-style:disc;
  display:flex;flex-direction:column;gap:4px;font-size:var(--rw-fs-13)}

/* ── Формы ─────────────────────────────────────────────────────────── */
.rw-root .rw-form{display:grid;grid-template-columns:1fr 1fr;gap:var(--rw-space-3) var(--rw-space-4)}
.rw-root .rw-field{display:flex;flex-direction:column;gap:var(--rw-space-1);min-width:0}
.rw-root .rw-field.full{grid-column:1/-1}
.rw-root .rw-field label{font-size:var(--rw-fs-12);font-weight:500;color:var(--rw-text-dim)}
.rw-root .rw-field input,.rw-root .rw-field select,.rw-root .rw-field textarea,
.rw-root .rw-path input{width:100%;min-height:34px;border:1px solid var(--rw-border);border-radius:var(--rw-r-sm);
  background-color:var(--rw-surface-2);color:var(--rw-text);padding:6px 10px;font:inherit;font-size:var(--rw-fs-13);
  transition:border-color .15s,box-shadow .15s}
/* Панель рисует стрелку select картинкой фона (appearance:none): не стираем её
   сокращённым background и оставляем справа место. */
.rw-root .rw-field select{padding-right:2rem}
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
/* Тост — внизу по центру: справа внизу у панели окно загрузок, сверху — её шапка
   и её собственные уведомления. */
.rw-root .rw-toast{position:fixed;left:50%;bottom:var(--rw-space-4);transform:translateX(-50%);z-index:70;
  border:1px solid var(--rw-border);border-left:3px solid var(--rw-border-strong);border-radius:var(--rw-r-sm);
  padding:10px var(--rw-space-3);background:var(--rw-surface);color:var(--rw-text);
  box-shadow:var(--rw-shadow-md);max-width:min(420px,calc(100vw - 32px));font-size:var(--rw-fs-13)}
.rw-root .rw-toast.ok{border-left-color:var(--rw-ok)}
.rw-root .rw-toast.bad{border-left-color:var(--rw-danger)}
.rw-root .rw-toast.warn{border-left-color:var(--rw-warn)}

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
.rw-root .rw-bad-text{color:var(--rw-danger)}
.rw-root .rw-warn-text{color:var(--rw-warn)}

/* Колонка «Детали» не должна сжиматься в ноль на узких экранах. */
.rw-root .rw-table th:last-child,.rw-root .rw-table td:last-child{min-width:220px}

/* ── Адаптив ───────────────────────────────────────────────────────── */
/* Содержимое вкладки (.rw-body) перестраивается по ширине самой вкладки, а не
   окна браузера: слева у панели меню, и на компьютере вкладка уже окна.
   Окна, тост и формы в окнах привязаны к экрану — для них остаётся @media.
   Окно (position:fixed) лежит вне .rw-body: контейнер ему не мешает. */
.rw-root .rw-body{container:rw-tab / inline-size;display:flex;flex-direction:column;gap:var(--rw-space-2);min-width:0}
@container rw-tab (max-width:980px){
  .rw-root .rw-grid{grid-template-columns:1fr}
}
@container rw-tab (max-width:720px){
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
  .rw-root .rw-table{min-width:520px}
  .rw-root .rw-meta{gap:4px 10px}
}
@container rw-tab (max-width:420px){
  .rw-root .rw-title h2{font-size:var(--rw-fs-16)}
  .rw-root .rw-actions{gap:var(--rw-space-1)}
  .rw-root .rw-actions .rw-btn{flex:1 1 100%}
}
@container rw-tab (max-width:480px){
  /* На узкой вкладке время шага переносим под подпись, чтобы она не сжималась. */
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
@container rw-tab (max-width:560px){
  /* Узкая вкладка: история — строками друг под другом, без второй прокрутки вбок,
     и шаги получают всю ширину, а не ячейку в 220 px. */
  .rw-root .rw-panel-block{overflow-x:visible}
  .rw-root .rw-table,.rw-root .rw-table tbody,.rw-root .rw-table tr,.rw-root .rw-table td{display:block;min-width:0;width:auto}
  .rw-root .rw-table thead{display:none}
  .rw-root .rw-table tr{border-bottom:1px solid var(--rw-border);padding:var(--rw-space-2) 0}
  .rw-root .rw-table tr:last-child{border-bottom:none}
  .rw-root .rw-table td{border:none;padding:2px 0}
  .rw-root .rw-table td[data-label]::before{content:attr(data-label) ": ";color:var(--rw-text-dim);font-size:var(--rw-fs-11)}
  .rw-root .rw-table th:last-child,.rw-root .rw-table td:last-child{min-width:0}
}
@media (max-width:980px){
  .rw-root .rw-form{grid-template-columns:1fr}
}
@media (max-width:720px){
  .rw-root .rw-overlay{padding:0}
  .rw-root .rw-modal,.rw-root .rw-modal.wide{width:100%;max-height:100dvh;min-height:100dvh;
    border-radius:0;border:none;padding:var(--rw-space-4)}
  .rw-root .rw-modal .rw-meta{gap:4px 10px}
  /* Окно на телефоне само прокручивается — списки внутри без своей прокрутки. */
  .rw-root .rw-modal .rw-paths,.rw-root .rw-modal .rw-pre{max-height:none}
  .rw-root .rw-toast{left:var(--rw-space-2);right:var(--rw-space-2);bottom:var(--rw-space-2);transform:none;max-width:none}
}
@media (max-width:420px){
  .rw-root .rw-path{gap:4px;padding:4px}
  .rw-root .rw-path-actions{gap:0}
}
@media (prefers-reduced-motion:reduce){
  .rw-root *{transition:none !important}
}

/* Футер модалки остаётся видимым при прокрутке формы. */
.rw-root .rw-modal-actions{position:sticky;bottom:calc(var(--rw-space-4) * -1);
  padding:var(--rw-space-3) 0 var(--rw-space-1);background:var(--rw-surface)}
`;
  // Панель обновляет плагин «на лету», без перезагрузки страницы: <style>
  // прошлой версии остаётся. Новая версия кладёт свои стили поверх.
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    if (existing.textContent !== style.textContent) existing.textContent = style.textContent;
    return;
  }
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
  start: 'Запуск сервера',
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
  dryRun: 'Проверка',
  started: 'Сервер запущен',
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

function fmtClock(iso, offsetMinutes, zone) {
  const raw = String(iso || '');
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(11, 19) || '—';
  const p = zoneParts(new Date(t), zone);
  if (p) return `${p.hour}:${p.minute}:${p.second}.${String(new Date(t).getUTCMilliseconds()).padStart(3, '0')}`;
  const shifted = new Date(t + (Number(offsetMinutes) || 0) * 60000).toISOString();
  return `${shifted.slice(11, 19)}.${shifted.slice(20, 23)}`;
}

function buildKvList(data, { dryRun = false } = {}) {
  const rows = Object.entries(data).filter(
    ([key, value]) => key !== 'ms' && value !== null && value !== undefined && value !== '',
  );
  if (!rows.length) return null;
  // В проверке ничего не удаляется: «Удалено: 2» там — «Было бы удалено: 2».
  const label = (key) => (dryRun && key === 'deleted' ? 'Было бы удалено' : DATA_LABELS[key] || key);
  return el(
    'div',
    { class: 'rw-kv' },
    ...rows.flatMap(([key, value]) => [
      el('span', { class: 'rw-kv-key', text: label(key) }),
      el('span', { class: 'rw-kv-val', text: fmtDataValue(value) }),
    ]),
  );
}

function pathList(title, items, props = {}) {
  return el(
    'details',
    { class: 'rw-step-paths', ...props },
    el('summary', null, `${title} (${items.length})`),
    el('div', { class: 'rw-pre' }, items.join('\n')),
  );
}

/**
 * Значок итога прогона в истории — по status записи. Запись появляется в
 * начале вайпа (status 'running', поля ok ещё нет), а после падения панели её
 * закрывают как 'interrupted'. У записей прошлых версий status нет — итог по ok.
 */
function runResult(run) {
  const status = String(run?.status || '');
  const check = Boolean(run?.dryRun);
  if (status === 'running') return { kind: 'warn', text: check ? 'проверка: идёт' : 'идёт', running: true };
  if (status === 'interrupted') return { kind: 'bad', text: check ? 'проверка: прервана' : 'прерван' };
  const ok = status ? status === 'ok' : Boolean(run?.ok);
  if (ok) return { kind: 'ok', text: check ? 'проверка: ок' : 'успешно' };
  return { kind: 'bad', text: check ? 'проверка: ошибка' : 'ошибка' };
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
      // Профили, по которым запрос уже в пути (запуск, проверка, правка):
      // их кнопки неактивны, второе нажатие ничего не отправляет.
      pending: new Set(),
    };
    this.toastTimer = null;
    this.timers = new Set();
    this.pollTimer = null;
    this.openDetails = new Set();
    this.editing = null;
    this.modalChain = [];
    this.lastModal = null;
    this.disposed = false;
  }

  /** Профиль занят: запрос в пути или прогон идёт. */
  isProfileBusy(profile) {
    return Boolean(profile?.running) || this.state.pending.has(profile?.id);
  }

  /**
   * Пока какой-то профиль выполняется, раз в 4 с перечитываем профили и
   * историю — иначе «выполняется» висит до ручного «Обновить».
   */
  schedulePoll() {
    if (this.pollTimer || this.disposed) return;
    if (!this.state.profiles.some((profile) => profile.running)) return;
    this.pollTimer = this.later(async () => {
      this.pollTimer = null;
      await this.refreshRuns({ quiet: true });
      this.schedulePoll();
    }, 4000);
  }

  apiBase() {
    return `servers/${encodeURIComponent(this.serverId)}`;
  }

  /** Отложенное действие, которое снимается вместе с экземпляром (см. dispose). */
  later(fn, ms) {
    if (this.disposed) return null;
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  /**
   * Остановить экземпляр: снять таймеры и подписки. После этого render() и
   * код после await ничего не рисуют. Нужно, когда панель переключает сервер
   * на той же вкладке, обновляет плагин «на лету» или убирает вкладку.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    liveApps.delete(this);
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.themeObserver) this.themeObserver.disconnect();
    if (this.themeQuery && typeof this.themeQuery.removeEventListener === 'function') {
      this.themeQuery.removeEventListener('change', this.onThemeQuery);
    }
    if (this.onBeforeUnload && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
  }

  async start() {
    ensureStyles();
    this.applyTheme();
    // Обновление страницы или закрытие вкладки браузера при несохранённом
    // профиле — браузер спросит «Уйти со страницы?».
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onBeforeUnload = (event) => {
        if (!this.isDirty()) return undefined;
        event.preventDefault();
        event.returnValue = '';
        return '';
      };
      window.addEventListener('beforeunload', this.onBeforeUnload);
    }
    if (window.matchMedia) {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof query.addEventListener === 'function') {
        this.themeQuery = query;
        this.onThemeQuery = () => this.applyTheme();
        query.addEventListener('change', this.onThemeQuery);
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
    if (this.disposed) return;
    this.clockTimer = setInterval(() => {
      if (this.disposed || !this.root.isConnected) {
        this.dispose();
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
    const now = new Date();
    const zone = this.panelZone();
    const zoned = zoneOffsetMinutes(now, zone);
    const offset = zoned ?? Number(this.state.status?.clock?.offsetMinutes ?? 0);
    const parts = zoneParts(now, zone);
    const time = parts
      ? `${parts.hour}:${parts.minute}`
      : new Date(now.getTime() + offset * 60000).toISOString().slice(11, 16);
    return `${time} · UTC${offset >= 0 ? '+' : '-'}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  }

  /** Часовой пояс панели (имя IANA из status.clock), '' — неизвестен. */
  panelZone() {
    return String(this.state.status?.clock?.timezone || '');
  }

  /** Пояс, в котором показывать даты профиля: его собственный или пояс панели. */
  profileZone(profile) {
    return String(profile?.schedule?.timeZone || '') || this.panelZone();
  }

  /**
   * Дата для человека в поясе zone. Каждая дата переводится со своим
   * смещением: «Следующий запуск» после перехода на летнее время не
   * сдвигается на час. Без пояса — старое смещение «на сейчас».
   */
  dateText(iso, zone) {
    return formatZonedDate(iso, zone, Number(this.state.status?.clock?.offsetMinutes ?? 0));
  }

  /**
   * Перечитать всё. Ошибка видна всегда: если данные уже есть, сверху
   * появляется пометка, что на экране может быть старое состояние.
   * Возвращает true, если данные обновились.
   */
  async reload() {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    if (!this.serverId) {
      this.state.loading = false;
      this.state.error = 'Вкладка открыта без сервера: плагин работает только в контексте сервера.';
      this.render();
      return false;
    }

    const base = this.apiBase();
    let ok = true;
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
      const runs = await api(`${base}/runs?limit=60`);
      this.state.runs = Array.isArray(runs) ? runs : [];
    } catch (error) {
      this.state.error = error.message;
      ok = false;
    }
    this.state.loading = false;
    this.render();
    this.schedulePoll();
    return ok;
  }

  async refreshRuns({ quiet = false } = {}) {
    const base = this.apiBase();
    try {
      const runs = await api(`${base}/runs?limit=60`);
      const profiles = await api(`${base}/profiles`);
      this.state.runs = Array.isArray(runs) ? runs : [];
      this.state.profiles = Array.isArray(profiles) ? profiles : this.state.profiles;
      this.state.error = null;
    } catch (error) {
      // Фоновый опрос не засыпает экран тостами: ошибка — пометкой сверху.
      if (quiet) this.state.error = error.message;
      else this.toast('bad', error.message);
    }
    // Фоновый опрос не пересобирает открытое окно (редактор, пикер): карточки
    // под ним всё равно закрыты, а перерисовка мешала бы набирать текст.
    if (!(quiet && (this.state.modal || this.state.preview))) this.render();
    this.schedulePoll();
  }

  toast(type, text) {
    if (this.disposed) return;
    this.state.toast = { type, text };
    this.render();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      if (this.disposed) return;
      this.state.toast = null;
      this.render();
    }, 4500);
  }

  /**
   * Что запомнить перед перерисовкой: прокрутку (окна, списков, страницы),
   * поле с фокусом и открытое окно. Перерисовка пересобирает весь корень,
   * и без этого форма на телефоне прыгала в начало, а фокус пропадал.
   */
  captureView() {
    // modal — окно, которое сейчас на экране (нарисовано прошлым render), а не
    // то, что уже лежит в state: иначе прокрутка редактора переедет в пикер.
    const view = { modal: this.lastModal, scroll: {}, focus: null, outer: [] };
    for (const node of markedNodes(this.root, 'data-rw-scroll')) {
      view.scroll[node.getAttribute('data-rw-scroll')] = node.scrollTop || 0;
    }
    // Прокрутка панели вокруг вкладки: пока корень пуст, браузер прижимает её к нулю.
    for (let node = this.root.parentNode; node && node.nodeType === 1; node = node.parentNode) {
      if (node.scrollTop > 0) view.outer.push([node, node.scrollTop]);
    }
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const key = active && typeof active.getAttribute === 'function' ? active.getAttribute('data-rw-key') : null;
    if (key && typeof this.root.contains === 'function' && this.root.contains(active)) {
      view.focus = { key };
      try {
        view.focus.start = active.selectionStart;
        view.focus.end = active.selectionEnd;
      } catch {
        /* у числовых полей выделения нет */
      }
    }
    return view;
  }

  restoreView(view) {
    if (!view) return;
    for (const [node, top] of view.outer) node.scrollTop = top;
    // Прокрутку окна возвращаем, только если открыто то же самое окно.
    if (view.modal && view.modal === (this.state.preview || this.state.modal)) {
      for (const node of markedNodes(this.root, 'data-rw-scroll')) {
        const top = view.scroll[node.getAttribute('data-rw-scroll')];
        if (top) node.scrollTop = top;
      }
    }
    if (view.focus) {
      const target = markedNodes(this.root, 'data-rw-key').find(
        (node) => node.getAttribute('data-rw-key') === view.focus.key,
      );
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
        try {
          if (view.focus.start != null && typeof target.setSelectionRange === 'function') {
            target.setSelectionRange(view.focus.start, view.focus.end);
          }
        } catch {
          /* поле без выделения */
        }
      }
    }
  }

  /**
   * Фокус при смене окна. Открылось новое окно — фокус внутрь (на поле или
   * безопасную кнопку). Вернулись в предыдущее или закрыли все — фокус на
   * кнопку, которая открыла закрытое окно. Цепочка окон — this.modalChain.
   */
  moveFocus(current, view) {
    if (!current) {
      const first = this.modalChain[0];
      this.modalChain = [];
      if (first?.opener) this.focusKey(first.opener);
      return;
    }
    const index = this.modalChain.findIndex((item) => item.modal === current);
    if (index >= 0) {
      const next = this.modalChain[index + 1];
      this.modalChain = this.modalChain.slice(0, index + 1);
      if (next?.opener && this.focusKey(next.opener)) return;
    } else {
      this.modalChain.push({ modal: current, opener: view?.focus?.key || null });
    }
    const target = markedNodes(this.root, 'data-rw-autofocus')[0];
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  focusKey(key) {
    const target = markedNodes(this.root, 'data-rw-key').find((node) => node.getAttribute('data-rw-key') === key);
    if (!target || typeof target.focus !== 'function') return false;
    target.focus({ preventScroll: true });
    return true;
  }

  /**
   * Esc в окне: закрыть его, как «Отмена» или «Закрыть». Редактор с
   * несохранёнными правками сначала спрашивает. Поле правки пути само
   * обрабатывает Esc (отмена правки) — тогда окно не трогаем.
   */
  onModalKey(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    if (this.state.preview) {
      this.state.preview = null;
      this.render();
      return;
    }
    const modal = this.state.modal;
    if (!modal) return;
    if (modal.type === 'confirm') {
      if (typeof modal.onCancel === 'function') modal.onCancel();
      else this.closeModal();
      return;
    }
    if (modal.type === 'picker') {
      this.backToEditor();
      return;
    }
    if (modal.type === 'editor') this.requestCloseEditor();
  }

  /**
   * «Закрыть», «Отмена» и Esc в редакторе: без правок — закрыть сразу, с
   * несохранёнными правками — сначала спросить «Закрыть без сохранения?».
   * «Отмена» в вопросе возвращает в тот же редактор с правками.
   */
  requestCloseEditor() {
    const modal = this.state.modal;
    if (!modal || modal.type !== 'editor' || !this.isDirty()) {
      this.closeEditor();
      return;
    }
    this.state.modal = {
      type: 'confirm',
      title: 'Закрыть без сохранения?',
      items: ['Правки в этом профиле пропадут.'],
      confirmLabel: 'Закрыть без сохранения',
      onConfirm: () => this.closeEditor(),
      onCancel: () => {
        this.state.modal = modal;
        this.render();
      },
    };
    this.render();
  }

  /** Раскрытые блоки истории (шаги, списки путей) переживают перерисовку. */
  detailsProps(key, extra = {}) {
    return {
      ...extra,
      'data-rw-open': key,
      open: this.openDetails.has(key) ? '' : null,
      ontoggle: (event) => {
        const node = event.currentTarget || event.target;
        const open = typeof node?.open === 'boolean' ? node.open : Boolean(node?.hasAttribute?.('open'));
        if (open) this.openDetails.add(key);
        else this.openDetails.delete(key);
      },
    };
  }

  render() {
    // Остановленный экземпляр (сменили сервер, обновили плагин) больше не рисует.
    if (this.disposed) return;
    const view = this.captureView();
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

    const shownModal = this.state.preview || this.state.modal || null;
    append(this.root, [
      el(
        'div',
        { class: 'rw-body' },
        this.renderHeader(),
        // Данные уже есть, а обновить не вышло: молчать нельзя — на экране старое.
        this.state.error && !this.state.loading
          ? el(
              'div',
              { class: 'rw-notice bad', role: 'alert' },
              `Не удалось обновить данные: ${this.state.error}. На экране может быть старое состояние. `,
              el('button', { class: 'rw-btn small', type: 'button', onclick: () => this.reload() }, 'Повторить'),
            )
          : null,
        this.renderMain(),
        this.renderRuns(),
      ),
      this.state.toast
        ? el('div', { class: `rw-toast ${this.state.toast.type}`, role: 'status', 'aria-live': 'polite' }, this.state.toast.text)
        : null,
      this.renderModal(),
    ]);
    this.restoreView(view);
    if (shownModal !== this.lastModal) this.moveFocus(shownModal, view);
    this.lastModal = shownModal;

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
    // Имя и статус сервера уже в шапке панели над вкладкой — здесь их не повторяем.
    const chips = [];
    chips.push(el('span', { class: 'rw-chip', 'data-rw-clock': '1' }, this.panelClockText()));
    chips.push(
      status.hasApiKey
        ? el('span', { class: 'rw-chip ok' }, el('i', { class: 'rw-dot' }), 'API-ключ задан')
        : el('span', { class: 'rw-chip bad' }, el('i', { class: 'rw-dot' }), 'Нет API-ключа'),
    );
    if (status.dryRun) {
      chips.push(
        el(
          'span',
          { class: 'rw-chip warn', title: 'Включено в настройках плагина' },
          'Только проверки: вайпы ничего не удаляют',
        ),
      );
    }
    const warnState = status.wipeWarning && status.wipeWarning.state;
    if (status.wipeWarning && status.wipeWarning.enabled === false) {
      // Рассылка выключена в настройках: старый «Чат: ок» от теста здесь только путает.
      chips.push(
        el(
          'span',
          { class: 'rw-chip warn', title: 'Включаются в настройках плагина' },
          'Предупреждения в чате выключены',
        ),
      );
    } else if (warnState && warnState.ok === false) {
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
    // «Только просмотр» — только если нельзя ни менять, ни запускать.
    if (status.permissions && status.permissions.canManage === false) {
      chips.push(
        el(
          'span',
          { class: 'rw-chip' },
          status.permissions.canRun === true ? 'Можно запускать, нельзя менять профили' : 'Только просмотр',
        ),
      );
    }
    if (status.version) chips.push(el('span', { class: 'rw-chip' }, `v${status.version}`));

    return el(
      'header',
      { class: 'rw-head' },
      el(
        'div',
        { class: 'rw-title' },
        el('h2', null, 'Rust AutoWipe'),
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
            { class: 'rw-btn primary', 'data-rw-key': 'new-profile', onclick: () => this.openEditor(null) },
            '+ Новый профиль',
          )
        : el('span', { class: 'rw-dim' }, 'У вас нет права менять профили'),
    );

    const body = [];
    if (!profiles.length) {
      body.push(
        el(
          'div',
          { class: 'rw-empty' },
          canManage
            ? 'Профилей пока нет. Создайте профиль: расписание и файлы/каталоги, которые удаляются при вайпе этого сервера.'
            : 'Профилей пока нет.',
        ),
      );
    } else {
      for (const profile of profiles) body.push(this.renderProfileCard(profile, { canManage, canRun }));
    }

    // <section>, а не <main>: главная область страницы — у панели, вкладка внутри неё.
    return el('section', { class: 'rw-main' }, header, ...body);
  }

  renderProfileCard(profile, { canManage, canRun }) {
    const zone = this.profileZone(profile);
    // Итог настоящего вайпа (lastRun*) и итог проверки (lastCheck*) — разные
    // вещи: проверка не должна затирать ошибку ночного вайпа (К4).
    const statusChip = profile.running
      ? el('span', { class: 'rw-badge warn' }, 'выполняется')
      : profile.lastRunStatus === 'ok'
        ? el('span', { class: 'rw-badge ok' }, 'последний вайп: ок')
        : profile.lastRunStatus === 'failed'
          ? el('span', { class: 'rw-badge bad' }, 'последний вайп: ошибка')
          : el('span', { class: 'rw-badge' }, 'вайпа ещё не было');
    // Профиль с «Только проверка» (или глобальная проверка) ничего не удаляет —
    // это должно быть видно на карточке.
    const checkOnly = Boolean(profile.options?.dryRun) || this.state.status?.dryRun === true;
    const checkLine = profile.lastCheckAt
      ? el(
          'span',
          { class: profile.lastCheckStatus === 'failed' ? 'rw-bad-text' : null },
          `Проверка: ${profile.lastCheckStatus === 'failed' ? 'ошибка' : 'ок'}, ${this.dateText(profile.lastCheckAt, zone)}`,
        )
      : null;

    // Пока запрос в пути или прогон идёт, кнопки профиля неактивны; надписи не меняются.
    const profileBusy = this.isProfileBusy(profile);
    const actions = [];
    if (canRun) {
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn',
            'data-rw-key': `check:${profile.id}`,
            disabled: this.state.busy || profileBusy,
            title: 'Проверочный прогон: ничего не удаляет и не останавливает сервер',
            onclick: () => this.runProfile(profile, true),
          },
          'Проверка',
        ),
      );
    }
    actions.push(
      el(
        'button',
        {
          class: 'rw-btn',
          'data-rw-key': `preview:${profile.id}`,
          disabled: this.state.busy,
          onclick: () => this.previewProfile(profile),
        },
        'Что будет удалено',
      ),
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
      actions.push(
        el(
          'button',
          { class: 'rw-btn', 'data-rw-key': `edit:${profile.id}`, disabled: profileBusy, onclick: () => this.openEditor(profile) },
          'Изменить',
        ),
      );
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn',
            disabled: profileBusy,
            onclick: () => this.toggleProfile(profile),
          },
          profile.enabled ? 'Выключить' : 'Включить',
        ),
      );
    }
    // Боевой вайп — опасное действие: красная кнопка в конце ряда, подальше
    // от безопасной проверки, и запуск только после окна подтверждения.
    if (canRun) {
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn danger',
            'data-rw-key': `run:${profile.id}`,
            title: 'Остановить сервер и удалить файлы профиля прямо сейчас',
            disabled: profileBusy || this.state.busy,
            onclick: () => this.confirmRun(profile),
          },
          'Вайп сейчас',
        ),
      );
    }
    if (canManage) {
      actions.push(
        el(
          'button',
          {
            class: 'rw-btn danger',
            'data-rw-key': `delete:${profile.id}`,
            disabled: profileBusy,
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
          style: { background: profile.enabled ? 'var(--rw-ok)' : 'var(--rw-text-dim)' },
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
            checkOnly
              ? el(
                  'span',
                  {
                    class: 'rw-badge warn',
                    title: profile.options?.dryRun
                      ? 'В профиле включено «Только проверка»: вайпы ничего не удаляют'
                      : 'В настройках плагина включены только проверки: вайпы ничего не удаляют',
                  },
                  'только проверка',
                )
              : null,
          ),
        ),
        statusChip,
      ),
      el(
        'div',
        { class: 'rw-meta' },
        // Идущий прогон — отдельно от даты следующего срока: backend сдвигает её ещё до вайпа.
        profile.running
          ? el('span', { class: 'rw-warn-text' }, this.runningIsCheck(profile) ? 'Идёт проверка' : 'Идёт вайп')
          : null,
        this.nextRunLine(profile, zone),
        profile.lastRunAt
          ? el('span', null, `Последний: ${this.dateText(profile.lastRunAt, zone)}`)
          : null,
        profile.lastError
          ? el('span', { class: 'rw-bad-text' }, `Ошибка вайпа: ${profile.lastError}`)
          : null,
        // Пропущенный плановый вайп — из ответа профилей (lastSkippedAt, lastSkipReason).
        profile.lastSkippedAt
          ? el(
              'span',
              { class: 'rw-warn-text' },
              `Пропущен: ${this.dateText(profile.lastSkippedAt, zone)}` +
                (profile.lastSkipReason ? ` — ${profile.lastSkipReason}` : ''),
            )
          : null,
        checkLine,
        profile.lastCheckError
          ? el('span', { class: 'rw-bad-text' }, `Ошибка проверки: ${profile.lastCheckError}`)
          : null,
      ),
      el('div', { class: 'rw-actions' }, ...actions),
    );
  }

  /**
   * «Следующий запуск» — только если вайп правда запланирован. Выключенный
   * профиль и выключенный планировщик тик не трогает, а прошедшая дата —
   * это пропущенный вайп, а не «7 дн назад».
   */
  nextRunLine(profile, zone) {
    if (profile.enabled === false) return el('span', null, 'Не запланирован: профиль выключен');
    if (this.state.status?.schedulerEnabled === false) {
      return el('span', null, 'Не запланирован: планировщик выключен в настройках плагина');
    }
    const at = profile.nextRunAt ? new Date(profile.nextRunAt).getTime() : NaN;
    // Тик идёт раз в минуту: пару минут опоздания не считаем пропуском.
    const late = Number.isFinite(at) && Date.now() - at > 2 * 60000;
    let tail = '';
    if (Number.isFinite(at)) {
      // Идущий прогон показан отдельно («Идёт вайп»). «Идёт сейчас» — только если
      // наступил сам этот срок; иначе это уже следующий срок с обычным отсчётом.
      if (profile.running && at <= Date.now()) tail = ' (идёт сейчас)';
      else if (late) tail = ' (просрочен: время прошло, а вайпа не было)';
      else tail = ` (${humanDelta(profile.nextRunAt)})`;
    }
    return el(
      'span',
      { class: late && !profile.running ? 'rw-warn-text' : null },
      'Следующий запуск: ',
      el('b', null, this.dateText(profile.nextRunAt, zone)),
      tail,
    );
  }

  /**
   * Идёт проверка, а не вайп: по записи прогона в истории (status 'running');
   * пока её нет — по только что нажатой кнопке или по «только проверка».
   */
  runningIsCheck(profile) {
    const record = this.state.runs.find((run) => run.profileId === profile.id && run.status === 'running');
    if (record) return Boolean(record.dryRun);
    if (typeof profile.runningCheck === 'boolean') return profile.runningCheck;
    return Boolean(profile.options?.dryRun) || this.state.status?.dryRun === true;
  }

  /** Один шаг вайпа: сводная строка + раскрытие с полным текстом и метриками. */
  renderStep(step, index, run, offset, zone) {
    const ok = step.ok !== false;
    const label = STEP_LABELS[step.action] || step.action || 'шаг';
    const data = step.data && typeof step.data === 'object' ? step.data : {};
    const ms = typeof data.ms === 'number' ? data.ms : null;

    const detailText = sentence(step.detail);
    const head = [
      el('span', { class: 'rw-step-n', text: pad2(index + 1) }),
      el('span', { class: 'rw-step-clock', text: fmtClock(step.at, offset, zone) }),
      el('span', { class: ok ? 'rw-step-ok' : 'rw-step-bad', text: ok ? '✓' : '✕' }),
      el('span', { class: ok ? 'rw-step-label' : 'rw-step-label bad' }, label),
      detailText ? el('span', { class: 'rw-step-hint', title: detailText, text: detailText }) : null,
      ms !== null ? el('span', { class: 'rw-step-ms', text: fmtDuration(ms) }) : null,
    ];

    const dryRun = Boolean(run?.dryRun);
    const body = [
      detailText ? el('div', { class: 'rw-step-detail' }, detailText) : null,
      buildKvList(data, { dryRun }),
    ];

    if (step.action === 'delete' && run) {
      const lists = [];
      const deleted = Array.isArray(run.deleted) ? run.deleted : [];
      const runKey = run.id || run.startedAt || '';
      if (deleted.length) {
        lists.push(
          pathList(dryRun ? 'Было бы удалено' : 'Удалённые пути', deleted, this.detailsProps(`deleted:${runKey}`)),
        );
      }
      const skipped = Array.isArray(run.skipped) ? run.skipped : [];
      if (skipped.length) {
        lists.push(
          pathList(
            'Пропущенные пути',
            skipped.map((item) => `${item.path}${item.reason ? ` — ${sentence(item.reason)}` : ''}`),
            this.detailsProps(`skipped:${runKey}`),
          ),
        );
      }
      if (lists.length) body.push(el('div', { class: 'rw-step-lists' }, ...lists));
    }

    const children = body.filter(Boolean);

    return el(
      'details',
      this.detailsProps(`step:${run?.id || run?.startedAt || ''}:${index}`, { class: 'rw-step' }),
      el('summary', null, ...head),
      children.length ? el('div', { class: 'rw-step-body' }, ...children) : null,
    );
  }

  renderRuns() {
    const offset = Number(this.state.status?.clock?.offsetMinutes ?? 0);
    const panelZone = this.panelZone();
    // Время прогона — в поясе его профиля (как в карточке); пояс подписан,
    // если он не совпадает с поясом панели.
    const zoneOf = (run) => this.profileZone(this.state.profiles.find((item) => item.id === run.profileId));
    const rows = this.state.runs.slice(0, 30).map((run) => {
      const zone = zoneOf(run);
      const result = runResult(run);
      const count = run.deletedCount ?? (run.deleted || []).length;
      const stepTexts = new Set(
        (run.steps || []).flatMap((step) => [String(step.detail ?? ''), String(step.data?.message ?? '')]).filter(Boolean),
      );
      return el(
        'tr',
        null,
        el(
          'td',
          { 'data-label': 'Когда' },
          this.dateText(run.startedAt, zone),
          zone && zone !== panelZone ? el('span', { class: 'rw-dim' }, ` (${zone})`) : null,
        ),
        el('td', { 'data-label': 'Профиль', text: run.profileName || run.profileId }),
        el('td', { 'data-label': 'Источник', text: run.trigger === 'schedule' ? 'расписание' : 'вручную' }),
        el('td', { 'data-label': 'Результат' }, el('span', { class: `rw-badge ${result.kind}` }, result.text)),
        el('td', {
          'data-label': 'Удалено',
          // У идущего прогона итога ещё нет.
          text: result.running ? '—' : run.dryRun ? `было бы ${count}` : String(count),
        }),
        el(
          'td',
          null,
          el(
            'details',
            this.detailsProps(`run:${run.id || run.startedAt}`, { class: 'rw-details' }),
            el('summary', null, `шаги (${(run.steps || []).length})`),
            el(
              'div',
              { class: 'rw-steps' },
              ...(run.steps || []).map((step, index) => this.renderStep(step, index, run, offset, zone)),
              // Ошибка, которая уже есть в шаге «Ошибка», второй раз не повторяется.
              ...(run.errors || []).filter((error) => !stepTexts.has(String(error))).map((error) =>
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
      );
    });

    return el(
      'div',
      { class: 'rw-panel-block' },
      el(
        'h3',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        'История прогонов',
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
                el('th', null, 'Источник'),
                el('th', null, 'Результат'),
                el('th', null, 'Удалено'),
                el('th', null, 'Детали'),
              ),
            ),
            el('tbody', null, ...rows),
          )
        : el('div', { class: 'rw-dim' }, 'Прогонов ещё не было.'),
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
    this.state.modal = picker.parent || { type: 'editor', draft: picker.draft };
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
    const { title, text, items, note, confirmLabel, onConfirm, onCancel } = this.state.modal;
    // «Отмена» может вернуть в предыдущее окно (например, в пикер с отметками).
    const cancel = () => (typeof onCancel === 'function' ? onCancel() : this.closeModal());
    return el(
      'div',
      {
        class: 'rw-overlay',
        'data-rw-scroll': 'overlay',
        onkeydown: (event) => this.onModalKey(event),
        onclick: (event) => {
          if (event.target === event.currentTarget) cancel();
        },
      },
      el(
        'div',
        { class: 'rw-modal', 'data-rw-scroll': 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'rw-modal-head' }, el('h3', null, title)),
        text ? el('p', null, text) : null,
        // Последствия — обычным списком, по одной мысли в строке.
        Array.isArray(items) && items.length
          ? el('ul', { class: 'rw-list' }, ...items.map((item) => el('li', null, item)))
          : null,
        note ? el('p', { class: 'rw-hint' }, note) : null,
        el(
          'div',
          { class: 'rw-modal-actions' },
          el('button', { class: 'rw-btn', 'data-rw-autofocus': '', onclick: cancel }, 'Отмена'),
          el(
            'button',
            {
              class: 'rw-btn danger',
              onclick: async () => {
                this.state.modal = null;
                this.state.pathEdit = null;
                const result = onConfirm();
                this.render();
                await result;
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
    // Снимок — чтобы понять, есть ли несохранённые правки.
    this.editing = { draft, initial: draftSnapshot(draft) };
    this.render();
  }

  /** Закрыть редактор сразу: правок нет или их сознательно бросили (см. requestCloseEditor). */
  closeEditor() {
    this.editing = null;
    this.closeModal();
  }

  /** Есть ли в открытом редакторе несохранённые правки. */
  isDirty() {
    return Boolean(this.editing) && draftSnapshot(this.editing.draft) !== this.editing.initial;
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
        'data-rw-key': 'seed-mode',
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
        'data-rw-key': 'size-mode',
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
            'data-rw-key': 'seed-value',
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
              'data-rw-key': 'seed-list',
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
            'data-rw-key': 'size-value',
            type: 'number',
            min: '1000',
            max: '6000',
            // Пустое поле остаётся пустым: показываем то, что уйдёт в профиль.
            value: size.value == null ? '' : String(size.value),
            oninput: (event) => {
              size.value = numberOrNull(event.target.value);
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
            'data-rw-key': 'var-seed',
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
            'data-rw-key': 'var-size',
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
        'Сид и размер записываются в переменные сервера перед запуском. API-ключу нужно право менять ' +
          'параметры запуска сервера. Если команда запуска сервера эти переменные не использует, карта не изменится.',
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

  /** Поле «Часовой пояс»: список поясов браузера, без списка — текстовое поле. */
  renderTimeZoneField(draft) {
    const current = typeof draft.schedule.timeZone === 'string' ? draft.schedule.timeZone : '';
    const panelZone = this.state.status?.clock?.timezone;
    const zones = timeZoneList();
    let control;
    if (zones) {
      // UTC есть не в каждом списке браузера. Сохранённый пояс не должен
      // пропасть, даже если браузер называет его по-другому.
      const values = [...zones];
      if (!values.includes('UTC')) values.unshift('UTC');
      if (current && !values.includes(current)) values.unshift(current);
      control = el(
        'select',
        {
          'data-rw-key': 'timezone',
          onchange: (event) => {
            draft.schedule.timeZone = event.target.value;
          },
        },
        el('option', { value: '', selected: current ? null : '' }, panelZone ? `Пояс панели (${panelZone})` : 'Пояс панели'),
        ...values.map((zone) => el('option', { value: zone, selected: zone === current ? '' : null }, zone)),
      );
    } else {
      control = el('input', {
        'data-rw-key': 'timezone',
        type: 'text',
        value: current,
        placeholder: 'Europe/Moscow',
        oninput: (event) => {
          draft.schedule.timeZone = event.target.value.trim();
        },
      });
    }
    return el(
      'div',
      { class: 'rw-field' },
      el('label', null, 'Часовой пояс'),
      control,
      zones ? null : el('span', { class: 'rw-hint' }, 'Например Europe/Moscow. Пусто — пояс панели.'),
    );
  }

  renderEditorModal() {
    const draft = this.draft();
    if (!draft) return null;
    const canManage = this.state.status?.permissions?.canManage === true;

    const schedule = draft.schedule;

    const kindSelect = el(
      'select',
      {
        'data-rw-key': 'kind',
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
                'data-rw-key': 'nth',
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
              'data-rw-key': 'weekday',
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
            'data-rw-key': 'day',
            max: '31',
            value: schedule.day == null ? '' : String(schedule.day),
            oninput: (event) => {
              draft.schedule.day = numberOrNull(event.target.value);
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
            'data-rw-key': 'interval',
            max: '365',
            value: schedule.intervalDays == null ? '' : String(schedule.intervalDays),
            oninput: (event) => {
              draft.schedule.intervalDays = numberOrNull(event.target.value);
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
            'data-rw-key': 'anchor',
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
        el('label', null, 'Время'),
        el('input', {
          'data-rw-key': 'time',
          type: 'time',
          value: schedule.time ?? '',
          oninput: (event) => {
            draft.schedule.time = event.target.value;
          },
        }),
      ),
    );
    scheduleFields.push(this.renderTimeZoneField(draft));

    const pathList = (list, kind) => {
      const edit = this.state.pathEdit;
      if (!list.length) {
        return el(
          'div',
          { class: 'rw-paths', 'data-rw-scroll': `paths-${kind}` },
          el('div', { class: 'rw-dim', style: { padding: '4px 6px' } }, 'Список пуст'),
        );
      }
      return el(
        'div',
        { class: 'rw-paths', 'data-rw-scroll': `paths-${kind}` },
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

    const targetInput = el('input', {
      type: 'text',
      'data-rw-key': 'target',
      placeholder: 'путь или маска, например /server/*/proceduralmap.*.sav',
      value: draft.targetInput || '',
      style: { flex: '1 1 220px', width: 'auto' },
      oninput: (event) => {
        draft.targetInput = event.target.value;
      },
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        draft.targetInput = event.target.value;
        if (this.addTarget(draft)) this.render();
      },
    });

    // Набранный текст живёт в черновике: перерисовка (галочка, тост) его не стирает,
    // а «Сохранить» добавит его в исключения, даже если Enter не нажат.
    const excludeInput = el('input', {
      type: 'text',
      'data-rw-key': 'exclude',
      placeholder: 'например /server/*/cfg',
      value: draft.excludeInput || '',
      style: { flex: '1 1 220px', width: 'auto' },
      oninput: (event) => {
        draft.excludeInput = event.target.value;
      },
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        draft.excludeInput = event.target.value;
        if (this.addExclude(draft)) this.render();
      },
    });

    return el(
      'div',
      { class: 'rw-overlay', 'data-rw-scroll': 'overlay', onkeydown: (event) => this.onModalKey(event) },
      el(
        'div',
        {
          class: 'rw-modal wide',
          'data-rw-scroll': 'modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': draft.id ? 'Изменить профиль вайпа' : 'Новый профиль вайпа',
        },
        el(
          'div',
          { class: 'rw-modal-head' },
          el('h3', null, draft.id ? 'Изменить профиль вайпа' : 'Новый профиль вайпа'),
          el('button', { class: 'rw-btn small', onclick: () => this.requestCloseEditor() }, 'Закрыть'),
        ),
        this.state.modal.conflict
          ? el(
              'div',
              { class: 'rw-notice bad', style: { marginBottom: '12px' } },
              el(
                'div',
                null,
                'Профиль изменили в другом месте: в другой вкладке или другой админ. Ваши правки не сохранены.',
              ),
              el(
                'div',
                { class: 'rw-row', style: { marginTop: '8px' } },
                el(
                  'button',
                  { class: 'rw-btn small', type: 'button', onclick: () => this.reopenFresh(draft.id) },
                  'Загрузить новую версию',
                ),
                el('span', { class: 'rw-dim' }, 'Ваши правки в этом окне пропадут.'),
              ),
            )
          : null,
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
              'data-rw-key': 'name',
              'data-rw-autofocus': '',
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
            // Путь или маска вручную — своим полем, а не системным окном prompt
            // (на телефоне оно неудобно, а в части браузеров заблокировано).
            el(
              'div',
              { class: 'rw-row' },
              targetInput,
              el(
                'button',
                {
                  class: 'rw-btn small',
                  type: 'button',
                  onclick: () => {
                    if (this.addTarget(draft)) this.render();
                  },
                },
                'Добавить',
              ),
              el(
                'button',
                { class: 'rw-btn small', 'data-rw-key': 'pick-targets', onclick: () => this.openPicker('targets') },
                'Выбрать в файлах…',
              ),
            ),
            el(
              'span',
              { class: 'rw-hint' },
              'Маски: * — любые символы в имени, ? — один символ, ** — любая глубина. ' +
                '[*], [?] и [[] — сама звёздочка, вопрос или скобка в имени (так пишет пути выбор в файлах). Пресеты:',
            ),
            el('div', { class: 'rw-row' }, ...presetButtons),
          ),
          el(
            'div',
            { class: 'rw-field full' },
            el('label', null, 'Исключения (не удалять)'),
            pathList(draft.excludes, 'excludes'),
            el(
              'div',
              { class: 'rw-row' },
              excludeInput,
              el(
                'button',
                {
                  class: 'rw-btn small',
                  type: 'button',
                  onclick: () => {
                    if (this.addExclude(draft)) this.render();
                  },
                },
                'Добавить',
              ),
              el(
                'button',
                { class: 'rw-btn small', type: 'button', 'data-rw-key': 'pick-excludes', onclick: () => this.openPicker('excludes') },
                'Выбрать в файлах…',
              ),
            ),
            el(
              'span',
              { class: 'rw-hint' },
              'Исключение каталога защищает и всё его содержимое. Текст из поля попадёт в список по Enter, ' +
                '«Добавить» или при сохранении.',
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
                  'data-rw-key': 'opt-stop',
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
                  'data-rw-key': 'opt-start',
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
                  'data-rw-key': 'opt-warn',
                  checked: draft.options.warnChat === false ? null : '',
                  onchange: (event) => {
                    draft.options.warnChat = event.target.checked;
                    this.render();
                  },
                }),
                `Предупреждать в чате сервера перед вайпом (за ${this.warningMinutes()} мин, раз в минуту)`,
              ),
              this.state.status?.wipeWarning?.enabled === false
                ? el(
                    'span',
                    { class: 'rw-hint rw-warn-text' },
                    'Предупреждения выключены в настройках плагина: игроки ничего не получат, даже с этой галочкой.',
                  )
                : null,
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  'data-rw-key': 'opt-dry',
                  checked: draft.options.dryRun ? '' : null,
                  onchange: (event) => {
                    draft.options.dryRun = event.target.checked;
                    this.render();
                  },
                }),
                'Только проверка: ничего не удалять и не останавливать сервер',
              ),
              el(
                'label',
                { class: 'rw-check' },
                el('input', {
                  type: 'checkbox',
                  'data-rw-key': 'opt-enabled',
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
              'data-rw-key': 'commands',
              placeholder: 'oxide.reload *',
              oninput: (event) => {
                draft.options.commandsAfter = event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean);
              },
            }, (draft.options.commandsAfter || []).join('\n')),
            el('span', { class: 'rw-hint' }, 'Необязательно. API-ключу нужно право на консоль сервера.'),
          ),
        ),
        el(
          'div',
          { class: 'rw-modal-actions' },
          el('button', { class: 'rw-btn', onclick: () => this.requestCloseEditor() }, 'Отмена'),
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

  /** Перенести путь из поля «Что удалять» в список. true — список изменился. */
  addTarget(draft) {
    const value = String(draft.targetInput || '').trim();
    if (!value) return false;
    if (!draft.targets.includes(value)) draft.targets.push(value);
    draft.targetInput = '';
    return true;
  }

  /** Перенести текст из поля исключений в список. true — список изменился. */
  addExclude(draft) {
    const value = String(draft.excludeInput || '').trim();
    if (!value) return false;
    if (!draft.excludes.includes(value)) draft.excludes.push(value);
    draft.excludeInput = '';
    return true;
  }

  async saveProfile() {
    const draft = this.draft();
    if (!draft) return;
    if (!draft.name.trim()) {
      this.toast('bad', 'Укажите название профиля');
      return;
    }
    // Путь в удаление сам не добавляется: это опасная сторона — пусть человек нажмёт «Добавить».
    if (String(draft.targetInput || '').trim()) {
      this.toast('bad', 'В поле «Что удалять» остался путь: нажмите «Добавить» или очистите поле');
      return;
    }
    if (!draft.targets.length) {
      this.toast('bad', 'Добавьте хотя бы один путь или маску');
      return;
    }
    // Пустое поле не подменяется молча 05:00, 1, 7 или 3000 — просим заполнить.
    const problem = draftProblem(draft);
    if (problem) {
      this.toast('bad', problem);
      return;
    }
    // Исключение, набранное без Enter, не должно молча пропасть.
    const pendingExclude = String(draft.excludeInput || '').trim();
    this.addExclude(draft);
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
      // Версия, которую видел редактор: если профиль успели изменить в другой
      // вкладке, backend ответит 409, и старый черновик не затрёт чужую правку.
      if (draft.id && draft.updatedAt) payload.expectedUpdatedAt = draft.updatedAt;
      const base = this.apiBase();
      if (draft.id) await api(`${base}/profiles/${encodeURIComponent(draft.id)}`, { method: 'PUT', body: payload });
      else await api(`${base}/profiles`, { method: 'POST', body: payload });
      this.state.busy = false;
      this.state.modal = null;
      this.editing = null;
      await this.reload();
      this.toast(
        'ok',
        pendingExclude ? `Профиль сохранён. Исключение из поля добавлено: ${pendingExclude}` : 'Профиль сохранён',
      );
    } catch (error) {
      this.state.busy = false;
      if (error.code === 'PROFILE_CHANGED' && this.state.modal?.type === 'editor') {
        // Черновик не трогаем: человек решает сам — перечитать профиль или скопировать правки.
        this.state.modal.conflict = true;
      }
      this.toast('bad', error.message);
      this.render();
    }
  }

  /** Профиль изменили в другом месте: перечитать его и открыть редактор заново. */
  async reopenFresh(profileId) {
    this.state.modal = null;
    await this.reload();
    const fresh = this.state.profiles.find((item) => item.id === profileId);
    if (fresh) this.openEditor(fresh);
    else this.toast('bad', 'Профиль не найден — возможно, его удалили');
  }

  /**
   * Выполнить запрос по профилю один раз: пока он в пути, кнопки профиля
   * неактивны и повторное нажатие ничего не отправляет.
   */
  async withProfilePending(profile, action) {
    if (this.state.pending.has(profile.id)) return;
    this.state.pending.add(profile.id);
    this.render();
    try {
      await action();
    } finally {
      this.state.pending.delete(profile.id);
      this.render();
    }
  }

  async toggleProfile(profile) {
    await this.withProfilePending(profile, async () => {
      try {
        await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}`, {
          method: 'PUT',
          body: { enabled: !profile.enabled },
        });
        await this.reload();
      } catch (error) {
        this.toast('bad', error.message);
      }
    });
  }

  confirmDelete(profile) {
    this.state.modal = {
      type: 'confirm',
      title: 'Удалить профиль?',
      text: `Профиль «${profile.name}» будет удалён. История прогонов останется.`,
      confirmLabel: 'Удалить профиль',
      onConfirm: () =>
        this.withProfilePending(profile, async () => {
          try {
            await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
            await this.reload();
            this.toast('ok', 'Профиль удалён');
          } catch (error) {
            this.toast('bad', error.message);
          }
        }),
    };
    this.render();
  }

  /** Что сделает боевой вайп — для окна подтверждения, обычными словами. */
  runConsequences(profile) {
    const options = profile.options || {};
    if (options.dryRun || this.state.status?.dryRun) {
      return [
        'Включена «только проверка»: ничего не удалится, сервер не остановится.',
        'В истории появится запись проверки.',
      ];
    }
    const serverName = this.state.server?.name || profile.serverName || 'этого сервера';
    const items = [];
    // Без остановки backend не удаляет файлы на работающем сервере — вайп сразу отказывает.
    items.push(
      options.stopServer === false
        ? 'Остановка выключена в профиле: если сервер работает, вайп не начнётся.'
        : `Сервер «${serverName}» остановится, игроков отключит.`,
    );
    items.push(
      `Удалятся файлы и папки по путям профиля (путей: ${(profile.targets || []).length}). ` +
        'Папка удаляется целиком, со всем, что внутри.',
    );
    items.push('Вернуть удалённое нельзя.');
    if (profile.mapText) items.push(`Карта: ${profile.mapText}.`);
    items.push(
      options.startServer === false
        ? 'Запуск выключен в профиле: после вайпа сервер не запустится.'
        : 'После вайпа сервер запустится.',
    );
    const commands = options.commandsAfter || [];
    if (commands.length) items.push(`После запуска в консоль уйдут команды (${commands.length}).`);
    return items;
  }

  /** Боевой вайп — только после окна с последствиями и кнопкой «Отмена». */
  confirmRun(profile) {
    this.state.modal = {
      type: 'confirm',
      title: `Вайп сейчас: «${profile.name}»?`,
      items: this.runConsequences(profile),
      note: 'Сначала можно посмотреть «Что будет удалено» или запустить проверку.',
      confirmLabel: 'Вайп сейчас',
      onConfirm: () => this.runProfile(profile, false),
    };
    this.render();
  }

  async runProfile(profile, dryRun = false) {
    // Второе нажатие, пока первый запрос в пути, ничего не отправляет.
    await this.withProfilePending(profile, async () => {
      try {
        // dryRun — строго true или false (договорённость К5).
        const result = await api(`${this.apiBase()}/profiles/${encodeURIComponent(profile.id)}/run`, {
          method: 'POST',
          body: { dryRun: Boolean(dryRun) },
        });
        // Текст — по тому, что реально запущено: профиль с «Только проверка»
        // или глобальная проверка превращают и «Вайп сейчас» в проверку.
        const isCheck = typeof result?.dryRun === 'boolean' ? result.dryRun : Boolean(dryRun);
        this.toast(
          'ok',
          isCheck
            ? 'Проверка запущена: ничего не удаляется. Итог появится в истории прогонов.'
            : 'Вайп запущен. Итог появится в истории прогонов.',
        );
        // Прогон идёт в фоне: держим профиль занятым и опрашиваем, пока он не кончится.
        const shown = this.state.profiles.find((item) => item.id === profile.id);
        if (shown) {
          shown.running = true;
          // Только для вкладки: что запущено — пока записи прогона в истории ещё нет.
          shown.runningCheck = isCheck;
        }
        this.schedulePoll();
      } catch (error) {
        this.toast('bad', error.message);
      }
    });
  }

  /** За сколько минут до вайпа идут предупреждения — из настроек плагина. */
  warningMinutes() {
    const minutes = Number(this.state.status?.wipeWarning?.minutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
  }

  /** Проверка доставки предупреждения: одно сообщение в чат прямо сейчас. */
  async testWarn() {
    this.state.busy = true;
    this.render();
    try {
      const data = await api(`${this.apiBase()}/warn-test`, { method: 'POST' });
      const off = this.state.status?.wipeWarning?.enabled === false;
      this.toast(
        off ? 'warn' : 'ok',
        `В чат отправлено: ${data?.text || 'предупреждение'}` +
          (off ? '. Но перед вайпом предупреждения не уйдут: они выключены в настройках плагина.' : ''),
      );
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
    const paths = Array.isArray(data.paths) ? data.paths : [];
    // Договорённость К2: какие пути — папки и что пропущено (старый backend этого не отдаёт).
    const folders = new Set(Array.isArray(data.directories) ? data.directories : []);
    const skipped = Array.isArray(data.skipped) ? data.skipped.filter((item) => item && item.path) : [];
    return el(
      'div',
      {
        class: 'rw-overlay',
        'data-rw-scroll': 'overlay',
        onkeydown: (event) => this.onModalKey(event),
        onclick: (event) => {
          if (event.target === event.currentTarget) {
            this.state.preview = null;
            this.render();
          }
        },
      },
      el(
        'div',
        {
          class: 'rw-modal wide',
          'data-rw-scroll': 'modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': `Что будет удалено — ${profile.name}`,
        },
        el(
          'div',
          { class: 'rw-modal-head' },
          el('h3', null, `Что будет удалено — ${profile.name}`),
          el(
            'button',
            {
              class: 'rw-btn small',
              'data-rw-autofocus': '',
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
          folders.size ? el('span', null, `из них папок: ${folders.size}`) : null,
        ),
        data.truncated
          ? el(
              'div',
              { class: 'rw-notice bad', style: { marginBottom: '8px' } },
              `Список неполный: ${this.limitText(data.limitHit)}. Вайп с такими путями не пойдёт — ничего не удалится. ` +
                'Сузьте маски или добавьте исключения.',
            )
          : null,
        // Пропущенное (возможная ссылка, имя, которое нельзя передать агенту точно)
        // останавливает весь вайп: лучше не вайпать, чем вайпнуть наполовину.
        skipped.length
          ? el(
              'div',
              { class: 'rw-notice bad', style: { marginBottom: '8px' } },
              `Пропущено путей: ${skipped.length}. Пока они есть, вайп не начнётся — ничего не удалится. ` +
                'Смените права на 644 для файла и 755 для папки, переименуйте файл или добавьте путь ' +
                'в исключения (причины — ниже).',
            )
          : null,
        folders.size
          ? el(
              'div',
              { class: 'rw-notice warn', style: { marginBottom: '8px' } },
              'Папка в списке удаляется целиком, со всем, что внутри: файлами и вложенными папками.',
            )
          : null,
        paths.length
          ? el(
              'div',
              { class: 'rw-pre' },
              // Каталоги помечены (договорённость К2): одна строка в окне — это вся папка.
              ...paths.map((path) =>
                el(
                  'div',
                  null,
                  path,
                  folders.has(path)
                    ? el('span', { class: 'rw-warn-text' }, '  — папка: удалится целиком со всем содержимым')
                    : null,
                ),
              ),
            )
          : el('div', { class: 'rw-pre' }, 'Ничего не найдено — проверьте маски.'),
        skipped.length
          ? el(
              'details',
              // Раскрыт сразу: из-за этих путей вайп не пойдёт.
              { class: 'rw-details', style: { marginTop: '8px' }, open: '' },
              el('summary', null, `Пропущено: ${skipped.length}`),
              el(
                'div',
                { class: 'rw-pre' },
                skipped.map((item) => `${item.path}${item.reason ? ` — ${sentence(item.reason)}` : ''}`).join('\n'),
              ),
            )
          : null,
      ),
    );
  }

  /** Какой предел поиска путей сработал — обычными словами. */
  limitText(limitHit) {
    const kind = limitHit && typeof limitHit === 'object' ? limitHit.kind : null;
    const detail = limitHit?.detail ? ` (${limitHit.detail})` : '';
    if (kind === 'matches') return `найдено больше путей, чем можно удалить за один вайп${detail}`;
    if (kind === 'listings') return `просмотрено слишком много каталогов${detail}`;
    if (kind === 'depth') return `маска уходит слишком глубоко во вложенные папки${detail}`;
    return 'сработал предел поиска путей (500 путей или 250 просмотров каталогов)';
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
      // Окно редактора, куда вернуться (то же самое: с пометками и прокруткой).
      parent: this.state.modal,
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

  /**
   * Кнопки пикера. kind: 'selected' — отмеченное (или текущий каталог, если
   * ничего не отмечено), 'inside' — «всё внутри» текущего каталога. Пути
   * буквальные (literalPath). Если в удаление попадает папка, сначала окно
   * с последствиями: папка удаляется целиком, со всем содержимым.
   */
  pickerChoose(kind) {
    const picker = this.state.modal;
    if (!picker || picker.type !== 'picker') return;
    let paths;
    const folders = [];
    // Корень сервера целиком — ни «текущий каталог», ни «всё внутри».
    if (picker.path === '/' && (kind === 'inside' || !picker.selected.size)) return;
    if (kind === 'inside') {
      paths = [`${literalPath(picker.path)}/*`];
      folders.push(
        `Всё содержимое папки «${picker.path}» будет удаляться при каждом вайпе: файлы и вложенные папки целиком. ` +
          'Сама папка останется.',
      );
    } else {
      const raw = picker.selected.size ? [...picker.selected] : [picker.path];
      paths = raw.map(literalPath);
      for (const path of raw) {
        const entry = picker.entries.find((item) => item.path === path);
        const isFolder = picker.selected.size ? Boolean(entry?.isDirectory) : true;
        if (isFolder) folders.push(`«${path}» — папка: при вайпе удалится целиком, со всем, что внутри.`);
      }
    }
    // Исключения защищают — для них подтверждение не нужно.
    if (picker.mode !== 'targets' || !folders.length) {
      this.pickerAdd(paths);
      return;
    }
    this.state.modal = {
      type: 'confirm',
      title: folders.length > 1 ? 'Добавить папки в удаление?' : 'Добавить папку в удаление?',
      items: [...folders, 'Вернуть удалённое нельзя.'],
      note:
        'Чтобы удалять только часть папки, откройте её и отметьте нужные файлы. ' +
        'Перед вайпом список можно проверить в «Что будет удалено».',
      confirmLabel: 'Добавить',
      onConfirm: () => {
        this.state.modal = picker;
        this.pickerAdd(paths);
      },
      onCancel: () => {
        this.state.modal = picker;
        this.render();
      },
    };
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
    this.state.modal = picker.parent || { type: 'editor', draft };
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
                  color: 'var(--rw-primary)',
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
      // Имя, которое панель передала бы агенту не так («\» в имени, пробел в конце;
      // причину присылает backend), — удалился бы другой путь. Такое имя не
      // отмечается, а в такой каталог не зайти: панель открыла бы другой.
      const problem = entry.nameProblem ? sentence(entry.nameProblem) : '';
      const checkbox = el('input', {
        type: 'checkbox',
        checked: picker.selected.has(entry.path) ? '' : null,
        disabled: problem ? '' : null,
        title: problem || null,
        onchange: (event) => {
          if (event.target.checked) picker.selected.add(entry.path);
          else picker.selected.delete(entry.path);
          this.render();
        },
      });
      const name = entry.isDirectory && !problem
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
        : el('span', { class: 'rw-pname', title: problem || null }, entry.name);
      return el(
        'div',
        { class: 'rw-picker-row', title: problem || null, style: problem ? { flexWrap: 'wrap' } : null },
        checkbox,
        el('span', { class: 'rw-ico', text: entry.isDirectory ? '📁' : '📄' }),
        name,
        entry.isDirectory ? null : el('span', { class: 'rw-psize', text: bytes(entry.size) }),
        // Причина — второй строкой: на телефоне подсказки при наведении нет.
        problem ? el('span', { class: 'rw-hint', style: { flexBasis: '100%' } }, problem) : null,
      );
    });

    const selectedCount = picker.selected.size;

    return el(
      'div',
      {
        class: 'rw-overlay',
        'data-rw-scroll': 'overlay',
        onkeydown: (event) => this.onModalKey(event),
        onclick: (event) => {
          if (event.target === event.currentTarget) this.backToEditor();
        },
      },
      el(
        'div',
        {
          class: 'rw-modal wide',
          'data-rw-scroll': 'modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': picker.mode === 'targets' ? 'Выбор файлов и каталогов для удаления' : 'Выбор исключений',
        },
        el(
          'div',
          { class: 'rw-modal-head' },
          el(
            'button',
            { class: 'rw-btn small', 'data-rw-autofocus': '', onclick: () => this.backToEditor() },
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
          // В ключе — каталог: новый каталог открывается с начала списка.
          { class: 'rw-picker-list', 'data-rw-scroll': `picker-list:${picker.path}` },
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
              // Корень сервера целиком добавить нельзя (backend его всё равно выбросит).
              disabled: picker.loading || (!selectedCount && picker.path === '/'),
              title:
                !selectedCount && picker.path === '/'
                  ? 'Нельзя добавить весь корень сервера — выберите каталог или отметьте файлы'
                  : null,
              // Выбранное — буквальные пути: «*» и «?» в именах не становятся маской.
              onclick: () => this.pickerChoose('selected'),
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
              // Имя каталога — буквально, маска только «/*» в конце.
              onclick: () => this.pickerChoose('inside'),
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

/** Работающие экземпляры вкладки этого бандла. */
const liveApps = new Set();

/** Остановить экземпляры, чей узел ушёл со страницы. */
function sweepApps() {
  for (const app of [...liveApps]) {
    if (!app.root.isConnected) app.dispose();
  }
}

function mountRoot(node, serverId) {
  if (!node) {
    // React снял ref: при простой перерисовке узел тот же и останется на
    // странице, а при уходе со вкладки его уже не будет — проверим позже.
    setTimeout(sweepApps, 0);
    return;
  }
  // Один экземпляр на узел. Панель может сменить сервер на той же вкладке
  // (тот же узел, другой serverId) — тогда старый экземпляр останавливаем,
  // иначе его таймеры рисуют чужие профили под шапкой нового сервера.
  const current = node.__rwApp;
  if (current && !current.disposed && current.serverId === serverId) return;
  if (current) current.dispose();
  node.dataset.rwMounted = '1';
  node.dataset.rwServer = serverId;
  node.dataset.rwTheme = detectTheme();
  const app = new App(node, serverId);
  node.__rwApp = app;
  liveApps.add(app);
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
  version: '1.6.0',
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
  // Панель вызывает onUnmount у старого бандла, когда подменяет его новым
  // «на лету» (plugin_updated): останавливаем все экземпляры старой версии.
  onUnmount() {
    for (const app of [...liveApps]) app.dispose();
  },
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
