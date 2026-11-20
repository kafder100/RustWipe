/**
 * Ревью, гипотеза 17, утверждение H17c.
 * Кнопка пикера «Добавить маску «всё внутри»» в каталоге, в имени которого
 * есть * или ?, дописывает /* к имени как есть: маска захватывает содержимое
 * соседних каталогов с похожими именами.
 *
 * Правильное поведение: «всё внутри» — содержимое именно текущего каталога
 * (подсказка кнопки: «всё содержимое текущего каталога»), владелец: «Строго
 * выбранные файлы». Сам каталог и соседние каталоги не трогаются.
 *
 * Цепочка целиком: пикер интерфейса → POST профиля в настоящие роуты backend →
 * сохранённый профиль → настоящий прогон вайпа (executeProfileRun) → запросы
 * delete к агенту. Файловый туннель — дерево в памяти, REST панели — подмена;
 * настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/h17c-picker-inside-mask.test.mjs
 *
 * Правка исполнителя F5: перед добавлением папки пикер спрашивает подтверждение
 * (находка L31-3) — тест подтверждает окно. Суть проверки не менялась.
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
globalThis.window = { prompt: () => null, confirm: () => true };

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

function byClass(node, name) {
  return find(node, (item) => item.nodeType === 1 && item.classList.contains(name));
}

function findButton(node, text) {
  return find(node, (item) => item.tagName === 'BUTTON' && item.textContent.trim() === text);
}

/** Нажатие как в браузере: неактивная кнопка событие click не получает. */
function click(node, what) {
  assert.ok(node, `не найдена кнопка ${what}`);
  if (node.getAttribute('disabled') !== null) return false;
  for (const handler of [...(node.listeners.click || [])]) {
    handler({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
  }
  return true;
}

const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));

async function settle(rounds = 15) {
  for (let i = 0; i < rounds; i += 1) await tick();
}

async function until(condition, what, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error(`не дождались: ${what}`);
}

// ── Подмены backend (образец — tools/test.mjs) ───────────────────────────
const PLUGIN_API = '/api/plugins/rust-autowipe';
const PANEL = 'https://panel.test';

const dir = (name) => ({ name, isDirectory: true });
const file = (name) => ({ name, isDirectory: false });

/** Дерево сервера. На Linux * и ? допустимы в именах (их часто задают игроки и плагины). */
const TREE = {
  '/': [dir('server'), dir('oxide'), file('RustDedicated'), file('start.sh')],
  '/server': [dir('rust')],
  '/server/rust': [file('proceduralmap.4500.1.2.map'), file('proceduralmap.4500.1.2.sav'), dir('cfg')],
  '/server/rust/cfg': [file('server.cfg')],
  '/oxide': [dir('data'), dir('plugins')],
  '/oxide/plugins': [file('Clans.cs')],
  '/oxide/data': [dir('Backups'), dir('Clans'), dir('Skins'), file('ZoneManager.json')],
  '/oxide/data/Backups': [dir('**'), dir('2026-11-01'), file('index.json')],
  '/oxide/data/Backups/**': [file('note.txt')],
  '/oxide/data/Backups/2026-11-01': [file('Kits.json')],
  '/oxide/data/Clans': [file('*.json'), file('A?.json'), file('AB.json'), file('AC.json'), file('XYZ.json')],
  '/oxide/data/Skins': [dir('Bob*'), dir('Bob'), dir('Bobby'), dir('Team?'), dir('TeamA'), dir('TeamB')],
  '/oxide/data/Skins/Bob*': [file('skins.json')],
  '/oxide/data/Skins/Bob': [file('skins.json')],
  '/oxide/data/Skins/Bobby': [file('skins.json')],
  '/oxide/data/Skins/Team?': [file('skins.json')],
  '/oxide/data/Skins/TeamA': [file('skins.json')],
  '/oxide/data/Skins/TeamB': [file('skins.json')],
};

/** Файловый туннель агента: дерево в памяти; delete только записывается. */
function makeTunnel(tree) {
  const deleted = [];
  return {
    deleted,
    async queueRequest(_nodeId, operation, _uuid, path) {
      if (operation === 'list') {
        const entries = tree[path];
        if (!entries) return { success: false, error: `Failed to read dir ${path}: No such file or directory` };
        return {
          success: true,
          data: entries.map((entry) => ({
            name: entry.name,
            size: 10,
            isDirectory: entry.isDirectory,
            type: entry.isDirectory ? 'directory' : 'file',
            modified: '2026-11-01T00:00:00Z',
          })),
        };
      }
      if (operation === 'delete') {
        deleted.push(path);
        return { success: true };
      }
      return { success: false, error: `неизвестная операция ${operation}` };
    },
  };
}

