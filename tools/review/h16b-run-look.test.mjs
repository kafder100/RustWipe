/**
 * Ревью, гипотеза 16, утверждение H16b.
 * Кнопка боевого вайпа «Запустить сейчас» стоит вплотную к «Проверка (dry-run)»
 * и выглядит так же — промахнуться между ними легко.
 *
 * Правильное поведение (по самому интерфейсу): опасные действия во вкладке
 * помечены отдельно — «Удалить» профиль и кнопка подтверждения удаления
 * оформлены как опасные (rw-btn danger). Боевой вайп стирает файлы сервера,
 * значит должен быть помечен так же — или не стоять вплотную к безопасной
 * проверке.
 *
 * Как проверяем: DOM-шим и подмена fetch по образцу tools/ui-smoke.mjs,
 * сравниваем оформление и соседство кнопок в карточке профиля.
 * Backend не загружается, ничего не удаляется.
 *
 * Запуск: node tools/review/h16b-run-look.test.mjs
 *
 * Правка исполнителя F5: кнопка боевого вайпа теперь называется «Вайп сейчас»,
 * кнопка проверки — «Проверка» (без «(dry-run)»), тест ищет новые подписи.
 * Суть проверки не менялась.
 */

import assert from 'node:assert/strict';

// ── Маленький раннер: зависший тест на beforeExit считается проваленным ──
const unfinished = new Set();
let passed = 0;
let failed = 0;

async function test(name, fn) {
  unfinished.add(name);
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
  } finally {
    unfinished.delete(name);
  }
}

process.on('beforeExit', () => {
  if (!unfinished.size) return;
  for (const name of unfinished) {
    console.log(`  FAIL  ${name}`);
    console.log('        тест не завершился: цикл событий опустел, а проверка не дошла до конца');
  }
  unfinished.clear();
  process.exitCode = 1;
});

// ── Минимальный DOM (по образцу tools/ui-smoke.mjs) ──────────────────────
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
    const names = () => self._className.split(/\s+/).filter(Boolean);
    return {
      add(...list) {
        const set = new Set(names());
        for (const name of list) set.add(name);
        self._className = [...set].join(' ');
      },
      remove(...list) {
        const set = new Set(names());
        for (const name of list) set.delete(name);
        self._className = [...set].join(' ');
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
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
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

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  focus() {}
}

const head = new DomNode('head');
globalThis.Node = DomNode;
globalThis.document = {
  head,
  createElement: (tag) => new DomNode(tag),
  createTextNode: (text) => {
    const node = new DomNode('#text', 3);
    node._text = String(text);
    return node;
  },
  getElementById: () => null,
};

// Встроенный confirm браузера тоже считается подтверждением: записываем вызовы.
const nativeConfirms = [];
let nativeConfirmAnswer = false;
globalThis.window = {
  prompt: () => null,
  confirm: (text) => {
    nativeConfirms.push(String(text));
    return nativeConfirmAnswer;
  },
};

// Таймеры интерфейса (тосты, обновление истории) не нужны и не должны держать процесс.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function find(node, predicate) {
  let found = null;
  walk(node, (item) => {
    if (!found && predicate(item)) found = item;
  });
  return found;
}

function findAll(node, predicate) {
  const out = [];
  walk(node, (item) => {
    if (predicate(item)) out.push(item);
  });
  return out;
}

function findButton(node, text) {
  return find(node, (item) => item.tagName === 'BUTTON' && item.textContent.trim() === text);
}

function isDisabled(node) {
  return node.getAttribute('disabled') !== null;
}

