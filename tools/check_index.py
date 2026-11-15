#!/usr/bin/env python3
"""Проверка индекса маркетплейса Catalyst и пакета плагина.

Что проверяется:
  - plugin.json проходит схему панели (catalyst_manifest.py);
  - index.json читается как массив или {schemaVersion, plugins};
  - у записи есть name, https-downloadUrl и 64-hex sha256;
  - sha256 совпадает с реальным файлом из dist/ и с .sha256-сайдкаром;
  - zip содержит только разрешённые панелью записи и root plugin.json;
  - имя и версия в zip совпадают с записью индекса.

Запуск: python3 tools/check_index.py
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from catalyst_manifest import validate_manifest  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "rust-autowipe"
DIST_DIR = ROOT / "dist"
INDEX_PATH = ROOT / "index.json"

ALLOWED_TOP_LEVEL = {"plugin.json", "README.md", "LICENSE", "backend", "frontend", "assets"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")


def fail(errors: list[str]) -> None:
    print("Проверка НЕ пройдена:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path, errors: list[str], label: str):
    if not path.is_file():
        errors.append(f"{label}: файл не найден ({path})")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        errors.append(f"{label}: невалидный JSON ({error})")
        return None


def main() -> None:
    errors: list[str] = []

    manifest = load_json(PLUGIN_DIR / "plugin.json", errors, "plugin.json")
    if isinstance(manifest, dict):
        errors.extend(f"plugin.json: {item}" for item in validate_manifest(manifest))

    index = load_json(INDEX_PATH, errors, "index.json")
    entries: list[dict] = []
    if isinstance(index, list):
        entries = [item for item in index if isinstance(item, dict)]
    elif isinstance(index, dict):
        if index.get("schemaVersion") != 1:
            errors.append("index.json: schemaVersion должен быть 1")
        raw_entries = index.get("plugins")
        if not isinstance(raw_entries, list):
            errors.append("index.json: plugins должен быть массивом")
        else:
            entries = [item for item in raw_entries if isinstance(item, dict)]
    elif index is not None:
        errors.append("index.json: ожидался массив или объект {schemaVersion, plugins}")

    if not entries:
        errors.append("index.json: нет ни одной записи о плагине")

    manifest_name = manifest.get("name") if isinstance(manifest, dict) else None
    manifest_version = manifest.get("version") if isinstance(manifest, dict) else None

    matched_entry = None
    for position, entry in enumerate(entries):
        prefix = f"index.plugins[{position}]"
        name = entry.get("name")
        download_url = entry.get("downloadUrl")
        sha256 = entry.get("sha256")
        version = entry.get("version")

        if not isinstance(name, str) or not name:
            errors.append(f"{prefix}.name: обязательная строка")
        if not isinstance(download_url, str) or not download_url:
            errors.append(f"{prefix}.downloadUrl: обязательная строка")
            continue
        parsed = urlparse(download_url)
        if parsed.scheme != "https":
            errors.append(f"{prefix}.downloadUrl: нужен https (сейчас {parsed.scheme or '—'})")
        if not isinstance(sha256, str) or not SHA256_RE.match(sha256):
            errors.append(f"{prefix}.sha256: нужен 64-символьный hex в нижнем регистре")
            continue
        if version is not None and not VERSION_RE.match(str(version)):
            errors.append(f"{prefix}.version: MAJOR.MINOR.PATCH")

        if name == manifest_name:
            matched_entry = entry

        filename = Path(parsed.path).name
        if not filename:
            errors.append(f"{prefix}.downloadUrl: не удалось определить имя файла")
            continue
        package_path = DIST_DIR / filename
        if not package_path.is_file():
            errors.append(f"пакет из downloadUrl отсутствует локально: dist/{filename}")
            continue

        actual = hashlib.sha256(package_path.read_bytes()).hexdigest()
        if actual != sha256:
            errors.append(
                f"{prefix}.sha256 не совпадает с dist/{filename}: индекс {sha256[:12]}…, файл {actual[:12]}…"
            )

        sidecar = package_path.with_name(package_path.name + ".sha256")
        if not sidecar.is_file():
            errors.append(f"нет сайдкара dist/{sidecar.name}")
        else:
            sidecar_value = sidecar.read_text(encoding="utf-8").split()[0]
            if sidecar_value != actual:
                errors.append(f"dist/{sidecar.name} не совпадает с файлом пакета")

        try:
            with zipfile.ZipFile(package_path) as archive:
                bad = archive.testzip()
                if bad is not None:
                    errors.append(f"zip повреждён: {bad}")
                names = archive.namelist()
                for entry_name in names:
                    top = entry_name.split("/", 1)[0]
                    if top not in ALLOWED_TOP_LEVEL or ".." in entry_name or entry_name.startswith("/"):
                        errors.append(f"zip: запрещённая запись {entry_name}")
                if "plugin.json" not in names:
                    errors.append("zip: нет plugin.json в корне")
                else:
                    inner = json.loads(archive.read("plugin.json").decode("utf-8"))
                    if inner.get("name") != name:
                        errors.append(
                            f"zip: plugin.json name={inner.get('name')!r} не совпадает с индексом {name!r}"
                        )
                    if version is not None and inner.get("version") != version:
                        errors.append(
                            f"zip: plugin.json version={inner.get('version')!r} не совпадает с индексом {version!r}"
                        )
        except zipfile.BadZipFile:
            errors.append(f"dist/{filename}: не zip-архив")

    if matched_entry is None:
        errors.append(f"index.json: нет записи для плагина {manifest_name!r}")
    else:
        if matched_entry.get("version") != manifest_version:
            errors.append(
                f"index.json: версия {matched_entry.get('version')!r} не совпадает с plugin.json {manifest_version!r}"
            )

    if errors:
        fail(errors)

    print("Индекс и пакет корректны.")
    print(f"  плагин:  {manifest_name} {manifest_version}")
    print(f"  записей: {len(entries)}")
    print(f"  индекс:  {INDEX_PATH}")


if __name__ == "__main__":
    main()
