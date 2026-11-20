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
 *
 * Запасные копии сохранения (.sav.1, .sav.2 … — их число задаёт
 * server.savebackupcount) относятся к старому миру и удаляются вместе с ним.
 * Маски «.sav.?» и «.sav.??» берут только номера 1–99: ручная копия вроде
 * «.sav.bak» остаётся. У баз .db удаляются и их файлы -wal и -shm.
 */

/** Сохранение мира вместе с запасными копиями. */
const WORLD_SAVE = [
  '/server/*/proceduralmap.*.map',
  '/server/*/proceduralmap.*.sav',
  '/server/*/proceduralmap.*.sav.?',
  '/server/*/proceduralmap.*.sav.??',
];

export const PRESETS = [
  {
    id: 'rust-map',
    label: 'Карта (map wipe)',
    description:
      'Удаляет сохранение мира вместе с его запасными копиями. Блюпринты и данные игроков остаются. Подходит для еженедельного вайпа карты.',
    targets: [...WORLD_SAVE],
    excludes: [],
  },
  {
    id: 'rust-map-bp',
    label: 'Карта + блюпринты',
    description:
      'Вайп мира и чертежей. Самый частый вариант для месячного вайпа: карта новая, прогресс игроков сброшен.',
    targets: [
      ...WORLD_SAVE,
      '/server/*/player.blueprints.*.db',
      '/server/*/player.blueprints.*.db-wal',
      '/server/*/player.blueprints.*.db-shm',
    ],
    excludes: [],
  },
  {
    id: 'rust-players',
    label: 'Данные игроков',
    description:
      'Удаляет файлы игроков (блюпринты, смерти, состояния), не трогая карту. Используйте вместе с вайпом карты.',
    targets: ['/server/*/player.*.db', '/server/*/player.*.db-wal', '/server/*/player.*.db-shm'],
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
