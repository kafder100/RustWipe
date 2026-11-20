/**
 * Общая обвязка тестов вкладки (исполнитель F5): маленький DOM без браузера,
 * поддельные таймеры и подмена API плагина. Сам файл не тест — его подключают
 * tools/review/fix-f5-*.test.mjs. Backend не загружается, сеть не нужна,
 * ничего не удаляется: подмена fetch только отвечает и записывает запросы.
 *
 *   import { setup, test } from './fix-f5-ui-lib.mjs';
 *   test('имя', async () => {
 *     const ui = await setup({ profiles: [...] });
 *     ui.click(ui.button('Проверка'));
 *     await ui.settle();
 *   });
 */

import assert from 'node:assert/strict';

const REAL_SET_IMMEDIATE = globalThis.setImmediate;

// ── Мини-раннер: тесты по очереди, зависший тест — провал ─────────────────

const queue = [];
let passed = 0;
let failed = 0;
let started = false;

export function test(name, fn) {
  queue.push({ name, fn });
  if (!started) {
    started = true;
    REAL_SET_IMMEDIATE(runQueue);
  }
}

async function runQueue() {
  let current = null;
  process.on('beforeExit', () => {
    if (!current) return;
    console.log(`  FAIL  ${current}`);
    console.log('        тест не завершился: цикл событий опустел, а проверка не дошла до конца');
    current = null;
    failed += 1;
    report();
  });
  for (const item of queue) {
    current = item.name;
    try {
      await item.fn();
      passed += 1;
      console.log(`  ok    ${item.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${item.name}`);
      const text = error instanceof Error ? error.message : String(error);
      for (const line of text.split('\n').slice(0, 12)) console.log(`        ${line}`);
    }
    current = null;
  }
  report();
}

function report() {
  console.log(`\nИтог: ${passed} PASS, ${failed} FAIL`);
  process.exitCode = failed ? 1 : 0;
}

// ── DOM ───────────────────────────────────────────────────────────────────

let documentRef = null;

export class DomNode {
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
    this._value = undefined;
    this._checked = undefined;
    this.scrollTop = 0;
    this._connected = null;
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
    const names = () => self._className.split(/\s+/).filter(Boolean);
    return {
      add(...list) {
        self._className = [...new Set([...names(), ...list])].join(' ');
      },
      remove(...list) {
        self._className = names().filter((name) => !list.includes(name)).join(' ');
      },
      contains(name) {
        return names().includes(name);
      },
      toggle(name, force) {
        const want = force === undefined ? !names().includes(name) : Boolean(force);
        if (want) this.add(name);
        else this.remove(name);
        return want;
      },
    };
  }

  /** Узел «в документе», пока цепочка родителей доходит до корня теста. */
  get isConnected() {
    if (this._connected !== null) return this._connected;
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return Boolean(node.isTestRoot);
  }

  set isConnected(value) {
    this._connected = Boolean(value);
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

  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'TEXTAREA') return this.textContent;
    if (this.tagName === 'SELECT') {
      const option = this.children.find((child) => child.getAttribute?.('selected') !== null) || this.children[0];
      return option ? option.getAttribute('value') ?? option.textContent : '';
    }
    return this.attributes.value ?? '';
  }

  set value(value) {
    this._value = String(value);
  }

  get checked() {
    if (this._checked !== undefined) return this._checked;
    return this.getAttribute('checked') !== null;
  }

  set checked(value) {
    this._checked = Boolean(value);
  }

  get disabled() {
    return this.getAttribute('disabled') !== null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
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

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  focus() {
    if (documentRef) documentRef.activeElement = this;
  }

  blur() {
    if (documentRef && documentRef.activeElement === this) documentRef.activeElement = documentRef.body;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 100, height: 10 };
  }

  setSelectionRange(start, end) {
    this.selection = [start, end];
  }

  /** Поддерживаются селекторы «[attr]», «[attr="v"]», «.class» и «tag». */
  querySelectorAll(selector) {
    const match = matcher(selector);
    const out = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.nodeType === 1 && match(child)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function matcher(selector) {
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (attr) {
    return (node) =>
      Object.prototype.hasOwnProperty.call(node.attributes, attr[1]) &&
      (attr[2] === undefined || node.attributes[attr[1]] === attr[2]);
  }
  const cls = /^\.([\w-]+)$/.exec(selector);
  if (cls) return (node) => node.classList.contains(cls[1]);
  if (/^[a-z]+$/i.test(selector)) return (node) => node.tagName === selector.toUpperCase();
  throw new Error(`DOM теста не знает селектор ${selector}`);
}

// ── Поддельные таймеры: время идёт только по команде теста ────────────────

export function createTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const timers = {
    get now() {
      return now;
    },
    pending,
    setTimeout(fn, ms = 0) {
      seq += 1;
      pending.set(seq, { fn, at: now + Math.max(0, Number(ms) || 0), every: null });
      return seq;
    },
    setInterval(fn, ms = 0) {
      seq += 1;
      const every = Math.max(1, Number(ms) || 1);
      pending.set(seq, { fn, at: now + every, every });
      return seq;
    },
    clear(id) {
      pending.delete(id);
    },
    /** Сдвинуть время на ms; срабатывают все таймеры по пути. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, item] of pending) {
          if (item.at <= target && (!next || item.at < next.at)) {
            nextId = id;
            next = item;
          }
        }
        if (!next) break;
        now = next.at;
        if (next.every) next.at = now + next.every;
        else pending.delete(nextId);
        next.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
  return timers;
}

/** Дать промисам доиграть (настоящие макрозадачи). */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => REAL_SET_IMMEDIATE(resolve));
}

