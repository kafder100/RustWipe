/**
 * Исправление F4 для L34-7: CI гоняет тесты на Node 22 (на нём работает
 * backend Catalyst v1.89.2) и в нескольких часовых поясах, плюс тесты ревью.
 *
 * Проверяется разбором .github/workflows/ci.yml (тот же мини-разборщик YAML,
 * что в тестах h18b–h19b). Ничего не запускается.
 * Запуск: node tools/review/fix-f4-ci-matrix.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from './sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');

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

const ci = parseYaml(fs.readFileSync(CI, 'utf8'));
const jobs = Object.entries(ci.jobs || {});
const list = (value) => [].concat(value ?? []).map(String);
/** Задача, которая запускает команду (по тексту шагов run). */
const jobRunning = (command) => jobs.find(([, job]) => (job.steps || []).some((step) => String(step.run || '').includes(command)));
/** Значение выражения ${{ matrix.<имя> }} или null. */
const matrixRef = (value) => /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(String(value ?? '').trim())?.[1] ?? null;

test('tools/test.mjs идёт на Node 22 (версия панели)', () => {
  const found = jobRunning('node tools/test.mjs');
  assert.ok(found, 'в ci.yml нет шага node tools/test.mjs');
  const [id, job] = found;
  const setup = (job.steps || []).find((step) => String(step.uses || '').startsWith('actions/setup-node@'));
  assert.ok(setup, `в задаче «${id}» нет actions/setup-node`);
  const version = String(setup.with?.['node-version'] ?? '');
  const key = matrixRef(version);
  const versions = key ? list(job.strategy?.matrix?.[key]) : [version];
  assert.ok(versions.includes('22'), `Node в задаче «${id}»: ${versions.join(', ') || 'не задан'}`);
});

test('tools/test.mjs идёт в нескольких часовых поясах, а не только в UTC', () => {
  const [id, job] = jobRunning('node tools/test.mjs') || [];
  assert.ok(job, 'в ci.yml нет шага node tools/test.mjs');
  const key = matrixRef(job.env?.TZ);
  assert.ok(key, `в задаче «${id}» TZ не берётся из матрицы: ${job.env?.TZ ?? 'не задан'}`);
  const zones = list(job.strategy?.matrix?.[key]);
  for (const zone of ['UTC', 'Europe/Moscow', 'America/New_York']) {
    assert.ok(zones.includes(zone), `в матрице поясов нет ${zone}: ${zones.join(', ')}`);
  }
  assert.equal(String(job.strategy?.['fail-fast']), 'false', 'fail-fast не выключен: один упавший пояс снимет остальные');
});

test('в CI есть шаг с тестами ревью (node tools/review/run.mjs)', () => {
  assert.ok(jobRunning('node tools/review/run.mjs'), 'в ci.yml нет шага node tools/review/run.mjs');
});
