/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8f.
 *
 * Что проверяем. Плановый вайп (тик раз в минуту, index.js:553-643) не смотрит
 * шаблон сервера. Если у сервера с шаблоном не Rust есть профиль (создан через
 * API или раньше, когда шаблон был другим), вайп по расписанию идёт: сервер
 * останавливается, файлы удаляются.
 *
 * Как должно быть (ответ владельца на вопрос 16: «Да, отказывать»): backend
 * отказывает серверу без шаблона Rust — и в роутах, и в плановом вайпе.
 * Сервер не останавливается, файлы на месте.
 *
 * Запуск: node tools/review/h08f-non-rust-schedule.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const MINECRAFT = Object.freeze({
  id: 'tpl_mc',
  name: 'Minecraft: Java Edition',
  variables: [
    { name: 'SERVER_JARFILE', description: 'Файл сервера', default: 'server.jar', required: true, input: 'text', rules: ['required', 'string'] },
  ],
});

test('H8f: плановый вайп не идёт на сервере с шаблоном не Rust', async (t) => {
  const sb = createSandbox({
    tree: {
      files: {
        '/server.jar': 1048576,
        '/world/level.dat': 4096,
        '/world/region/r.0.0.mca': 65536,
      },
    },
    servers: [
      defaultServer({
        name: 'Minecraft #1',
        templateId: MINECRAFT.id,
        template: MINECRAFT,
        environment: { SERVER_JARFILE: 'server.jar' },
      }),
    ],
  });
  await sb.load();
  const before = sb.tree.snapshot();
  await sb.addProfile({
    name: 'Профиль на не-Rust сервере',
    targets: ['/world/region/*'],
    nextRunAt: new Date(Date.now() - 60000).toISOString(),
  });

  await sb.tick();
  await sb.idle();

  const removed = sb.tree.diff(before).removed;
  const power = sb.panel.calls
    .filter((call) => call.method === 'POST' && /^\/api\/servers\/srv1\/(stop|start)$/.test(call.path))
    .map((call) => call.path.split('/').pop());
  t.note(`тик: прогонов в истории ${sb.runs().length}, удалено [${removed.join(', ')}], питание [${power.join(', ')}]`);

  assert.deepEqual({ removed, power }, { removed: [], power: [] }, 'плановый вайп прошёл на сервере без шаблона Rust');
});