function makeContext({ tunnel, servers, config }) {
  const stores = new Map();
  const routes = [];
  const collection = (name) => {
    if (!stores.has(name)) stores.set(name, []);
    const docs = stores.get(name);
    const matches = (doc, filter) => Object.entries(filter || {}).every(([key, value]) => doc[key] === value);
    return {
      async find(filter = {}, options = {}) {
        let out = docs.filter((doc) => matches(doc, filter));
        if (options.sort) {
          const [key, direction] = Object.entries(options.sort)[0];
          out = [...out].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (direction === -1 ? -1 : 1));
        }
        if (options.limit) out = out.slice(0, options.limit);
        return out.map((doc) => ({ ...doc }));
      },
      async findOne(filter) {
        const doc = docs.find((item) => matches(item, filter));
        return doc ? { ...doc } : null;
      },
      async insert(doc) {
        const withId = { _id: `doc${docs.length + 1}`, ...doc };
        docs.push(withId);
        return withId;
      },
      async update(filter, update) {
        let count = 0;
        for (const doc of docs) {
          if (!matches(doc, filter)) continue;
          Object.assign(doc, update.$set || {});
          count += 1;
        }
        return count;
      },
      async delete(filter) {
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i -= 1) if (matches(docs[i], filter)) docs.splice(i, 1);
        return before - docs.length;
      },
      async count(filter) {
        return docs.filter((doc) => matches(doc, filter)).length;
      },
    };
  };
  const ctx = {
    manifest: { name: 'rust-autowipe', version: '1.5.6' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    getConfig: (key) => (key in config ? config[key] : undefined),
    getStorage: async () => null,
    setStorage: async () => {},
    collection,
    db: {
      servers: {
        async findUnique({ where }) {
          return servers.find((server) => server.id === where.id) || null;
        },
      },
    },
    registerRoute: (route) => routes.push(route),
    scheduleTask: () => {},
    emit: () => {},
    fileTunnel: tunnel,
    getUserId: () => 'user_owner',
    hasPermission: () => true,
  };
  return { ctx, stores, routes };
}

function matchRoute(routes, method, path) {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.url.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params = {};
    const same = pattern.every((segment, index) => {
      if (segment.startsWith(':')) {
        params[segment.slice(1)] = decodeURIComponent(parts[index]);
        return true;
      }
      return segment === parts[index];
    });
    if (same) return { route, params };
  }
  return null;
}

const { default: plugin } = await import('../../rust-autowipe/backend/index.js');
const { executeProfileRun } = await import('../../rust-autowipe/backend/lib/wipe.js');
const { default: frontend } = await import('../../rust-autowipe/frontend/frontend.mjs');
const tab = frontend.tabs[0];

/** Песочница: настоящие роуты плагина на подменах туннеля, БД и REST панели. */
async function makeSandbox() {
  const server = {
    id: 'srv1',
    uuid: 'uuid-1',
    nodeId: 'node-1',
    name: 'Rust EU #1',
    status: 'stopped',
    ownerId: 'user_owner',
  };
  const tunnel = makeTunnel(TREE);
  const { ctx, stores, routes } = makeContext({
    tunnel,
    servers: [server],
    config: { apiKey: 'test-key', panelUrl: PANEL },
  });
  await plugin.onLoad(ctx);
  const requests = [];

  globalThis.fetch = async (url, options = {}) => {
    const raw = String(url);
    const method = options.method || 'GET';
    if (raw.startsWith(`${PLUGIN_API}/`)) {
      // Интерфейс → роуты плагина.
      const at = raw.indexOf('?');
      const path = raw.slice(PLUGIN_API.length, at < 0 ? undefined : at);
      const query = Object.fromEntries(new URLSearchParams(at < 0 ? '' : raw.slice(at + 1)));
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      requests.push({ method, path, body });
      const found = matchRoute(routes, method, path);
      if (!found) {
        return { ok: false, status: 404, json: async () => ({ success: false, error: `нет роута ${method} ${path}` }) };
      }
      const reply = {
        statusCode: 200,
        payload: undefined,
        status(code) {
          this.statusCode = code;
          return this;
        },
        send(payload) {
          this.payload = payload;
          return payload;
        },
      };
      const result = await found.route.handler(
        { method, url: raw, params: found.params, query, body, headers: {} },
        reply,
      );
      const payload = JSON.parse(JSON.stringify(reply.payload !== undefined ? reply.payload : result));
      return { ok: reply.statusCode < 400, status: reply.statusCode, json: async () => payload };
    }
    if (raw.startsWith(`${PANEL}/`)) {
      // Backend → REST панели: остановка, запуск, переменные карты.
      const answer = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
      if (raw.endsWith('/variables') && method === 'GET') {
        return answer({ success: true, data: [{ name: 'WORLD_SEED', value: '1' }, { name: 'WORLD_SIZE', value: '3000' }] });
      }
      if (raw.endsWith('/variables') && method === 'PATCH') return answer({ success: true });
      if (raw.endsWith('/stop')) {
        server.status = 'stopped';
        return answer({ success: true });
      }
      if (raw.endsWith('/start')) {
        server.status = 'running';
        return answer({ success: true });
      }
      return { ok: false, status: 404, text: async () => JSON.stringify({ success: false, error: 'нет в подмене' }) };
    }
    throw new Error(`подмена fetch: неожиданный адрес ${raw}`);
  };

  return { server, tunnel, ctx, stores, requests };
}