/** Нажатие как в браузере: неактивная кнопка событие click не получает. */
function click(node, what) {
  assert.ok(node, `не найдена кнопка ${what}`);
  if (isDisabled(node)) return false;
  for (const handler of [...(node.listeners.click || [])]) {
    handler({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
  }
  return true;
}

function overlays(root) {
  return findAll(root, (item) => item.nodeType === 1 && item.classList.contains('rw-overlay'));
}

function overlayButtons(root) {
  return overlays(root).flatMap((overlay) => findAll(overlay, (item) => item.tagName === 'BUTTON'));
}

const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

async function settle(rounds = 15) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

async function until(condition, what, rounds = 300) {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`не дождались: ${what}`);
}

// ── Подмена API плагина ──────────────────────────────────────────────────
const profile = {
  id: 'wipe_1',
  name: 'Еженедельный вайп',
  serverId: 'srv1',
  serverName: 'Rust EU #1',
  enabled: true,
  schedule: { kind: 'weekly', weekday: 4, nth: 1, day: 1, time: '05:00', intervalDays: 7 },
  targets: ['/server/*/proceduralmap.*.sav', '/server/*/proceduralmap.*.map'],
  excludes: [],
  options: { stopServer: true, startServer: true, dryRun: false, warnChat: true, commandsAfter: [] },
  nextRunAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
  lastRunAt: null,
  lastRunStatus: null,
  lastError: null,
};

const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const path = String(url).replace('/api/plugins/rust-autowipe/', '');
  const method = options.method || 'GET';
  let body;
  try {
    body = options.body === undefined ? undefined : JSON.parse(options.body);
  } catch {
    body = options.body;
  }
  requests.push({ path, method, body });
  const json = (data) => ({
    ok: true,
    status: 200,
    async json() {
      return data;
    },
  });
  if (method === 'POST' && path.endsWith('/run')) {
    return json({ success: true, started: true, message: 'Вайп запущен в фоне.' });
  }
  if (path === 'presets') return json({ success: true, data: [] });
  if (path === 'servers/srv1/status') {
    return json({
      success: true,
      data: {
        server: { id: 'srv1', name: 'Rust EU #1', uuid: 'uuid-1', nodeId: 'node-1', status: 'running' },
        version: '1.5.6',
        clock: { now: new Date().toISOString(), timezone: 'UTC', offsetMinutes: 0, utcOffset: 'UTC+00:00' },
        hasApiKey: true,
        dryRun: false,
        schedulerEnabled: true,
        catchUpMinutes: 120,
        running: [],
        profilesCount: 1,
        permissions: { canManage: true, canRun: true },
      },
    });
  }
  if (path === 'servers/srv1/profiles') return json({ success: true, data: [{ ...profile }] });
  if (path.startsWith('servers/srv1/runs')) return json({ success: true, data: [] });
  return json({ success: true, data: {} });
};

/** Боевые запросы на запуск: POST …/run без dryRun: true. */
function liveRuns() {
  return requests.filter(
    (request) =>
      request.method === 'POST' && /\/profiles\/[^/]+\/run$/.test(request.path) && request.body?.dryRun !== true,
  );
}

function describe(request) {
  return `${request.method} ${request.path} ${JSON.stringify(request.body ?? null)}`;
}

const { default: frontend } = await import('../../rust-autowipe/frontend/frontend.mjs');
const tab = frontend.tabs[0];

async function mountTab() {
  const root = new DomNode('div');
  tab.component({ serverId: 'srv1' }).props.ref(root);
  await until(() => findButton(root, 'Вайп сейчас'), 'карточка профиля с кнопкой «Вайп сейчас»');
  return root;
}

// ── Тест ──────────────────────────────────────────────────────────────────
function classes(node) {
  return new Set(String(node.className).split(/\s+/).filter(Boolean));
}

async function main() {
  console.log('H16b: отличается ли кнопка боевого вайпа от соседней кнопки проверки');

  await test('H16b: боевой вайп помечен как опасное действие или не стоит вплотную к «Проверка (dry-run)»', async () => {
    const root = await mountTab();
    const live = findButton(root, 'Вайп сейчас');
    const dry = findButton(root, 'Проверка');
    const remove = findButton(root, 'Удалить');
    assert.ok(live && dry && remove, 'в карточке нет кнопок «Запустить сейчас», «Проверка (dry-run)» и «Удалить»');

    // Чем интерфейс отличает опасную кнопку от обычной: классы «Удалить», которых нет у кнопки проверки.
    const marker = [...classes(remove)].filter((name) => !classes(dry).has(name));
    assert.ok(marker.length, 'не удалось понять, чем интерфейс помечает опасную кнопку');

    const siblings = live.parentNode ? live.parentNode.children : [];
    const adjacent =
      live.parentNode === dry.parentNode && Math.abs(siblings.indexOf(live) - siblings.indexOf(dry)) === 1;
    const marked = marker.every((name) => classes(live).has(name));
    const info =
      `«Запустить сейчас» class="${live.className}", «Проверка (dry-run)» class="${dry.className}", ` +
      `«Удалить» class="${remove.className}"; стоят вплотную: ${adjacent ? 'да' : 'нет'}`;
    console.log(`        ${info}`);
    assert.ok(
      marked || !adjacent,
      `боевой вайп не помечен как опасный (нет «${marker.join(' ')}», как у «Удалить») и стоит вплотную к проверке`,
    );
  });

  console.log(`\nИтог H16b: прошло ${passed}, упало ${failed}`);
}

main();
