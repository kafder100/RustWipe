/**
 * Ревью RustWipe, гипотеза 2 (раздел 4.2 правил), утверждение H2d.
 *
 * Что проверяем: у маски с «**» обход молча останавливается на глубине 8
 * от корня сервера. Файлы глубже не попадают ни в предпросмотр, ни в вайп,
 * а отметки «список обрезан» нет нигде: предпросмотр не предупреждает,
 * прогон записан как успешный без предупреждений.
 *
 * Правильное поведение (ответ владельца №3 и текст вопроса «по умолчанию»:
 * при сомнении — в истории причина; README: предпросмотр показывает, что будет
 * удалено): упор в предел глубины виден — в предпросмотре отметка «обрезан»,
 * в истории прогона предупреждение или ошибка.
 *
 * Сценарий: маска «все json в /oxide/data на любой глубине»; один файл лежит
 * на глубине 10. Боевой вайп — только на подменах песочницы.
 *
 * Запуск: node tools/review/h02d-depth-limit-silent.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, test } from './sandbox.mjs';

const DEEP_FILE = '/oxide/data/Deep/1/2/3/4/5/6/x.json';

test('H2d: упор в предел глубины у «**» должен быть виден в предпросмотре и в истории', async (t) => {
  const sb = createSandbox({
    tree: {
      files: {
        '/RustDedicated': 1024,
        '/oxide/data/a.json': '{}',
        '/oxide/data/Deep/b.json': '{}',
        [DEEP_FILE]: '{}',
      },
    },
  });
  await sb.load();
  const profile = await sb.addProfile({ targets: ['/oxide/data/**/*.json'] });

  const preview = await sb.call('owner', 'POST', `/servers/srv1/profiles/${profile.id}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const shown = preview.body.data.paths;
  t.note(`предпросмотр: ${shown.join(', ')}; truncated=${preview.body.data.truncated}`);

  const run = await sb.wipe(profile);
  await sb.idle();
  t.note(`прогон: ok=${run.ok}; удалено: ${run.deleted.join(', ')}; предупреждения: ${run.warnings.join(' | ') || 'нет'}; ошибки: ${run.errors.join(' | ') || 'нет'}`);
  t.note(`${DEEP_FILE} после вайпа: ${sb.tree.exists(DEEP_FILE) ? 'на месте' : 'удалён'}`);

  const previewMarked = preview.body.data.truncated === true || shown.includes(DEEP_FILE);
  const historyMarked = run.warnings.length > 0 || run.errors.length > 0 || run.deleted.includes(DEEP_FILE);
  assert.ok(previewMarked, 'предпросмотр не показал файл на глубине 10 и не отметил, что список обрезан');
  assert.ok(historyMarked, 'в истории прогона нет ни предупреждения, ни ошибки про предел глубины');
});
