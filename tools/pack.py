#!/usr/bin/env python3
"""Сборка .catpkg.zip для панели Catalyst + индекс маркетплейса.

Использование:
    python tools/pack.py
    python tools/pack.py --base-url https://raw.githubusercontent.com/user/RustWipe/main/dist

Пишет:
    dist/<name>-<version>.catpkg.zip
    dist/<name>-<version>.catpkg.zip.sha256
    index.json                      (корень репозитория — его и добавляют в панель)

После сборки запускает tools/check_index.py, чтобы индекс и пакет не разъехались.

Сборка воспроизводимая: файлы идут в архив в одном и том же порядке,
у всех записей одна и та же дата (1980-01-01) и одни и те же права (rw-r--r--),
поэтому одинаковые исходники дают одинаковый архив, когда бы их ни взяли.
Сжатие зависит от библиотеки zlib: другой Python (например, в CI) может сжать
те же файлы чуть иначе. Поэтому уже собранный пакет этой версии сравнивается
по содержимому: если файлы внутри те же — пакет остаётся как есть и sha256
не меняется; если другие — сборка останавливается (см. --allow-repack).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalyst_manifest import validate_manifest  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "rust-autowipe"
DIST_DIR = ROOT / "dist"
INDEX_PATH = ROOT / "index.json"

DEFAULT_BASE_URL = "https://raw.githubusercontent.com/kafder100/RustWipe/main/dist"
DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/kafder100/RustWipe/main/index.json"

ALLOWED_TOP_LEVEL = {"plugin.json", "README.md", "LICENSE", "backend", "frontend", "assets"}
FORBIDDEN_NAMES = {".DS_Store", "Thumbs.db"}
FORBIDDEN_PARTS = {"__pycache__", "node_modules", ".git", ".cache", "src", "dist", "tools"}

# Постоянные свойства записей архива — чтобы сборка не зависела от дат файлов
# на диске, от прав доступа и от системы, где собирали.
ENTRY_DATE = (1980, 1, 1, 0, 0, 0)  # самая ранняя дата, которую хранит zip
ENTRY_MODE = 0o100644  # обычный файл, rw-r--r--
ENTRY_SYSTEM = 3  # «Unix»: права выше записаны в формате Unix


def fail(message: str) -> None:
    print(f"ОШИБКА: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_manifest() -> dict:
    path = PLUGIN_DIR / "plugin.json"
    if not path.is_file():
        fail(f"нет файла {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"plugin.json невалиден: {error}")


def collect_files() -> list[Path]:
    manifest = PLUGIN_DIR / "plugin.json"
    files: list[Path] = [manifest]

    readme = PLUGIN_DIR / "README.md"
    if readme.is_file():
        files.append(readme)
    license_file = PLUGIN_DIR / "LICENSE"
    if license_file.is_file():
        files.append(license_file)

    for directory in ("backend", "frontend", "assets"):
        base = PLUGIN_DIR / directory
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(PLUGIN_DIR)
            if any(part in FORBIDDEN_PARTS for part in rel.parts):
                continue
            if path.name in FORBIDDEN_NAMES or path.name.startswith("."):
                continue
            files.append(path)

    return files


def verify_entries(entries: list[str], manifest: dict) -> None:
    for entry in entries:
        top = entry.split("/", 1)[0]
        if top not in ALLOWED_TOP_LEVEL:
            fail(f"запрещённая запись в архиве: {entry} (верхний уровень {top})")
        if ".." in entry or entry.startswith("/"):
            fail(f"небезопасный путь в архиве: {entry}")

    backend_entry = (manifest.get("backend") or {}).get("entry")
    if backend_entry and backend_entry not in entries:
        fail(f"backend.entry «{backend_entry}» отсутствует в пакете")

    frontend_entry = (manifest.get("frontend") or {}).get("entry")
    if frontend_entry and frontend_entry not in entries:
        fail(f"frontend.entry «{frontend_entry}» отсутствует в пакете")

    if manifest.get("frontend") and "frontend/frontend.mjs" not in entries:
        fail("у плагина есть frontend, но frontend/frontend.mjs не попал в пакет")


def write_archive(path: Path, entries: list[str]) -> None:
    """Записать архив: записи по порядку entries, с постоянной датой и правами."""
    with zipfile.ZipFile(path, "w") as archive:
        for entry in entries:
            info = zipfile.ZipInfo(entry, date_time=ENTRY_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = ENTRY_SYSTEM
            info.external_attr = ENTRY_MODE << 16
            archive.writestr(info, (PLUGIN_DIR / entry).read_bytes(), compresslevel=9)


def archive_files(path: Path) -> dict[str, bytes] | None:
    """Файлы внутри архива: имя → содержимое. None — если это не zip."""
    try:
        with zipfile.ZipFile(path) as archive:
            return {info.filename: archive.read(info) for info in archive.infolist() if not info.is_dir()}
    except (zipfile.BadZipFile, OSError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Собрать .catpkg.zip и индекс Catalyst")
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help="каталог, в котором будет лежать архив (для downloadUrl в index.json)",
    )
    parser.add_argument(
        "--index-url",
        default=DEFAULT_INDEX_URL,
        help="публичный URL index.json — печатается как адрес для панели",
    )
    parser.add_argument("--skip-check", action="store_true", help="не запускать check_index.py")
    parser.add_argument(
        "--allow-repack",
        action="store_true",
        help="перезаписать уже опубликованный пакет этой версии другим содержимым",
    )
    args = parser.parse_args()

    manifest = load_manifest()
    manifest_errors = validate_manifest(manifest)
    if manifest_errors:
        fail("plugin.json не проходит схему Catalyst:\n  - " + "\n  - ".join(manifest_errors))

    name = manifest["name"]
    version = manifest["version"]

    files = collect_files()
    entries = sorted({path.relative_to(PLUGIN_DIR).as_posix() for path in files})
    verify_entries(entries, manifest)

    base = args.base_url.rstrip("/")
    if not base.startswith("https://"):
        # Панель отказывает в установке по plaintext http для всех, кроме
        # доверенных локальных хостов, — предупреждаем сразу.
        print(f"ВНИМАНИЕ: base-url не https ({base}) — панель не установит такой пакет", file=sys.stderr)

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = DIST_DIR / f"{name}-{version}.catpkg.zip"
    tmp_zip = DIST_DIR / f".{name}-{version}.tmp.zip"

    write_archive(tmp_zip, entries)

    digest = hashlib.sha256(tmp_zip.read_bytes()).hexdigest()

    # Один и тот же URL пакета с другим содержимым ломает установку: панель
    # сверяет sha256, а CDN raw.githubusercontent.com отдаёт закэшированные байты.
    # Поэтому пересборку уже выпущенной версии требуем подтверждать явно.
    keep_previous = False
    if zip_path.is_file():
        previous = hashlib.sha256(zip_path.read_bytes()).hexdigest()
        if previous != digest:
            if archive_files(zip_path) == archive_files(tmp_zip):
                # Внутри те же файлы, а байты архива другие (другая дата или
                # другой zlib). Опубликованный пакет и его sha256 не трогаем.
                keep_previous = True
                print(
                    f"Пакет {zip_path.name} уже собран из тех же файлов — оставлен как есть "
                    f"(sha256 {previous[:12]}… не меняется)"
                )
            elif not args.allow_repack:
                tmp_zip.unlink()
                fail(
                    f"пакет {zip_path.name} уже собран с другим содержимым "
                    f"({previous[:12]}… → {digest[:12]}…). Поднимите version в plugin.json "
                    f"или запустите с --allow-repack"
                )
    if keep_previous:
        tmp_zip.unlink()
        digest = previous
    else:
        tmp_zip.replace(zip_path)
    sha_path = DIST_DIR / f"{name}-{version}.catpkg.zip.sha256"
    # newline="\n" — чтобы файлы в репозитории не зависели от ОС сборки.
    sha_path.write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8", newline="\n")

    index = {
        "schemaVersion": 1,
        "plugins": [
            {
                "name": name,
                "displayName": manifest["displayName"],
                "description": manifest["description"],
                "author": manifest["author"],
                "version": version,
                "downloadUrl": f"{base}/{zip_path.name}",
                "sha256": digest,
                "tags": ["rust", "wipe", "schedule", "automation"],
            }
        ],
    }
    INDEX_PATH.write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    legacy_index = DIST_DIR / "index.json"
    if legacy_index.is_file():
        legacy_index.unlink()
        print(f"Удалён устаревший {legacy_index.relative_to(ROOT)} (индекс теперь в корне)")

    print(f"Пакет:   {zip_path.relative_to(ROOT)} ({zip_path.stat().st_size} байт)")
    print(f"sha256:  {digest}")
    print(f"Индекс:  {INDEX_PATH.relative_to(ROOT)}")
    print(f"URL для панели (Marketplaces → Add): {args.index_url}")
    print("Состав:")
    for entry in entries:
        print(f"  - {entry}")

    if not args.skip_check:
        print("")
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "check_index.py")],
            cwd=ROOT,
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