// ── Поиск и действия ──────────────────────────────────────────────────────

export function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

export function findAll(node, predicate) {
  const out = [];
  walk(node, (item) => {
    if (item.nodeType === 1 && predicate(item)) out.push(item);
  });
  return out;
}

export function find(node, predicate) {
  return findAll(node, predicate)[0] || null;
}

// ── Подмена API плагина ───────────────────────────────────────────────────

export const SERVER = { id: 'srv1', name: 'Rust EU #1', uuid: 'uuid-1', nodeId: 'node-1', status: 'running' };

export function makeStatus(overrides = {}) {
  return {
    server: { ...SERVER },
    version: '1.5.6',
    clock: { now: new Date().toISOString(), timezone: 'UTC', offsetMinutes: 0, utcOffset: 'UTC+00:00' },
    hasApiKey: true,
    dryRun: false,
    schedulerEnabled: true,
    catchUpMinutes: 120,
    wipeWarning: { enabled: true, minutes: 5, text: 'Вайп сервера через {minutes} мин', state: null },
    running: [],
    profilesCount: 1,
    permissions: { canManage: true, canRun: true },
    ...overrides,
  };
}

export function makeProfile(overrides = {}) {
  return {
    id: 'wipe_1',
    name: 'Еженедельный вайп',
    serverId: SERVER.id,
    serverName: SERVER.name,
    enabled: true,
    schedule: { kind: 'weekly', weekday: 4, nth: 1, day: 1, time: '05:00', intervalDays: 7 },
    targets: ['/server/*/proceduralmap.*.sav', '/server/*/proceduralmap.*.map'],
    excludes: [],
    options: { stopServer: true, startServer: true, dryRun: false, warnChat: true, commandsAfter: [] },
    map: {
      seed: { mode: 'random', value: null, values: [] },
      size: { mode: 'keep', value: null, values: [] },
      vars: { seed: 'WORLD_SEED', size: 'WORLD_SIZE' },
    },
    mapText: 'сид случайный при вайпе · размер не меняется',
    nextRunAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    updatedAt: '2026-11-01T10:00:00.000Z',
    running: false,
    ...overrides,
  };
}

