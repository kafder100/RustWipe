#!/usr/bin/env python3
"""Проверка индекса маркетплейса Catalyst и пакета плагина.

Что проверяется:
  - plugin.json проходит схему панели (catalyst_manifest.py);
  - index.json читается как массив или {schemaVersion, plugins};
  - у записи есть name, https-downloadUrl и 64-hex sha256;
  - sha256 совпадает с реальным файлом из dist/ и с .sha256-сайдкаром;
  - zip содержит только разрешённые панелью записи и root plugin.json;
  - имя и версия в zip совпадают с записью индекса;
  - в zip лежат ровно те файлы rust-autowipe/, которые берёт pack.py, байт в байт:
    панели ставят тот же код, который проверяют тесты;
  - версия сходится везде: верхняя запись CHANGELOG.md и константа version
    во frontend.mjs — та же, что в plugin.json.

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
CHANGELOG_PATH = ROOT / "CHANGELOG.md"
FRONTEND_PATH = PLUGIN_DIR / "frontend" / "frontend.mjs"

ALLOWED_TOP_LEVEL = {"plugin.json", "README.md", "LICENSE", "backend", "frontend", "assets"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
# Заголовок записи CHANGELOG.md: «## 1.5.6 — дата» или диапазон «## 1.5.1–1.5.2 — дата».
CHANGELOG_HEADING_RE = re.compile(r"^##\s+(\d+\.\d+\.\d+)(?:\s*[–-]\s*(\d+\.\d+\.\d+))?")
# Константа версии во frontend.mjs: version: '1.5.6' (объект manifest в конце файла).
FRONTEND_VERSION_RE = re.compile(r"""\bversion\s*:\s*(['"`])(\d+\.\d+\.\d+)\1""")

# Какие файлы rust-autowipe/ попадают в пакет — те же правила, что в
# collect_files из tools/pack.py. Поменяли там — поменяйте и здесь (иначе
# эта проверка упадёт на первой же сборке).
PACKAGE_ROOT_FILES = ("plugin.json", "README.md", "LICENSE")
PACKAGE_DIRS = ("backend", "frontend", "assets")
FORBIDDEN_NAMES = {".DS_Store", "Thumbs.db"}
FORBIDDEN_PARTS = {"__pycache__", "node_modules", ".git", ".cache", "src", "dist", "tools"}


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


def source_files() -> dict[str, Path]:
    """Файлы rust-autowipe/, которые pack.py кладёт в пакет: имя в архиве → файл."""
    files: dict[str, Path] = {}
    for name in PACKAGE_ROOT_FILES:
        path = PLUGIN_DIR / name
        if path.is_file():
            files[name] = path
    for directory in PACKAGE_DIRS:
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
            files[rel.as_posix()] = path
    return files


def compare_with_sources(archive: zipfile.ZipFile, filename: str, errors: list[str]) -> None:
    """Пакет должен состоять ровно из файлов rust-autowipe/, байт в байт."""
    expected = source_files()
    packed = {info.filename for info in archive.infolist() if not info.is_dir()}
    missing = sorted(set(expected) - packed)
    extra = sorted(packed - set(expected))
    differ = sorted(name for name in packed & set(expected) if archive.read(name) != expected[name].read_bytes())
    problems = []
    if missing:
        problems.append("нет в пакете: " + ", ".join(missing))
    if extra:
        problems.append("лишнее в пакете (нет в rust-autowipe/): " + ", ".join(extra))
    if differ:
        problems.append("отличается от rust-autowipe/: " + ", ".join(differ))
    if problems:
        errors.append(
            f"dist/{filename} собран не из этих исходников ({'; '.join(problems)}). "
            "Поднимите version в plugin.json и пересоберите пакет: python tools/pack.py"
        )


def check_versions(version: str, errors: list[str]) -> None:
    """Верхняя запись CHANGELOG.md и версия во frontend.mjs — та же, что в plugin.json."""
    if not CHANGELOG_PATH.is_file():
        errors.append("CHANGELOG.md: файл не найден")
    else:
        top = None
        for line in CHANGELOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
            match = CHANGELOG_HEADING_RE.match(line)
            if match:
                top = match.group(2) or match.group(1)
                break
        if top is None:
            errors.append("CHANGELOG.md: нет ни одной записи вида «## X.Y.Z»")
        elif top != version:
            errors.append(
                f"CHANGELOG.md: верхняя запись — {top}, а version в plugin.json — {version}. "
                f"Добавьте в начало CHANGELOG.md раздел «## {version}»"
            )

    if FRONTEND_PATH.is_file():
        text = FRONTEND_PATH.read_text(encoding="utf-8", errors="replace")
        wrong = sorted({match.group(2) for match in FRONTEND_VERSION_RE.finditer(text)} - {version})
        if wrong:
            errors.append(
                f"rust-autowipe/frontend/frontend.mjs: version {', '.join(wrong)}, а в plugin.json — {version}. "
                "Поднимите version в объекте manifest в конце frontend.mjs"
            )


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
    if isinstance(manifest_version, str):
        check_versions(manifest_version, errors)

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
                if name == manifest_name:
                    compare_with_sources(archive, filename, errors)
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
