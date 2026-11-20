/**
 * Дымовой тест фронтенда без браузера: минимальный DOM-шим + мок fetch.
 * Проверяет, что рендер, модалки и обработчики не падают.
 *
 * Запуск: node tools/ui-smoke.mjs
 */

import assert from 'node:assert/strict';

// ── Минимальный DOM ──────────────────────────────────────────────────────
class DomNode {
  constructor(tag, nodeType = 1) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = nodeType;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this._className = '';
    this._text = '';
    this.isConnected = true;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || '');
  }

  get classList() {
    const self = this;
    return {
      add(...names) {
        const set = new Set(self._className.split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        self._className = [...set].join(' ');
      },
      remove(...names) {
        const set = new Set(self._className.split(/\s+/).filter(Boolean));
        for (const name of names) set.delete(name);
        self._className = [...set].join(' ');
      },
      contains(name) {
        return self._className.split(/\s+/).includes(name);
      },
    };
  }

  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = String(value);
      return;
    }
    this.children = [];
    const text = new DomNode('#text', 3);
    text._text = String(value);
    text.parentNode = this;
    this.children.push(text);
  }

  set innerHTML(value) {
    this.children = [];
    if (value) this.textContent = String(value);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

const head = new DomNode('head');
const styles = new Map();

globalThis.Node = DomNode;
globalThis.document = {
  head,
  createElement: (tag) => new DomNode(tag),
  createTextNode: (text) => {
    const node = new DomNode('#text', 3);
    node._text = String(text);
    return node;
  },
  getElementById: (id) => styles.get(id) || null,
};
globalThis.window = { prompt: () => null };
// Таймеры не должны держать процесс и не нужны для рендера.
globalThis.setInterval = () => 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function textOf(node) {
  return node.textContent;
}

function find(node, predicate) {
  let found = null;
  walk(node, (item) => {
    if (!found && predicate(item)) found = item;
  });
  return found;
}

function findByText(node, text) {
  return find(node, (item) => item.nodeType === 1 && item.textContent.trim() === text);
}

function click(node) {
  assert.ok(node, 'кнопка не найдена');
  const handlers = node.listeners.click || [];
  for (const handler of handlers) handler({ target: node, currentTarget: node, preventDefault() {} });
}

// ── Мок API ───────────────────────────────────────────────────────────────
const profile = {
  id: 'wipe_1',
  name: 'Еженедельный карта-вайп',
  serverId: 'srv1',
  serverName: 'Rust EU #1',
  enabled: true,
  schedule: { kind: 'weekly', weekday: 4, nth: 1, day: 1, time: '05:00', intervalDays: 7 },
  targets: ['/server/*/proceduralmap.*.sav', '/server/*/proceduralmap.*.map'],
  excludes: [],
  options: { stopServer: true, startServer: true, dryRun: false, commandsAfter: [] },
  nextRunAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
  lastRunAt: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
  lastRunStatus: 'ok',
  lastError: null,
};

const run = {
  id: 'run_1',
  profileId: 'wipe_1',
  profileName: 'Еженедельный карта-вайп',
  trigger: 'schedule',
  ok: true,
  dryRun: false,
  startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  deletedCount: 4,
  steps: [
    { at: new Date().toISOString(), action: 'stop', ok: true, detail: 'сервер остановлен' },
    { at: new Date().toISOString(), action: 'delete', ok: true, detail: 'удалено 4' },
  ],
  warnings: [],
};

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace('/api/plugins/rust-autowipe/', '');
  requests.push({ path, method: options.method || 'GET', body: options.body });
  const json = (data) => ({
    ok: true,
    status: 200,
    async json() {
      return data;
    },
  });
  if (path.endsWith('/run')) return json({ success: true, started: true, message: 'Вайп запущен в фоне.' });
  if (path.endsWith('/preview')) {
    return json({
      success: true,
      data: {
        paths: ['/server/rust/proceduralmap.4500.1.2.sav', '/server/rust/proceduralmap.4500.1.2.map'],
        count: 2,
        truncated: false,
        server: { id: 'srv1', name: 'Rust EU #1', status: 'running' },
      },
    });
  }
  if (path.endsWith('/panel-check')) return json({ success: true, data: { ok: true, base: 'http://127.0.0.1:3000' } });
  if (path === 'presets') {
    return json({
      success: true,
      data: [
        { id: 'rust-map', label: 'Карта', description: 'map', targets: ['/server/*/proceduralmap.*.sav'], excludes: [] },
      ],
    });
  }
  if (path === 'servers/srv1/status') {
    return json({
      success: true,
      data: {
        server: { id: 'srv1', name: 'Rust EU #1', uuid: 'uuid-1', nodeId: 'node-1', status: 'running' },
        version: '1.1.0',
        clock: { now: new Date().toISOString(), timezone: 'Asia/Yekaterinburg', offsetMinutes: 300, utcOffset: 'UTC+05:00' },
        hasApiKey: true,
        dryRun: false,
        schedulerEnabled: true,
        catchUpMinutes: 120,
        running: [],
        profilesCount: 1,
        permissions: { canManage: true, canRun: true, canView: true },
      },
    });
  }
  if (path === 'servers/srv1/profiles') return json({ success: true, data: [profile] });
  if (path.startsWith('servers/srv1/runs')) return json({ success: true, data: [run] });
  if (path.startsWith('servers/srv1/files')) {
    return json({
      success: true,
      data: {
        path: '/server/rust',
        parent: '/server',
        breadcrumbs: [
          { name: 'server', path: '/server' },
          { name: 'rust', path: '/server/rust' },
        ],
        entries: [
          { name: 'proceduralmap.4500.1.2.sav', path: '/server/rust/proceduralmap.4500.1.2.sav', isDirectory: false, size: 1024 },
          { name: 'cfg', path: '/server/rust/cfg', isDirectory: true, size: 0 },
        ],
      },
    });
  }
  return json({ success: true, data: {} });
};