/**
 * Поставить DOM, таймеры и fetch, смонтировать вкладку.
 *   data: { status, profiles, runs, presets, files(path) }
 *   handle(request) — свой ответ на запрос; вернуть undefined, чтобы ответила подмена.
 * Возвращает объект с корнем, запросами и действиями.
 */
export async function setup({
  status = makeStatus(),
  profiles = [makeProfile()],
  runs = [],
  presets = [],
  files = null,
  handle = null,
  serverId = SERVER.id,
  moduleUrl = '../../rust-autowipe/frontend/frontend.mjs',
  prepare = null,
} = {}) {
  const timers = createTimers();
  const head = new DomNode('head');
  const body = new DomNode('body');
  const html = new DomNode('html');
  html.isTestRoot = true;
  html.appendChild(head);
  html.appendChild(body);
  const docListeners = {};
  const winListeners = {};
  const doc = {
    documentElement: html,
    head,
    body,
    activeElement: body,
    createElement: (tag) => new DomNode(tag),
    createTextNode: (text) => {
      const node = new DomNode('#text', 3);
      node._text = String(text);
      return node;
    },
    getElementById: (id) => find(html, (node) => node.id === id),
    addEventListener: (type, fn) => (docListeners[type] = docListeners[type] || []).push(fn),
    removeEventListener: (type, fn) => {
      const list = docListeners[type] || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
  };
  documentRef = doc;
  const prompts = [];
  const win = {
    prompts,
    prompt: () => (prompts.length ? prompts.shift() : null),
    confirm: () => true,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (type, fn) => (winListeners[type] = winListeners[type] || []).push(fn),
    removeEventListener: (type, fn) => {
      const list = winListeners[type] || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
  };
  globalThis.Node = DomNode;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(20, 20, 20)', colorScheme: 'dark' });
  globalThis.setTimeout = (fn, ms) => timers.setTimeout(fn, ms);
  globalThis.clearTimeout = (id) => timers.clear(id);
  globalThis.setInterval = (fn, ms) => timers.setInterval(fn, ms);
  globalThis.clearInterval = (id) => timers.clear(id);

  const state = { status, profiles, runs, presets };
  const requests = [];
  const reply = (statusCode, json) => ({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    async json() {
      return JSON.parse(JSON.stringify(json));
    },
  });

  globalThis.fetch = async (url, options = {}) => {
    const raw = String(url).replace('/api/plugins/rust-autowipe/', '');
    const [path, query = ''] = raw.split('?');
    const method = options.method || 'GET';
    let parsed;
    try {
      parsed = options.body === undefined ? undefined : JSON.parse(options.body);
    } catch {
      parsed = options.body;
    }
    const request = { path, query: Object.fromEntries(new URLSearchParams(query)), method, body: parsed };
    requests.push(request);
    if (handle) {
      const custom = await handle(request, state);
      if (custom !== undefined) {
        if (custom instanceof Error) throw custom;
        return reply(custom.status ?? 200, custom.json ?? custom);
      }
    }
    // Подмена отвечает одинаково для любого сервера: servers/<id>/…
    const tail = /^servers\/[^/]+\/(.*)$/.exec(path)?.[1] ?? null;
    if (path === 'presets') return reply(200, { success: true, data: state.presets });
    if (tail === 'status') return reply(200, { success: true, data: state.status });
    if (tail === 'profiles' && method === 'GET') return reply(200, { success: true, data: state.profiles });
    if (tail === 'runs') return reply(200, { success: true, data: state.runs });
    if (tail === 'files' && files) return reply(200, { success: true, data: files(request.query.path || '/') });
    if (/\/run$/.test(path) && method === 'POST') {
      return reply(200, { success: true, started: true, dryRun: parsed?.dryRun === true, message: 'Вайп запущен в фоне.' });
    }
    if (/\/profiles(\/[^/]+)?$/.test(path) && (method === 'POST' || method === 'PUT')) {
      return reply(200, { success: true, data: { ...(parsed || {}), id: 'wipe_new' } });
    }
    return reply(200, { success: true, data: {} });
  };

  // Подготовить страницу до монтирования (например, положить старый <style>).
  if (prepare) await prepare({ document: doc, window: win, DomNode });
  const mod = await import(moduleUrl);
  const root = new DomNode('div');
  body.appendChild(root);
  const element = mod.default.tabs[0].component({ serverId });
  element.props.ref(root);
  await settle();

  const ui = {
    mod,
    root,
    state,
    requests,
    timers,
    document: doc,
    window: win,
    docListeners,
    winListeners,
    settle,
    text: () => root.textContent,
    find: (predicate) => find(root, predicate),
    findAll: (predicate) => findAll(root, predicate),
    button(text, within = root) {
      return find(within, (node) => node.tagName === 'BUTTON' && node.textContent.trim() === text);
    },
    buttonLike(pattern, within = root) {
      return find(within, (node) => node.tagName === 'BUTTON' && pattern.test(node.textContent.trim()));
    },
    overlays: () => findAll(root, (node) => node.classList.contains('rw-overlay')),
    modal: () => find(root, (node) => node.classList.contains('rw-modal')),
    toast: () => {
      const node = find(root, (item) => item.classList.contains('rw-toast'));
      return node ? node.textContent : '';
    },
    /** Нажатие как в браузере: неактивная кнопка нажатие не получает. */
    click(node, what = 'кнопка') {
      assert.ok(node, `не найдена ${what}`);
      if (node.disabled) return false;
      for (const handler of [...(node.listeners.click || [])]) {
        handler({ type: 'click', target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
      }
      return true;
    },
    fire(node, type, extra = {}) {
      assert.ok(node, `нет элемента для события ${type}`);
      let prevented = false;
      const event = {
        type,
        target: node,
        currentTarget: node,
        preventDefault() {
          prevented = true;
          event.defaultPrevented = true;
        },
        stopPropagation() {},
        defaultPrevented: false,
        ...extra,
      };
      // Событие всплывает до корня, как в браузере.
      let current = node;
      while (current) {
        event.currentTarget = current;
        for (const handler of [...(current.listeners?.[type] || [])]) handler(event);
        current = current.parentNode;
      }
      for (const handler of [...(docListeners[type] || [])]) handler(event);
      return { prevented, event };
    },
    type(node, value) {
      assert.ok(node, 'нет поля ввода');
      node.value = value;
      node.focus();
      return ui.fire(node, 'input');
    },
    check(node, checked) {
      assert.ok(node, 'нет галочки');
      node.checked = checked;
      return ui.fire(node, 'change');
    },
    select(node, value) {
      assert.ok(node, 'нет списка');
      node.value = value;
      return ui.fire(node, 'change');
    },
    field(label) {
      const field = find(
        root,
        (node) => node.classList.contains('rw-field') && node.children[0]?.tagName === 'LABEL' && node.children[0].textContent.trim() === label,
      );
      return field ? find(field, (node) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)) : null;
    },
    input: (predicate) => find(root, (node) => node.tagName === 'INPUT' && predicate(node)),
    /** В открытом редакторе: вписать путь в поле «Что удалять» и нажать «Добавить». */
    addTarget(path) {
      const field = find(
        root,
        (node) => node.classList.contains('rw-field') && node.children[0]?.textContent === 'Что удалять (пути и маски)',
      );
      assert.ok(field, 'нет блока «Что удалять»');
      const input = find(field, (node) => node.tagName === 'INPUT' && node.getAttribute('data-rw-key') === 'target');
      assert.ok(input, 'нет поля для пути');
      ui.type(input, path);
      ui.click(ui.button('Добавить', field), '«Добавить» у путей');
    },
    async remount(nextServerId) {
      mod.default.tabs[0].component({ serverId: nextServerId }).props.ref(root);
      await settle();
    },
  };
  return ui;
}
