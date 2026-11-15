# Rust AutoWipe

[![ci](https://github.com/kafder100/RustWipe/actions/workflows/ci.yml/badge.svg)](https://github.com/kafder100/RustWipe/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/kafder100/RustWipe?display_name=tag)](https://github.com/kafder100/RustWipe/releases)

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

   Либо установить через маркетплейс панели — см. раздел ниже.

2. **Admin → Extensions → Plugins → Rust AutoWipe → Enable** (принять дисклеймер).

3. **Settings**: вставить `apiKey` — API-ключ панели с правами `server.read`,
   `server.start`, `server.stop` (и `console.write`, если нужны команды после запуска).

4. Вкладка **Rust AutoWipe** → создать профиль → выбрать сервер, расписание и пути →
   **«Что будет удалено»** → прогнать в dry-run → запустить.

Подробно: [docs/RUST-AUTOWIPE-RU.md](docs/RUST-AUTOWIPE-RU.md).

## Подключение к маркетплейсу Catalyst

Репозиторий сам служит индексом маркетплейса: `index.json` в корне ссылается на
пакет в `dist/`, а sha256 сверяется в CI, поэтому панель не получит «битую» версию.

1. **Admin → Extensions → Marketplace → Marketplaces → Add**:
   - **URL**: `https://raw.githubusercontent.com/kafder100/RustWipe/main/index.json`
   - **Label**: `RustWipe`
2. Вкладка **Marketplace** → найти **Rust AutoWipe** → **Install**
   (панель скачает zip, сверит sha256 и положит код на диск выключенным).
3. **Admin → Extensions → Plugins → Rust AutoWipe → Enable** → принять дисклеймер.
4. **Settings** → `apiKey` (см. выше).

Панель кэширует индекс 5 минут: после публикации новой версии нажмите в маркетплейсе
«обновить»; кнопка **Update** появится, когда версия в `index.json` станет выше
установленной.

> `raw.githubusercontent.com` кэширует файлы ещё примерно на 5 минут и не пробивается
> заголовком `no-cache`. Сразу после `git push` панель может видеть старую версию —
> подождите несколько минут. Сам пакет лежит по новому URL (`…-1.0.1.catpkg.zip`),
> поэтому он не кэшируется и после обновления индекса ставится сразу.

### Как выпустить новую версию

```bash
# 1. поднять version в rust-autowipe/plugin.json
# 2. пересобрать пакет и индекс (base-url уже указывает на этот репозиторий)
python tools/pack.py
# 3. закоммитить dist/, index.json и plugin.json
git add -A && git commit -m "release: rust-autowipe x.y.z"
git push
# 4. тег — workflow release.yml создаст GitHub Release и приложит пакет
git tag vx.y.z && git push origin vx.y.z
```

`pack.py` в конце запускает `check_index.py` и падает, если sha256, версия или состав
архива разошлись. В CI тот же `check_index.py` выполняется на каждый push.

Релиз можно создать и вручную, без тега:

```bash
GH_TOKEN=... node tools/release_github.mjs          # текущая версия из plugin.json
```

Скрипт идемпотентен: описание и топики репозитория обновляются, существующий релиз
не пересоздаётся, уже загруженный ассет пропускается.

Если хочется вместо raw-ссылки использовать GitHub Releases, соберите пакет с
`--base-url https://github.com/kafder100/RustWipe/releases/download/v<версия>` и
приложите zip к релизу — остальное (sha256, индекс) не меняется.

## Структура репозитория

```
rust-autowipe/            каталог плагина (имя = name в plugin.json)
  plugin.json             манифест: права, конфиг, события
  backend/                роуты, планировщик, fileTunnel, оркестрация вайпа
  frontend/frontend.mjs   self-contained UI (без React-хуков и импортов)
docs/RUST-AUTOWIPE-RU.md  полное руководство (установка, настройка, диагностика)
CHANGELOG.md              история версий
index.json                индекс маркетплейса (его URL добавляют в панель)
tools/test.mjs            тесты backend-логики (23 проверки)
tools/ui-smoke.mjs        дымовой тест UI на DOM-шиме
tools/pack.py             сборка .catpkg.zip + sha256 + index.json
tools/check_index.py      проверка индекса, пакета и схемы plugin.json (он же в CI)
tools/catalyst_manifest.py  повтор zod-схемы манифеста Catalyst
tools/push_to_github.mjs  публикация репозитория через GitHub REST API
dist/                     собранный пакет .catpkg.zip и .sha256
```

## Разработка

```bash
node tools/test.mjs                 # логика: расписание, маски, прогон вайпа
node tools/ui-smoke.mjs             # рендер UI без браузера
python tools/pack.py                # пересобрать пакет + индекс + проверка
python tools/check_index.py         # только проверка индекса/пакета/манифеста
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
