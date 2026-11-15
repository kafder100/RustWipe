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
.rw-root{--rw-border:rgba(148,163,184,.28);--rw-panel:rgba(148,163,184,.07);--rw-panel2:rgba(148,163,184,.14);
  --rw-accent:#f97316;--rw-ok:#22c55e;--rw-warn:#f59e0b;--rw-danger:#ef4444;--rw-muted:rgba(148,163,184,.85);
  display:flex;flex-direction:column;gap:14px;padding:18px;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:inherit;min-height:100%}
.rw-root *{box-sizing:border-box}
.rw-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.rw-title{display:flex;flex-direction:column;gap:2px;margin-right:auto}
.rw-title b{font-size:17px;letter-spacing:.2px}
.rw-title span{font-size:11.5px;color:var(--rw-muted);text-transform:uppercase;letter-spacing:.12em}
.rw-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rw-border);border-radius:999px;
  padding:3px 10px;font-size:11.5px;color:var(--rw-muted);white-space:nowrap}
.rw-chip.ok{color:var(--rw-ok);border-color:rgba(34,197,94,.4)}
.rw-chip.warn{color:var(--rw-warn);border-color:rgba(245,158,11,.4)}
.rw-chip.bad{color:var(--rw-danger);border-color:rgba(239,68,68,.45)}
.rw-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85}
.rw-btn{border:1px solid var(--rw-border);background:var(--rw-panel);color:inherit;border-radius:8px;
  padding:6px 11px;font:inherit;cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap}
.rw-btn:hover{background:var(--rw-panel2)}
.rw-btn:disabled{opacity:.5;cursor:not-allowed}
.rw-btn.primary{background:var(--rw-accent);border-color:transparent;color:#1a1206;font-weight:600}
.rw-btn.primary:hover{background:#fb8c3a}
.rw-btn.danger{color:var(--rw-danger);border-color:rgba(239,68,68,.4)}
.rw-btn.small{padding:3px 8px;font-size:12px;border-radius:6px}
.rw-grid{display:grid;grid-template-columns:230px minmax(0,1fr);gap:14px;align-items:start}
@media (max-width:900px){.rw-grid{grid-template-columns:1fr}}
.rw-side{border:1px solid var(--rw-border);border-radius:12px;background:var(--rw-panel);overflow:hidden}
.rw-side-head{padding:9px 12px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--rw-muted);
  border-bottom:1px solid var(--rw-border)}
.rw-server{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;border-left:2px solid transparent}
.rw-server:hover{background:var(--rw-panel2)}
.rw-server.active{background:var(--rw-panel2);border-left-color:var(--rw-accent)}
.rw-server .rw-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-server .rw-count{font-size:11px;color:var(--rw-muted)}
.rw-main{display:flex;flex-direction:column;gap:12px;min-width:0}
.rw-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rw-toolbar h3{margin:0;font-size:14px;font-weight:600}
.rw-toolbar .rw-spacer{flex:1}
.rw-card{border:1px solid var(--rw-border);border-radius:12px;background:var(--rw-panel);padding:12px 14px;
  display:flex;flex-direction:column;gap:8px}
.rw-card-head{display:flex;align-items:flex-start;gap:10px}
.rw-card-head .rw-grow{flex:1;min-width:0}
.rw-card h4{margin:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-meta{font-size:12px;color:var(--rw-muted);display:flex;gap:10px;flex-wrap:wrap}
.rw-meta b{font-weight:600;color:inherit}
.rw-actions{display:flex;gap:8px;flex-wrap:wrap}
.rw-empty{border:1px dashed var(--rw-border);border-radius:12px;padding:24px;text-align:center;color:var(--rw-muted)}
.rw-table{width:100%;border-collapse:collapse;font-size:12.5px}
.rw-table th,.rw-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rw-border);vertical-align:top}
.rw-table th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--rw-muted);font-weight:600}
.rw-table tr:last-child td{border-bottom:none}
.rw-badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--rw-border)}
.rw-badge.ok{color:var(--rw-ok);border-color:rgba(34,197,94,.45)}
.rw-badge.bad{color:var(--rw-danger);border-color:rgba(239,68,68,.45)}
.rw-badge.warn{color:var(--rw-warn);border-color:rgba(245,158,11,.45)}
.rw-panel-block{border:1px solid var(--rw-border);border-radius:12px;background:var(--rw-panel);padding:12px 14px}
.rw-panel-block h3{margin:0 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--rw-muted)}
.rw-overlay{position:fixed;inset:0;background:rgba(4,7,12,.62);display:flex;align-items:flex-start;justify-content:center;
  padding:40px 16px;overflow:auto;z-index:60}
