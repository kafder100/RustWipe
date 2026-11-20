#!/usr/bin/env node
/**
 * Запуск тестов ревью: находит tools/review/*.test.mjs и запускает каждый
 * файл в отдельном процессе node, по очереди (не параллельно), затем
 * печатает итог по файлам. Код выхода 1, если провалился хоть один прогон.
 *
 *   node tools/review/run.mjs                       — все *.test.mjs
 *   node tools/review/run.mjs --only schedule       — только файлы с подстрокой в имени
 *   node tools/review/run.mjs --tz UTC,Europe/Moscow,America/New_York
 *                                                   — каждый выбранный файл под каждым поясом
 *   node tools/review/run.mjs --selftest            — добавить самопроверку песочницы
 *   node tools/review/run.mjs --list                — только показать, что будет запущено
 *   --timeout <мс>  — предел настоящего времени на один прогон (по умолчанию 120000);
 *   --dir <папка>   — искать тесты в другой папке (нужно самопроверке).
 *
 * Пояс передаётся дочернему процессу через env из node: TZ со слешем,
 * заданный в Git Bash, по дороге теряется. Сам тест сверяет, что пояс
 * применился (иначе FAIL «часовой пояс … не применился»).
 */

import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_DIR, runNode } from './sandbox.mjs';

function fail(message) {
  process.stderr.write(`run.mjs: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { only: [], tz: [], selftest: false, list: false, timeoutMs: 120000, dir: REVIEW_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) fail(`после ${arg} нужно значение`);
      index += 1;
      return next;
    };
    if (arg === '--only') options.only.push(value());
    else if (arg === '--tz') options.tz.push(...value().split(',').map((item) => item.trim()).filter(Boolean));
    else if (arg === '--selftest') options.selftest = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--timeout') options.timeoutMs = Number(value());
    else if (arg === '--dir') options.dir = path.resolve(value());
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'node tools/review/run.mjs [--only <подстрока>] [--tz <пояс,пояс>] [--selftest] [--list] [--timeout <мс>] [--dir <папка>]\n',
      );
      process.exit(0);
    } else fail(`неизвестный флаг ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) fail('--timeout — положительное число мс');
  for (const zone of options.tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      fail(`неизвестный часовой пояс «${zone}»`);
    }
  }
  return options;
}

function findFiles(options) {
  let names;
  try {
    names = fs.readdirSync(options.dir);
  } catch (error) {
    fail(`не читается папка с тестами: ${error.message}`);
  }
  const files = names.filter((name) => name.endsWith('.test.mjs'));
  if (options.selftest && options.dir === REVIEW_DIR && names.includes('sandbox.selftest.mjs')) {
    files.push('sandbox.selftest.mjs');
  }
  return files
    .filter((name) => !options.only.length || options.only.some((part) => name.includes(part)))
    .sort((a, b) => a.localeCompare(b));
}

function display(file) {
  return path.relative(process.cwd(), file) || file;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} с`;
}

const options = parseArgs(process.argv.slice(2));
const files = findFiles(options);
const zones = options.tz.length ? options.tz : [undefined];

if (!files.length) {
  process.stdout.write(`Файлов *.test.mjs не найдено (папка ${display(options.dir)}${options.only.length ? `, фильтр ${options.only.join(', ')}` : ''}).\n`);
  process.exit(0);
}

if (options.list) {
  for (const file of files) {
    for (const zone of zones) process.stdout.write(`${display(path.join(options.dir, file))}${zone ? `  [TZ=${zone}]` : ''}\n`);
  }
  process.exit(0);
}

const results = [];
for (const file of files) {
  const fullPath = path.join(options.dir, file);
  for (const zone of zones) {
    process.stdout.write(`\n═══ ${display(fullPath)}${zone ? ` · TZ=${zone}` : ''} ═══\n`);
    const result = await runNode({ file: fullPath, tz: zone, echo: true, timeoutMs: options.timeoutMs });
    const summary = /Итог: (\d+) PASS, (\d+) FAIL/.exec(result.stdout);
    const ok = result.code === 0 && !result.timedOut;
    results.push({ file: fullPath, zone, ok, result, summary });
    if (result.timedOut) process.stdout.write(`run.mjs: прогон снят по пределу ${options.timeoutMs} мс\n`);
  }
}

process.stdout.write('\nИтог по файлам:\n');
for (const { file, zone, ok, result, summary } of results) {
  const counts = summary ? `${summary[1]} PASS, ${summary[2]} FAIL` : 'без строки «Итог»';
  const reason = result.timedOut ? ', снят по таймауту' : result.code !== 0 ? `, код ${result.code ?? result.signal}` : '';
  process.stdout.write(
    `  ${ok ? 'OK  ' : 'FAIL'}  ${display(file)}${zone ? `  [TZ=${zone}]` : ''}  ${counts}${reason}  (${seconds(result.durationMs)})\n`,
  );
}
const failedRuns = results.filter((item) => !item.ok).length;
process.stdout.write(`Файлов: ${files.length}, прогонов: ${results.length}, провалено: ${failedRuns}\n`);
process.exitCode = failedRuns ? 1 : 0;
