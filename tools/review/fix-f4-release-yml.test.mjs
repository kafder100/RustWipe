/**
 * Исправление F4 для H18b, H18c, H18d и L34-11 (часть release.yml):
 * выпуск публикуется только после проверок, только из коммита ветки main,
 * из пакета, который совпадает с исходниками, и без замены уже опубликованного.
 *
 * Проверяется разбором .github/workflows/release.yml (тот же мини-разборщик
 * YAML, что в тестах h18b–h19b): команды шагов run без комментариев и echo.
 * Ничего не запускается. Запуск: node tools/review/fix-f4-release-yml.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

// ── Мини-парсер YAML (подмножество, которого хватает workflow GitHub) ───────
function parseYaml(text) {
  const lines = text.split(/\r?\n/).map((raw) => ({ raw, indent: raw.match(/^ */)[0].length, text: raw.trim() }));
  let i = 0;
  const blank = (l) => !l.text || l.text.startsWith('#');
  const skip = () => {
    while (i < lines.length && blank(lines[i])) i += 1;
  };
  const uncomment = (s) => {
    let quote = null;
    for (let k = 0; k < s.length; k += 1) {
      const c = s[k];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
    }
    return s;
  };
  const scalar = (value) => {
    const s = uncomment(value).trim();
    if (s === '') return null;
    if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1);
    if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map(scalar).filter((x) => x !== null);
    if (s.startsWith('{') && s.endsWith('}')) {
      const obj = {};
      for (const part of s.slice(1, -1).split(',')) {
        const m = part.match(/^\s*([^:]+):\s*(.*)$/);
        if (m) obj[scalar(m[1])] = scalar(m[2]);
      }
      return obj;
    }
    return s;
  };
  const KEY = /^("[^"]*"|'[^']*'|[^\s"'#-][^:]*?|-[^\s:][^:]*?):(?:\s+(.*))?$/;
  const block = (parentIndent, style) => {
    const out = [];
    let indent = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.text === '') {
        out.push('');
        i += 1;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (indent === null) indent = l.indent;
      out.push(l.raw.slice(indent));
      i += 1;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style.startsWith('>') ? out.join(' ') : out.join('\n');
  };
  const node = (minIndent) => {
    skip();
    if (i >= lines.length || lines[i].indent < minIndent) return null;
    const l = lines[i];
    return l.text === '-' || l.text.startsWith('- ') ? seq(l.indent) : map(l.indent);
  };
  const map = (indent) => {
    const obj = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (l.indent !== indent || l.text === '-' || l.text.startsWith('- ')) break;
      const m = l.text.match(KEY);
      if (!m) break;
      const key = scalar(m[1]);
      const rest = uncomment(m[2] ?? '').trim();
      i += 1;
      if (/^[|>][-+]?$/.test(rest)) obj[key] = block(indent, rest);
      else if (rest === '') {
        skip();
        const next = lines[i];
        const nested = next && (next.indent > indent || (next.indent === indent && /^- |^-$/.test(next.text)));
        obj[key] = nested ? node(next.indent) : null;
      } else obj[key] = scalar(rest);
    }
    return obj;
  };
  const seq = (indent) => {
    const arr = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) break;
      const content = l.text.slice(1).trimStart();
      if (content === '') {
        i += 1;
        arr.push(node(indent + 1));
      } else if (KEY.test(content) && !/^[[{'"]/.test(content)) {
        const itemIndent = l.indent + (l.text.length - content.length);
        lines[i] = { raw: ' '.repeat(itemIndent) + content, indent: itemIndent, text: content };
        arr.push(map(itemIndent));
      } else {
        i += 1;
        arr.push(scalar(content));
      }
    }
    return arr;
  };
  const root = node(0);
  skip();
  if (i < lines.length) throw new Error(`YAML не разобран до конца: строка ${i + 1} «${lines[i].text}»`);
  return root;
}

