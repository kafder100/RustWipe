/**
 * Ревью RustWipe, гипотеза 8 (раздел 4.2), утверждение H8e.
 *
 * Что проверяем. Вкладка плагина видна только у серверов, чей шаблон совпадает
 * с namePattern 'rust' (без учёта регистра, по имени шаблона; frontend.mjs:2495).
 * Backend шаблон не проверяет: через API можно создать профиль, смотреть файлы
 * и запустить вайп на сервере с другим шаблоном (например, Minecraft).
 *
 * Как должно быть (ответ владельца на вопрос 16: «Да, отказывать»): backend
 * отказывает серверу без шаблона Rust по тому же правилу. Профиль не создаётся,
 * список файлов не отдаётся, вайп не идёт, файлы не удаляются.
 *
 * Запуск: node tools/review/h08e-non-rust-routes.test.mjs
 */

import assert from 'node:assert/strict';
import { createSandbox, defaultServer, test } from './sandbox.mjs';

const refused = (res) => res.status >= 400 && res.status < 500;

const MINECRAFT = Object.freeze({
  id: 'tpl_mc',
  name: 'Minecraft: Java Edition',
  variables: [
    { name: 'SERVER_JARFILE', description: 'Файл сервера', default: 'server.jar', required: true, input: 'text', rules: ['required', 'string'] },
  ],
});

const MINECRAFT_TREE = {
  files: {
    '/server.jar': 1048576,
    '/server.properties': 'motd=Minecraft\n',
    '/world/level.dat': 4096,
    '/world/region/r.0.0.mca': 65536,
    '/plugins/Essentials.jar': 8192,
  },
};

test('H8e: роуты плагина отказывают серверу с шаблоном не Rust', async (t) => {
  const sb = createSandbox({
    tree: MINECRAFT_TREE,
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
  t.note(`шаблон сервера: «${sb.panel.server('srv1').template.name}», совпадает с namePattern 'rust': ${/rust/i.test(sb.panel.server('srv1').template.name)}`);

  const created = await sb.call('owner', 'POST', '/servers/srv1/profiles', {
    body: { name: 'Мир', targets: ['/world/**'], schedule: { kind: 'weekly', weekday: 4, time: '05:00' } },
  });
  const files = await sb.call('owner', 'GET', '/servers/srv1/files', { query: { path: '/' } });
  // Профиль мог появиться раньше (старая версия, вызов API) — запуск тоже должен получить отказ.
  const seeded = await sb.addProfile({ name: 'Старый профиль', targets: ['/world/**'] });
  const run = await sb.call('owner', 'POST', `/servers/srv1/profiles/${seeded.id}/run`, { body: {} });
  await sb.idle();

  const removed = sb.tree.diff(before).removed;
  const power = sb.panel.calls
    .filter((call) => call.method === 'POST' && /^\/api\/servers\/srv1\/(stop|start)$/.test(call.path))
    .map((call) => call.path.split('/').pop());
  t.note(`создание профиля → ${created.status}, список файлов → ${files.status}, запуск → ${run.status}`);
  t.note(`удалено [${removed.join(', ')}], питание [${power.join(', ')}]`);

  assert.deepEqual(
    {
      createRefused: refused(created),
      filesRefused: refused(files),
      runRefused: refused(run),
      removed,
      power,
    },
    { createRefused: true, filesRefused: true, runRefused: true, removed: [], power: [] },
    'backend принял сервер без шаблона Rust',
  );
});
