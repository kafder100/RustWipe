# Rust AutoWipe

Плагин автовайпов для игры **Rust** на панели **[Catalyst](https://catalystctl.com/)** (catalystctl):
расписание вайпов, выбор каталогов и файлов для удаления, остановка/запуск сервера,
история прогонов.

Плагин написан под [систему плагинов Catalyst](https://docs.catalystctl.com/api/plugins/):
backend — обычный ESM без зависимостей (роуты, `scheduleTask`, файловый туннель,
коллекции), frontend — самодостаточный `frontend.mjs` без импортов.

## Возможности

| Возможность | Детали |
|---|---|
| **Расписание** | еженедельно · «первый/последний N-й день недели месяца» (под Force Wipe Facepunch) · день месяца · каждые N дней. Время — в часовом поясе панели |
| **Выбор файлов и каталогов** | файловый пикер по реальному дереву сервера, маски `*` / `?` / `**`, отдельный список исключений |
| **Безопасность вайпа** | предпросмотр «что будет удалено», dry-run, авто-подъём сервера при ошибке после остановки |
| **Rust-пресеты** | карта · карта + блюпринты · данные игроков · полный вайп (с сохранением `cfg/server.cfg`) · данные Oxide/Carbon |
| **Порядок** | остановка → удаление → запуск (через REST API панели), опциональные команды в консоль после старта |
| **История** | шаги, ошибки, предупреждения, количество удалённых путей |
| **Права** | `rust-autowipe.view` / `.manage` / `.run` для ролей панели |

## Быстрый старт

1. Скопировать плагин в панель:

   ```bash
   docker cp ./rust-autowipe catalyst-backend:/var/lib/catalyst/plugins/rust-autowipe
   docker compose -f /opt/catalyst/catalyst-docker/docker-compose.yml restart backend
   ```

   Либо установить `dist/rust-autowipe-1.0.0.catpkg.zip` через маркетплейс
   (см. [руководство](docs/RUST-AUTOWIPE-RU.md#4-установка)).

2. **Admin → Extensions → Plugins → Rust AutoWipe → Enable** (принять дисклеймер).

3. **Settings**: вставить `apiKey` — API-ключ панели с правами `server.read`,
   `server.start`, `server.stop` (и `console.write`, если нужны команды после запуска).

4. Вкладка **Rust AutoWipe** → создать профиль → выбрать сервер, расписание и пути →
   **«Что будет удалено»** → прогнать в dry-run → запустить.

Подробно: [docs/RUST-AUTOWIPE-RU.md](docs/RUST-AUTOWIPE-RU.md).

## Структура репозитория

```
rust-autowipe/            каталог плагина (имя = name в plugin.json)
  plugin.json             манифест: права, конфиг, события
  backend/                роуты, планировщик, fileTunnel, оркестрация вайпа
  frontend/frontend.mjs   self-contained UI (без React-хуков и импортов)
docs/RUST-AUTOWIPE-RU.md  полное руководство (установка, настройка, диагностика)
tools/test.mjs            тесты backend-логики (23 проверки)
tools/ui-smoke.mjs        дымовой тест UI на DOM-шиме
tools/pack.py             сборка .catpkg.zip + sha256 + index.json
tools/push_to_github.mjs  публикация репозитория через GitHub REST API
dist/                     собранный пакет и индекс маркетплейса
```

## Разработка

```bash
node tools/test.mjs                 # логика: расписание, маски, прогон вайпа
node tools/ui-smoke.mjs             # рендер UI без браузера
python tools/pack.py --base-url https://cdn.example.com/plugins
```

Проверка кода в панели:

```bash
curl -X POST https://panel.example.com/api/plugins/rust-autowipe/reload \
  -H "Authorization: Bearer $CATALYST_API_KEY"
```

## Совместимость

- Catalyst **>= 1.80.0** (манифест), тестировалось на **1.89.0**.
- Node.js 20+ (панель столько и требует).
- Rust Dedicated Server: `server/<identity>/`, имена файлов с protocol-суффиксом
  (`proceduralmap.*.map|sav`, `player.blueprints.*.db`, `sv.db`), поэтому в пресетах маски.

## Ограничения

- Удаление необратимо: первый прогон — только dry-run и с бэкапом.
- Нет анонсов в чат, ротации сида карты и часового пояса на профиль
  (см. [«Чего в плагине нет»](docs/RUST-AUTOWIPE-RU.md#чего-в-плагине-нет-сознательно-чтобы-не-раздувать-v100)).
- Плагин работает в процессе backend панели — как и любой плагин Catalyst.

## Лицензия

Лицензия пока не выбрана. Если планируете публиковать пакет в официальном маркетплейсе
Catalyst, добавьте `LICENSE` (например MIT) — панель допускает его в архиве плагина.