.rw-modal{width:min(760px,100%);background:var(--rw-modal-bg,#141a23);border:1px solid var(--rw-border);
  border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.45);padding:16px 18px;color:inherit}
.rw-modal.wide{width:min(880px,100%)}
.rw-modal h3{margin:0 0 12px;font-size:15px}
.rw-modal-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.rw-modal-head h3{margin:0;flex:1}
.rw-form{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}
@media (max-width:720px){.rw-form{grid-template-columns:1fr}}
.rw-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.rw-field.full{grid-column:1 / -1}
.rw-field label{font-size:11.5px;color:var(--rw-muted);letter-spacing:.03em}
.rw-field input,.rw-field select,.rw-field textarea{width:100%;border:1px solid var(--rw-border);border-radius:8px;
  background:rgba(148,163,184,.08);color:inherit;padding:7px 9px;font:inherit}
.rw-field textarea{min-height:60px;resize:vertical}
.rw-field .rw-hint{font-size:11px;color:var(--rw-muted)}
.rw-checks{display:flex;flex-direction:column;gap:6px}
.rw-check{display:flex;align-items:center;gap:8px;font-size:12.5px}
.rw-check input{width:15px;height:15px;accent-color:var(--rw-accent)}
.rw-paths{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto;border:1px solid var(--rw-border);
  border-radius:8px;padding:6px;background:rgba(148,163,184,.05)}
.rw-path{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.rw-path:hover{background:var(--rw-panel2)}
.rw-path span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rw-path button{border:none;background:transparent;color:var(--rw-danger);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}
.rw-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rw-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
.rw-notice{border:1px solid var(--rw-border);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--rw-muted)}
.rw-notice.warn{color:var(--rw-warn);border-color:rgba(245,158,11,.4)}
.rw-notice.bad{color:var(--rw-danger);border-color:rgba(239,68,68,.4)}
.rw-toast{position:fixed;right:18px;bottom:18px;z-index:90;border:1px solid var(--rw-border);border-radius:10px;
  padding:10px 14px;background:#141a23;color:#e5e9f0;box-shadow:0 12px 40px rgba(0,0,0,.4);max-width:420px;font-size:12.5px}
.rw-toast.ok{border-color:rgba(34,197,94,.5)}
.rw-toast.bad{border-color:rgba(239,68,68,.55)}
.rw-picker-list{border:1px solid var(--rw-border);border-radius:10px;max-height:340px;overflow:auto;margin-top:8px}
.rw-picker-row{display:flex;align-items:center;gap:9px;padding:6px 10px;border-bottom:1px solid var(--rw-border);cursor:default}
.rw-picker-row:last-child{border-bottom:none}
.rw-picker-row:hover{background:var(--rw-panel2)}
.rw-picker-row .rw-ico{width:16px;text-align:center;opacity:.8}
.rw-picker-row .rw-pname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.rw-picker-row .rw-psize{font-size:11px;color:var(--rw-muted)}
.rw-crumbs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;font-size:12px;margin-top:8px}
.rw-crumbs button{border:none;background:transparent;color:var(--rw-accent);cursor:pointer;font:inherit;padding:1px 3px}
.rw-crumbs span{color:var(--rw-muted)}
.rw-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;
  max-height:320px;overflow:auto;border:1px solid var(--rw-border);border-radius:8px;padding:10px;background:rgba(148,163,184,.05)}
