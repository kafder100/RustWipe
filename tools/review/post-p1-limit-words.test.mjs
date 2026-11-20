/**
 * P1, R-9 (регрессия R1-5 второго круга): в причине отмены вайпа админ
 * видел внутреннее слово: «…(Кончился предел: 250 запросов list за один
 * прогон…)». Так же причина «панель не предоставила ctx.fileTunnel»
 * называла переменную из кода.
 *
 * Правильное поведение (правила 3.1: тексты без внутренностей): в причинах,
 * которые видит админ, — в истории, в предпросмотре, в выборе файлов, —
 * обычные слова: «250 чтений папок», без «list» и имён из кода.
 *
 * Всё на подменах песочницы: дерево в памяти, настоящие файлы не трогаются.
 *
 * Запуск: node tools/review/post-p1-limit-words.test.mjs
 */

import assert from 'node:assert/strict';

import { listDirectory } from '../../rust-autowipe/backend/lib/glob-walk.js';
import { createSandbox, test } from './sandbox.mjs';

/** Внутренние слова, которых не должно быть в тексте для админа. */
const INTERNAL = /\blist\b|ctx\.|fileTunnel|queueRequest/;

function bigTree() {
  const files = { '/RustDedicated': 1024 };
  for (let index = 1; index <= 260; index += 1) {
    files[`/oxide/data/Plugin${String(index).padStart(3, '0')}/data.json`] = '{}';
  }
  return { files };
}

test('R-9: вайп упёрся в предел чтений папок — в истории обычные слова, без «list»', async (t) => {
  const sb = createSandbox({ tree: bigTree() });
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*/*.json'], options: { warnChat: false } });
  const run = await sb.wipe(profile);
  await sb.idle();
  const reason = run.errors.join(' | ');
  t.note(`ok=${run.ok}; причина: ${reason}`);
  assert.equal(run.ok, false, 'предел кончился, а вайп прошёл');
  assert.match(reason, /250 чтений папок/);
  assert.doesNotMatch(reason, INTERNAL);
  const saved = sb.runs().find((item) => item.id === run.id) ?? sb.runs().at(-1);
  const shown = [...(saved?.errors ?? []), ...(saved?.steps ?? []).map((step) => String(step.detail ?? ''))].join(' | ');
  assert.doesNotMatch(shown, INTERNAL, `в записи истории: ${shown}`);
});

test('R-9: предпросмотр с тем же пределом — тоже без «list»', async (t) => {
  const sb = createSandbox({ tree: bigTree() });
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*/*.json'], options: { warnChat: false } });
  const preview = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const { truncated, limitHit } = preview.body.data;
  t.note(`truncated=${truncated}; limitHit=${JSON.stringify(limitHit)}`);
  assert.equal(truncated, true);
  assert.equal(limitHit?.kind, 'listings');
  assert.match(limitHit.detail, /250 чтений папок/);
  assert.doesNotMatch(limitHit.detail, INTERNAL);
});

test('R-9: панель не дала доступ к файлам — причина без имён из кода', async (t) => {
  const server = { nodeId: 'node1', uuid: 'uuid1' };
  const error = await listDirectory({}, server, '/oxide').then(
    () => null,
    (failure) => failure,
  );
  t.note(`listDirectory без туннеля: ${error?.message}`);
  assert.ok(error, 'без туннеля чтение папки должно падать');
  assert.match(error.message, /Файловый туннель недоступен/);
  assert.doesNotMatch(error.message, INTERNAL);

  const sb = createSandbox({ tree: bigTree() });
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/oxide/data/*'], options: { warnChat: false } });
  sb.ctx.fileTunnel = undefined;
  const run = await sb.wipe(profile);
  await sb.idle();
  const reason = run.errors.join(' | ');
  t.note(`вайп без туннеля: ok=${run.ok}; причина: ${reason}`);
  assert.equal(run.ok, false);
  assert.match(reason, /Файловый туннель недоступен/);
  assert.doesNotMatch(reason, INTERNAL);
});
