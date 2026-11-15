#!/usr/bin/env python3
"""Сборка .catpkg.zip для панели Catalyst + проверка состава.

Использование:
    python tools/pack.py
    python tools/pack.py --base-url https://cdn.example.com/plugins

Пишет в dist/:
    <name>-<version>.catpkg.zip
    <name>-<version>.catpkg.zip.sha256
    index.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "rust-autowipe"
DIST_DIR = ROOT / "dist"

ALLOWED_TOP_LEVEL = {"plugin.json", "README.md", "LICENSE", "backend", "frontend", "assets"}
FORBIDDEN_NAMES = {".DS_Store", "Thumbs.db"}
FORBIDDEN_PARTS = {"__pycache__", "node_modules", ".git", ".cache", "src", "dist", "tools"}


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
    if not manifest.is_file():
        fail("plugin.json отсутствует")

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Собрать .catpkg.zip для Catalyst")
    parser.add_argument(
        "--base-url",
        default="https://example.com/plugins",
        help="базовый URL, где будет лежать архив (для index.json)",
    )
    args = parser.parse_args()

    manifest = load_manifest()
    name = manifest["name"]
    version = manifest["version"]

    files = collect_files()
    entries = sorted({path.relative_to(PLUGIN_DIR).as_posix() for path in files})
    verify_entries(entries, manifest)

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = DIST_DIR / f"{name}-{version}.catpkg.zip"

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry in entries:
            archive.write(PLUGIN_DIR / entry, arcname=entry)

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    sha_path = DIST_DIR / f"{name}-{version}.catpkg.zip.sha256"
    sha_path.write_text(f"{digest}  {zip_path.name}\n", encoding="utf-8")

    base = args.base_url.rstrip("/")
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
    index_path = DIST_DIR / "index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Пакет:   {zip_path} ({zip_path.stat().st_size} байт)")
    print(f"sha256:  {digest}")
    print(f"Индекс:  {index_path}")
    print("Состав:")
    for entry in entries:
        print(f"  - {entry}")


if __name__ == "__main__":
    main()