/** Команды шага run: без комментариев shell и без echo/printf с их текстом. */
function commands(script) {
  const out = [];
  for (const raw of String(script || '').replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    let line = raw.replace(/(^|\s)#.*$/, '$1');
    line = line.replace(/(^|[;&|{(]|\b(?:then|else|do)\b)\s*(?:echo|printf)\b(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^;&|}"'])*/g, '$1');
    line = line.replace(/["']/g, '').trim();
    if (line) out.push(line);
  }
  return out;
}

const release = parseYaml(fs.readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8'));
const jobs = release.jobs || {};
const isPublish = (step) => commands(step.run).some((c) => /\bgh\s+release\s+(create|upload|edit)\b/.test(c));
/** Задача и номер шага публикации. */
function publishStep() {
  for (const [id, job] of Object.entries(jobs)) {
    const index = (job.steps || []).findIndex(isPublish);
    if (index >= 0) return { id, job, index, step: job.steps[index] };
  }
  return null;
}
/** Команды шагов той же задачи до публикации. */
function before({ job, index }) {
  return job.steps.slice(0, index).flatMap((step) => commands(step.run));
}

test('выпуск ждёт проверок CI (задача ci вызывает ci.yml, publish — после неё)', () => {
  const found = publishStep();
  assert.ok(found, 'в release.yml нет шага публикации');
  const needs = [].concat(found.job.needs || []);
  const ciJobs = Object.entries(jobs).filter(([, job]) => /^\.\/\.github\/workflows\/ci\.ya?ml$/.test(String(job.uses || '')));
  assert.ok(ciJobs.length, 'в release.yml нет задачи с uses: ./.github/workflows/ci.yml');
  assert.ok(ciJobs.some(([id]) => needs.includes(id)), `задача «${found.id}» не ждёт задачу с ci.yml (needs: ${needs.join(', ') || '—'})`);
  const ci = parseYaml(fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8'));
  assert.ok(ci.on && Object.prototype.hasOwnProperty.call(ci.on, 'workflow_call'), 'ci.yml нельзя вызвать: нет on.workflow_call');
});

test('метка должна стоять на коммите из main', () => {
  const found = publishStep();
  const checkout = found.job.steps.find((step) => String(step.uses || '').startsWith('actions/checkout@'));
  assert.ok(checkout, 'в задаче публикации нет checkout');
  assert.equal(String(checkout.with?.['fetch-depth']), '0', 'checkout без fetch-depth: 0 — истории main нет');
  assert.ok(
    before(found).some((c) => /\bgit\s+merge-base\s+--is-ancestor\b/.test(c) && /\borigin\/main\b/.test(c)),
    'до публикации нет проверки git merge-base --is-ancestor … origin/main',
  );
});

test('пакет пересобирается, и dist/ с index.json должны совпасть с коммитом', () => {
  const found = publishStep();
  const cmds = before(found);
  assert.ok(cmds.some((c) => /\btools\/pack\.py\b/.test(c) && !/--allow-repack\b/.test(c)), 'нет пересборки pack.py без --allow-repack');
  assert.ok(
    cmds.some((c) => /\bgit\s+diff\s+--exit-code\b/.test(c) && /\bdist\b/.test(c) && /\bindex\.json\b/.test(c)),
    'после пересборки нет git diff --exit-code -- dist index.json',
  );
});

test('уже опубликованный файл сверяется по sha256, а не заменяется; новая метка не создаётся', () => {
  const { step } = publishStep();
  const cmds = commands(step.run);
  assert.ok(cmds.some((c) => /\bgh\s+release\s+download\b/.test(c)), 'опубликованный файл не скачивается для сверки');
  assert.ok(cmds.some((c) => /\bsha256sum\b/.test(c)), 'нет сверки sha256');
  assert.ok(!cmds.some((c) => /--clobber\b/.test(c)), 'есть --clobber');
  const create = cmds.find((c) => /\bgh\s+release\s+create\b/.test(c));
  assert.ok(create && /--verify-tag\b/.test(create), 'gh release create без --verify-tag может создать метку сам');
});

test('права: по умолчанию чтение, запись contents — только у задачи публикации', () => {
  assert.equal(release.permissions?.contents, 'read', `права workflow: ${JSON.stringify(release.permissions)}`);
  const found = publishStep();
  for (const [id, job] of Object.entries(jobs)) {
    const perms = job.permissions ?? release.permissions;
    const writes = Object.entries(perms || {}).filter(([, value]) => value === 'write').map(([scope]) => scope);
    if (id === found.id) assert.deepEqual(writes, ['contents'], `задача «${id}»: запись — ${writes.join(', ') || 'нет'}`);
    else assert.deepEqual(writes, [], `задача «${id}» без публикации, а запись — ${writes.join(', ')}`);
  }
});