/** Какие цели интерфейс отправил при сохранении профиля. */
function sentTargets(sandbox) {
  const post = sandbox.requests.find((request) => request.method === 'POST' && /\/profiles$/.test(request.path));
  return post ? post.body?.targets : null;
}

// ── Действия в интерфейсе ─────────────────────────────────────────────────
async function mountTab() {
  const root = new DomNode('div');
  tab.component({ serverId: 'srv1' }).props.ref(root);
  await until(() => findButton(root, '+ Новый профиль'), 'вкладка загрузилась');
  return root;
}

async function openNewProfile(root, name) {
  click(findButton(root, '+ Новый профиль'), '«+ Новый профиль»');
  await until(() => findButton(root, 'Выбрать в файлах…'), 'редактор профиля');
  const field = find(
    root,
    (item) => item.nodeType === 1 && item.classList.contains('rw-field') && item.children[0]?.textContent === 'Название',
  );
  const input = field && find(field, (item) => item.tagName === 'INPUT');
  assert.ok(input, 'в редакторе нет поля «Название»');
  for (const handler of input.listeners.input || []) handler({ target: { value: name }, currentTarget: input });
}

function pickerList(root) {
  return byClass(root, 'rw-picker-list');
}

function pickerReady(root) {
  const list = pickerList(root);
  return Boolean(list) && !list.textContent.includes('Читаю каталог…');
}

function pickerCrumbs(root) {
  const crumbs = byClass(root, 'rw-crumbs');
  if (!crumbs) return [];
  return findAll(crumbs, (item) => item.tagName === 'BUTTON')
    .slice(1)
    .map((button) => button.textContent.trim());
}

async function pickerOpen(root) {
  click(findButton(root, 'Выбрать в файлах…'), '«Выбрать в файлах…»');
  await until(() => pickerReady(root), 'пикер открылся');
}

/** Пройти в пикере по каталогам от корня, кликая по их именам. */
async function pickerGo(root, segments) {
  const done = [];
  for (const segment of segments) {
    const list = pickerList(root);
    const button = list && find(list, (item) => item.tagName === 'BUTTON' && item.textContent.trim() === segment);
    click(button, `каталога «${segment}» в пикере`);
    done.push(segment);
    await until(
      () => pickerReady(root) && pickerCrumbs(root).join('/') === done.join('/'),
      `пикер открыл /${done.join('/')}`,
    );
  }
}

function pickerCheck(root, name) {
  const list = pickerList(root);
  const row = find(
    list,
    (item) =>
      item.nodeType === 1 &&
      item.classList.contains('rw-picker-row') &&
      Boolean(find(item, (cell) => cell.nodeType === 1 && cell.classList.contains('rw-pname') && cell.textContent.trim() === name)),
  );
  const box = row && find(row, (item) => item.tagName === 'INPUT' && item.getAttribute('type') === 'checkbox');
  assert.ok(box, `в пикере нет строки «${name}» с чекбоксом`);
  for (const handler of box.listeners.change || []) handler({ target: { checked: true }, currentTarget: box });
}

/**
 * Правка исполнителя F5 (находка L31-3): при добавлении папки пикер сначала
 * показывает окно с последствиями. Админ подтверждает его кнопкой «Добавить»,
 * дальше тест идёт как раньше.
 */
