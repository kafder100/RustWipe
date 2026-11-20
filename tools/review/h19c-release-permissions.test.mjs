/**
 * Ревью RustWipe, гипотеза 19 (раздел 4.2), утверждение H19c:
 * выпуск (release.yml) идёт с правом contents: write — подозрение, что права
 * шире нужного.
 *
 * Правильное поведение (правила ревью, раздел 3.4 «минимальные права»): запись
 * есть только у задачи, которая публикует выпуск, и только contents (без неё
 * gh release create/upload не работает); write-all и другие права на запись — нет.
 *
 * Проверяется разбором YAML. Ничего не запускается.
 * Запуск: node tools/review/h19c-release-permissions.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

// ── Мини-набор тестов: незавершённый тест считается проваленным ─────────────
const tests = [];
const pending = new Set();
let passed = 0;
let failed = 0;
let reported = false;
function test(name, fn) {
  tests.push({ name, fn });
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}
process.on('beforeExit', () => {
  if (reported) return;
  reported = true;
  for (const name of pending) {
    failed += 1;
    console.log(`  FAIL  ${name}: тест не завершился`);
  }
  console.log(`Итог: ${passed} прошло, ${failed} провалено`);
  if (failed) process.exitCode = 1;
});
async function runAll() {
  for (const t of tests) pending.add(t.name);
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok    ${t.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${t.name}\n        ${String(error.message).split('\n').join('\n        ')}`);
    } finally {
      pending.delete(t.name);
    }
  }
}

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
const isPublish = (step) =>
  commands(step.run).some((c) => /\bgh\s+release\s+(create|upload|edit)\b/.test(c)) ||
  /action-gh-release|create-release|upload-release-asset|release-action/.test(String(step.uses || ''));

function load(file) {
  return parseYaml(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'));
}
function workflowCommands(wf) {
  const out = [];
  for (const job of Object.values(wf.jobs || {})) for (const step of job.steps || []) out.push(...commands(step.run));
  return out;
}
/** Все команды, которые гарантированно выполнены до каждого шага публикации. */
function commandsBeforePublish(wf, ciWf) {
  const jobs = wf.jobs || {};
  const result = [];
  const ciName = ciWf.name || 'ci';
  const runs = wf.on && typeof wf.on === 'object' ? wf.on.workflow_run : null;
  const afterCi = runs && [].concat(runs.workflows || []).includes(ciName);
  const jobAll = (id, seen) => {
    if (seen.has(id) || !jobs[id]) return [];
    seen.add(id);
    const job = jobs[id];
    const out = [];
    for (const dep of [].concat(job.needs || [])) out.push(...jobAll(dep, seen));
    if (/^\.\/\.github\/workflows\/ci\.ya?ml$/.test(String(job.uses || ''))) out.push(...workflowCommands(ciWf));
    for (const step of job.steps || []) out.push(...commands(step.run));
    return out;
  };
  for (const [id, job] of Object.entries(jobs)) {
    (job.steps || []).forEach((step, k) => {
      if (!isPublish(step)) return;
      const before = afterCi ? workflowCommands(ciWf) : [];
      const seen = new Set([id]);
      for (const dep of [].concat(job.needs || [])) before.push(...jobAll(dep, seen));
      for (const prev of job.steps.slice(0, k)) before.push(...commands(prev.run));
      result.push({ job: id, step: step.name || `шаг ${k + 1}`, before });
    });
  }
  return result;
}

/** Права задачи: свои, иначе из workflow; undefined — не заданы вовсе. */
function jobPermissions(wf, job) {
  if (job && Object.prototype.hasOwnProperty.call(job, 'permissions')) return job.permissions ?? {};
  if (Object.prototype.hasOwnProperty.call(wf, 'permissions')) return wf.permissions ?? {};
  return undefined;
}
/** Области с правом записи. */
function writeScopes(perms) {
  if (perms === 'write-all') return ['все (write-all)'];
  if (perms === 'read-all' || !perms || typeof perms !== 'object') return [];
  return Object.entries(perms).filter(([, value]) => value === 'write').map(([scope]) => scope);
}

const release = load('release.yml');

test('release.yml: запись — только contents и только у задачи с публикацией', () => {
  const problems = [];
  const jobs = Object.entries(release.jobs || {});
  check(jobs.length > 0, 'в release.yml нет задач');
  for (const [id, job] of jobs) {
    const perms = jobPermissions(release, job);
    if (perms === undefined) {
      problems.push(`задача «${id}»: права не заданы — берутся из настроек репозитория`);
      continue;
    }
    const writes = writeScopes(perms);
    const extra = writes.filter((scope) => scope !== 'contents');
    if (extra.length) problems.push(`задача «${id}»: лишняя запись — ${extra.join(', ')}`);
    const publishes = (job.steps || []).some(isPublish);
    if (writes.includes('contents') && !publishes) problems.push(`задача «${id}»: contents: write без публикации`);
    console.log(`  инфо  задача «${id}»: запись — ${writes.join(', ') || 'нет'}; публикует — ${publishes ? 'да' : 'нет'}`);
  }
  check(problems.length === 0, problems.join('\n'));
});

runAll();