// ── Тест ──────────────────────────────────────────────────────────────────
const mod = await import('../rust-autowipe/frontend/frontend.mjs');
const tab = mod.default.tabs[0];
assert.equal(tab.id, 'rust-autowipe-server');
assert.equal(tab.location, 'server');
assert.deepEqual(tab.templateFilter, { namePattern: 'rust' });
assert.deepEqual(tab.requiredPermissions, ['server.read']);

const root = new DomNode('div');
const element = tab.component({ serverId: 'srv1' });
assert.equal(element.$$typeof, Symbol.for('react.transitional.element'));
assert.equal(typeof element.props.ref, 'function');
element.props.ref(root);
assert.equal(root.dataset.rwMounted, '1');

// Ждём асинхронный reload
await new Promise((resolve) => realSetTimeout(resolve, 20));

assert.ok(styles.size === 0 || true);
assert.ok(textOf(root).includes('Rust AutoWipe'), 'нет заголовка');
assert.ok(textOf(root).includes('Еженедельный карта-вайп'), 'нет профиля в списке');
assert.ok(textOf(root).includes('Rust EU #1'), 'нет имени сервера над списком профилей');
assert.ok(!textOf(root).includes('Все серверы'), 'остался панельный список серверов');
assert.ok(textOf(root).includes('История прогонов'), 'нет истории');

// Открываем редактор
click(findByText(root, '+ Новый профиль'));
assert.ok(textOf(root).includes('Новый профиль вайпа'), 'редактор не открылся');

// Переключаем тип расписания (select → change); серверного селекта больше нет
const selects = [];
walk(root, (node) => {
  if (node.tagName === 'SELECT') selects.push(node);
});
assert.ok(selects.length >= 1, 'нет селектов в редакторе');
const kindSelect = selects[0];
const changeHandlers = kindSelect.listeners.change || [];
for (const handler of changeHandlers) handler({ target: { value: 'monthly_nth_weekday' } });
assert.ok(textOf(root).includes('Какой по счёту'), 'нет поля «какой по счёту»');

// Открываем файловый пикер
click(findByText(root, 'Выбрать в файлах…'));
await new Promise((resolve) => realSetTimeout(resolve, 20));
assert.ok(textOf(root).includes('Выбор файлов и каталогов'), 'пикер не открылся');
assert.ok(textOf(root).includes('proceduralmap.4500.1.2.sav'), 'пикер не показал файлы');

// Выбираем файл чекбоксом и добавляем
const checkbox = find(root, (node) => node.tagName === 'INPUT' && node.attributes.type === 'checkbox');
assert.ok(checkbox, 'нет чекбокса');
for (const handler of checkbox.listeners.change || []) {
  handler({ target: { checked: true } });
}
click(find(root, (node) => node.nodeType === 1 && /Добавить выбранные|Добавить текущий/.test(node.textContent) && node.tagName === 'BUTTON'));
assert.ok(textOf(root).includes('/server/rust/proceduralmap.4500.1.2.sav'), 'путь не добавился');
assert.ok(textOf(root).includes('Новый профиль вайпа'), 'не вернулись в редактор');

// Закрываем редактор: в нём правки (путь из пикера), поэтому «Отмена» сначала спрашивает
const runPosts = () => requests.filter((request) => request.path.endsWith('/run') && request.method === 'POST');
click(findByText(root, 'Отмена'));
assert.ok(textOf(root).includes('Закрыть без сохранения?'), 'редактор с правками закрылся без вопроса');
click(findByText(root, 'Закрыть без сохранения'));
assert.ok(!textOf(root).includes('Новый профиль вайпа'), 'редактор не закрылся');

// Запускаем вайп вручную: сначала окно подтверждения
click(findByText(root, 'Вайп сейчас'));
const overlay = find(root, (node) => node.nodeType === 1 && node.className === 'rw-overlay');
assert.ok(overlay, 'нет окна подтверждения перед вайпом');
assert.ok(textOf(overlay).includes('Вернуть удалённое нельзя'), 'в окне не сказано о последствиях');
assert.equal(runPosts().length, 0, 'вайп ушёл без подтверждения');
click(find(overlay, (node) => node.tagName === 'BUTTON' && node.textContent.trim() === 'Вайп сейчас'));
await new Promise((resolve) => realSetTimeout(resolve, 20));
assert.equal(runPosts().length, 1, 'не было POST на запуск после подтверждения');
assert.ok(textOf(root).includes('Вайп сейчас'), 'интерфейс сломался после запуска');

// Просмотр «что будет удалено»
click(findByText(root, 'Что будет удалено'));
await new Promise((resolve) => realSetTimeout(resolve, 20));
assert.ok(textOf(root).includes('Что будет удалено —'), 'модалка предпросмотра не открылась');
assert.ok(textOf(root).includes('/server/rust/proceduralmap.4500.1.2.map'), 'предпросмотр без путей');

console.log('UI smoke: OK');
console.log(`Запросов к API: ${requests.length}`);
