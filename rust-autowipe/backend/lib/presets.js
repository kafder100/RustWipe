/**
 * Готовые наборы путей для вайпа Rust.
 *
 * Раскладка каталога сервера (Rust Dedicated Server):
 *   /server/<identity>/proceduralmap.<...>.map|sav   — сохранение мира
 *   /server/<identity>/player.blueprints.*.db        — чертежи игроков
 *   /server/<identity>/player.deaths.*.db            — смерти/статистика
 *   /server/<identity>/sv.db(+ -wal/-shm)            — общая база сервера
 *   /server/<identity>/cfg/server.cfg                — настройки (не удаляем!)
 *   /oxide/data, /oxide/logs, /carbon/data           — данные модов
 *
 * Точные имена файлов зависят от версии Rust (protocol-суффикс), поэтому
 * везде используются маски, а не фиксированные имена.
 */

export const PRESETS = [
  {
    id: 'rust-map',
    label: 'Карта (map wipe)',
    description:
      'Удаляет сохранение мира. Блюпринты и данные игроков остаются. Подходит для еженедельного вайпа карты.',
    targets: ['/server/*/proceduralmap.*.map', '/server/*/proceduralmap.*.sav'],
    excludes: [],
  },
  {
    id: 'rust-map-bp',
    label: 'Карта + блюпринты',
    description:
      'Вайп мира и чертежей. Самый частый вариант для месячного вайпа: карта новая, прогресс игроков сброшен.',
    targets: [
      '/server/*/proceduralmap.*.map',
      '/server/*/proceduralmap.*.sav',
      '/server/*/player.blueprints.*.db',
    ],
    excludes: [],
  },
  {
    id: 'rust-players',
    label: 'Данные игроков',
    description:
      'Удаляет файлы игроков (блюпринты, смерти, состояния), не трогая карту. Используйте вместе с вайпом карты.',
    targets: ['/server/*/player.*.db'],
    excludes: ['/server/*/cfg'],
  },
  {
    id: 'rust-full',
    label: 'Полный вайп (карта + игроки + sv.db)',
    description:
      'Удаляет всё содержимое папок server/<identity>, кроме cfg/server.cfg. Сервер создаст новый мир, новую базу и новых игроков.',
    targets: ['/server/*'],
    excludes: ['/server/*/cfg'],
  },
  {
    id: 'oxide-data',
    label: 'Данные Oxide',
    description:
      'Очищает oxide/data (данные плагинов Oxide). Осторожно: настройки плагинов в oxide/config остаются, а данные — нет.',
    targets: ['/oxide/data/*'],
    excludes: [],
  },
  {
    id: 'carbon-data',
    label: 'Данные Carbon',
    description: 'Очищает carbon/data — аналог oxide/data для Carbon.',
    targets: ['/carbon/data/*'],
    excludes: [],
  },
];

export function findPreset(id) {
  return PRESETS.find((preset) => preset.id === id) || null;
}