async function confirmFolderIfAsked(root) {
  await settle();
  const overlay = find(root, (item) => item.nodeType === 1 && item.classList.contains('rw-overlay'));
  if (!overlay || pickerList(root) || findButton(root, 'Сохранить')) return;
  const button = find(overlay, (item) => item.tagName === 'BUTTON' && item.textContent.trim() === 'Добавить');
  if (button) click(button, '«Добавить» в окне подтверждения');
}

async function backToEditor(root) {
  await confirmFolderIfAsked(root);
  await until(() => !pickerList(root) && findButton(root, 'Сохранить'), 'возврат в редактор');
}

async function pickerAddSelected(root) {
  const button = find(root, (item) => item.tagName === 'BUTTON' && /^Добавить выбранные/.test(item.textContent.trim()));
  click(button, '«Добавить выбранные»');
  await backToEditor(root);
}

async function saveProfile(root, sandbox) {
  click(findButton(root, 'Сохранить'), '«Сохранить»');
  // Ждём записи в коллекцию; тост проверяем только в сообщении об ошибке — он мог остаться от пикера.
  try {
    await until(() => (sandbox.stores.get('profiles') || []).length > 0, 'сохранение профиля', 200);
  } catch {
    throw new Error(`профиль не сохранён: ${byClass(root, 'rw-toast')?.textContent || 'без сообщения'}`);
  }
  await settle();
  const docs = sandbox.stores.get('profiles');
  assert.ok(docs.length === 1, `ожидался один сохранённый профиль, их ${docs.length}`);
  return JSON.parse(JSON.stringify(docs[0]));
}

/** Настоящий прогон вайпа по сохранённому профилю; удаление — только запись в подмене туннеля. */
async function runWipe(sandbox, profile) {
  const run = await executeProfileRun(sandbox.ctx, profile, { trigger: 'manual' });
  return { run, deleted: [...sandbox.tunnel.deleted] };
}

async function pickerAddInside(root) {
  click(findButton(root, 'Добавить маску «всё внутри»'), '«Добавить маску «всё внутри»»');
  await backToEditor(root);
}

// ── Тест ──────────────────────────────────────────────────────────────────
const CONTROL = '/oxide/data/ZoneManager.json';

async function checkInsideCase(special) {
  const sandbox = await makeSandbox();
  const root = await mountTab();
  await openNewProfile(root, `H17c ${special}`);

  // Контрольная цель без масок: доказывает, что цепочка дошла до удаления.
  await pickerOpen(root);
  await pickerGo(root, ['oxide', 'data']);
  pickerCheck(root, 'ZoneManager.json');
  await pickerAddSelected(root);

  // Заходим в каталог со * или ? в имени и добавляем «всё внутри».
  await pickerOpen(root);
  await pickerGo(root, ['oxide', 'data', 'Skins', special]);
  await pickerAddInside(root);

  const saved = await saveProfile(root, sandbox);
  const { run, deleted } = await runWipe(sandbox, saved);
  const chosen = `/oxide/data/Skins/${special}`;
  const insideChosen = (path) => path.startsWith(`${chosen}/`);
  const extra = deleted.filter((path) => path !== CONTROL && !insideChosen(path));

  console.log(`        интерфейс отправил targets: ${JSON.stringify(sentTargets(sandbox))}`);
  console.log(`        цели профиля (как сохранил backend): ${JSON.stringify(saved.targets)}`);
  console.log(`        прогон: ok=${run.ok}; delete к агенту: ${JSON.stringify(deleted)}`);
  assert.ok(deleted.includes(CONTROL), `прогон не дошёл до удаления (нет ${CONTROL}): ${JSON.stringify(run.errors)} — тест неисправен`);
  assert.ok(!extra.length, `«всё внутри» для ${chosen}, а удалено ещё ${extra.length} вне этого каталога: ${extra.join(', ')}`);
  if (saved.targets.length > 1) {
    assert.ok(deleted.some(insideChosen), `маска «всё внутри» для ${chosen} принята в профиль, но содержимое не удалено`);
  }
}

async function main() {
  console.log('H17c: «Добавить маску «всё внутри»» в каталоге со * или ? в имени');

  await test('H17c (*): «всё внутри» каталога «Bob*» — удаляется только его содержимое', () => checkInsideCase('Bob*'));
  await test('H17c (?): «всё внутри» каталога «Team?» — удаляется только его содержимое', () => checkInsideCase('Team?'));

  console.log(`\nИтог H17c: прошло ${passed}, упало ${failed}`);
}

main();