.rw-steps{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:3px;font-size:12px}
.rw-steps li{display:flex;gap:8px}
.rw-steps .rw-t{color:var(--rw-muted);font-variant-numeric:tabular-nums}
.rw-details summary{cursor:pointer;color:var(--rw-accent);font-size:12px}
.rw-inline{display:inline-flex;align-items:center;gap:6px}
.rw-dim{color:var(--rw-muted)}
`;
  document.head.appendChild(style);
}

// ── Приложение ────────────────────────────────────────────────────────────

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
    options: { stopServer: true, startServer: true, dryRun: false, commandsAfter: [] },
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
    this.render();
    await this.reload();
    this.clockTimer = setInterval(() => {
      if (!this.root.isConnected) {
        clearInterval(this.clockTimer);
        return;
      }
      const chip = this.root.querySelector('[data-rw-clock]');
      if (chip && this.state.status) chip.textContent = this.panelClockText();
    }, 15000);
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
    if (status.schedulerEnabled === false) {
      chips.push(el('span', { class: 'rw-chip warn' }, 'Планировщик выключен'));
    }
    if (status.permissions && status.permissions.canManage === false) {
      chips.push(el('span', { class: 'rw-chip' }, 'Только просмотр'));
    }
    if (status.version) chips.push(el('span', { class: 'rw-chip' }, `v${status.version}`));

    return el(
      'div',
      { class: 'rw-head' },
      el(
        'div',
        { class: 'rw-title' },
        el('b', null, 'Rust AutoWipe'),
        el('span', null, 'расписание вайпов и удаление файлов'),
      ),
      ...chips,
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
            el('summary', null, 'шаги'),
            el(
              'ul',
              { class: 'rw-steps' },
              ...(run.steps || []).map((step) =>
                el(
                  'li',
                  null,
                  el('span', { class: 'rw-t', text: (step.at || '').slice(11, 19) }),
                  el('span', {
                    text: `${step.ok ? '✓' : '✕'} ${step.action}${step.detail ? ` — ${step.detail}` : ''}`,
                    style: step.ok ? undefined : { color: 'var(--rw-danger)' },
                  }),
                ),
              ),
              ...(run.warnings || []).map((warning) =>
                el('li', null, el('span', { class: 'rw-t', text: '' }), el('span', { style: { color: 'var(--rw-warn)' } }, `! ${warning}`)),
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
        }
      : blankDraft(this.serverId);
    if (!draft.name) draft.name = '';
    draft.serverId = this.serverId;
    this.state.modal = { type: 'editor', draft };
    this.render();
  }

  draft() {
    return this.state.modal && this.state.modal.type === 'editor' ? this.state.modal.draft : null;
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

    const pathList = (list, kind) =>
      el(
        'div',
        { class: 'rw-paths' },
        ...(list.length
          ? list.map((path, index) =>
              el(
                'div',
                { class: 'rw-path' },
                el('span', { title: path }, path),
                el(
                  'button',
                  {
                    title: 'Убрать',
                    onclick: () => {
                      list.splice(index, 1);
                      this.render();
                    },
                  },
                  '×',
                ),
              ),
            )
          : [el('div', { class: 'rw-dim', style: { padding: '4px 6px' } }, 'Список пуст')]),
      );

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
      {
        class: 'rw-overlay',
        onclick: (event) => {
          if (event.target === event.currentTarget) this.closeModal();
        },
      },
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
          if (event.target === event.currentTarget) this.closeModal();
        },
      },
      el(
        'div',
        { class: 'rw-modal wide' },
        el(
          'div',
          { class: 'rw-modal-head' },
          el('h3', null, `Что будет удалено — ${profile.name}`),
          el('button', { class: 'rw-btn small', onclick: () => this.closeModal() }, 'Закрыть'),
        ),
        el(
          'div',
          { class: 'rw-meta', style: { marginBottom: '8px' } },
          el('span', null, `Сервер: ${data.server?.name || '—'} (${statusLabel(data.server?.status)})`),
          el('span', null, `Найдено путей: ${data.count}`),
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
          if (event.target === event.currentTarget) this.closeModal();
        },
      },
      el(
        'div',
        { class: 'rw-modal wide' },
        el(
          'div',
          { class: 'rw-modal-head' },
          el(
            'h3',
            null,
            picker.mode === 'targets' ? 'Выбор файлов и каталогов для удаления' : 'Выбор исключений',
          ),
          el('button', { class: 'rw-btn small', onclick: () => this.closeModal() }, 'Закрыть'),
        ),
        el('div', { class: 'rw-notice' }, 'Клик по каталогу — перейти внутрь. Чекбокс — отметить для добавления.'),
        crumbs,
        picker.error ? el('div', { class: 'rw-notice bad', style: { marginTop: '8px' } }, picker.error) : null,
        el(
          'div',
          { class: 'rw-picker-list' },
          picker.loading
            ? el('div', { class: 'rw-dim', style: { padding: '12px' } }, 'Читаю каталог…')
            : rows.length
              ? rows
              : el('div', { class: 'rw-dim', style: { padding: '12px' } }, 'Пусто'),
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
  const app = new App(node, serverId);
  void app.start();
}

const manifest = {
  name: 'rust-autowipe',
  version: '1.1.1',
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
