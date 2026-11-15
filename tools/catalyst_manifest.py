"""Проверка plugin.json по правилам панели Catalyst.

Повторяет zod-схему `catalyst-backend/src/plugins/validator.ts`, чтобы битый
манифест ловился до публикации, а не при установке из маркетплейса.
"""

from __future__ import annotations

import re
from typing import Any

PLUGIN_NAME_RE = re.compile(r"^[a-z0-9-]+$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
CATALYST_VERSION_RE = re.compile(r"^([><=]+)?\s*(\d+\.\d+\.\d+)$")
CONFIG_KEY_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,50}$")
USER_PERMISSION_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,64}$")
PERMISSION_TOKEN_RE = re.compile(r"^[a-zA-Z0-9_.*-]{1,64}$")

MAX_USER_PERMISSIONS = 32
PERMISSION_DESCRIPTION_MAX = 200


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def validate_manifest(manifest: Any) -> list[str]:
    """Возвращает список нарушений схемы (пустой список — манифест валиден)."""
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["plugin.json должен быть JSON-объектом"]

    name = _str(manifest.get("name"))
    if not name:
        errors.append("name: обязательное поле")
    elif len(name) > 50 or not PLUGIN_NAME_RE.match(name):
        errors.append("name: 1–50 символов, только a-z, 0-9 и дефис")

    version = _str(manifest.get("version"))
    if not version:
        errors.append("version: обязательное поле")
    elif not VERSION_RE.match(version):
        errors.append("version: только MAJOR.MINOR.PATCH (например 1.0.0)")

    for field, limit in (("displayName", 100), ("description", 500), ("author", 100)):
        value = _str(manifest.get(field))
        if not value:
            errors.append(f"{field}: обязательное поле")
        elif len(value) > limit:
            errors.append(f"{field}: не длиннее {limit} символов")

    catalyst_version = _str(manifest.get("catalystVersion"))
    if not catalyst_version:
        errors.append("catalystVersion: обязательное поле")
    elif not CATALYST_VERSION_RE.match(catalyst_version):
        errors.append("catalystVersion: формат >=1.80.0, =1.89.0, <2.0.0")

    permissions = manifest.get("permissions", [])
    if not isinstance(permissions, list):
        errors.append("permissions: должен быть массивом строк")
        permissions = []
    else:
        for token in permissions:
            if not isinstance(token, str):
                errors.append("permissions: элементы должны быть строками")
            elif not PERMISSION_TOKEN_RE.match(token):
                errors.append(f"permissions: некорректный токен {token!r}")

    descriptions = manifest.get("permissionDescriptions")
    if descriptions is not None:
        if not isinstance(descriptions, dict):
            errors.append("permissionDescriptions: должен быть объектом")
        else:
            declared = {p for p in permissions if isinstance(p, str)}
            for key, value in descriptions.items():
                if key not in declared:
                    errors.append(f"permissionDescriptions: {key!r} нет в permissions")
                if not isinstance(value, str) or not value:
                    errors.append(f"permissionDescriptions.{key}: нужна непустая строка")
                elif len(value) > PERMISSION_DESCRIPTION_MAX:
                    errors.append(
                        f"permissionDescriptions.{key}: не длиннее {PERMISSION_DESCRIPTION_MAX} символов"
                    )

    user_permissions = manifest.get("userPermissions")
    if user_permissions is not None:
        if not isinstance(user_permissions, list):
            errors.append("userPermissions: должен быть массивом")
        elif len(user_permissions) > MAX_USER_PERMISSIONS:
            errors.append(f"userPermissions: не больше {MAX_USER_PERMISSIONS} записей")
        else:
            seen: set[str] = set()
            for index, item in enumerate(user_permissions):
                if not isinstance(item, dict):
                    errors.append(f"userPermissions[{index}]: должен быть объектом")
                    continue
                perm_id = _str(item.get("id"))
                label = _str(item.get("label"))
                description = item.get("description")
                if not perm_id or not USER_PERMISSION_RE.match(perm_id) or perm_id == "*":
                    errors.append(f"userPermissions[{index}].id: некорректный токен")
                elif perm_id in seen:
                    errors.append(f"userPermissions[{index}].id: дубликат {perm_id!r}")
                else:
                    seen.add(perm_id)
                if not label or len(label) > 64:
                    errors.append(f"userPermissions[{index}].label: 1–64 символа")
                if description is not None and (
                    not isinstance(description, str)
                    or not description
                    or len(description) > PERMISSION_DESCRIPTION_MAX
                ):
                    errors.append(f"userPermissions[{index}].description: 1–200 символов")

    for field in ("backend", "frontend"):
        block = manifest.get(field)
        if block is None:
            continue
        if not isinstance(block, dict) or not isinstance(block.get("entry"), str) or not block["entry"]:
            errors.append(f"{field}: нужен объект с непустым entry")
        elif block["entry"].startswith("/") or ".." in block["entry"].split("/"):
            errors.append(f"{field}.entry: путь должен быть относительным внутри плагина")

    config = manifest.get("config")
    if config is not None:
        if not isinstance(config, dict):
            errors.append("config: должен быть объектом")
        else:
            for key in config:
                if not CONFIG_KEY_RE.match(key):
                    errors.append(f"config.{key}: ключ не по формату a-z/A-Z/0-9/_/-")

    events = manifest.get("events")
    if events is not None:
        if not isinstance(events, dict):
            errors.append("events: должен быть объектом")
        else:
            for key, value in events.items():
                if not isinstance(value, dict) or not isinstance(value.get("payload"), dict):
                    errors.append(f"events.{key}: нужен объект payload")

    storage_engine = manifest.get("storageEngine")
    if storage_engine is not None and storage_engine not in ("legacy", "dedicated"):
        errors.append("storageEngine: legacy или dedicated")

    runtime = manifest.get("runtime")
    if runtime == "isolated":
        errors.append("runtime: isolated не поддерживается панелью — уберите поле")
    elif runtime is not None and runtime not in ("legacy", "isolated"):
        errors.append("runtime: legacy или isolated")

    dependencies = manifest.get("dependencies")
    if dependencies is not None:
        if not isinstance(dependencies, dict):
            errors.append("dependencies: должен быть объектом")
        else:
            for key, value in dependencies.items():
                if not isinstance(value, str) or not VERSION_RE.match(value):
                    errors.append(f"dependencies.{key}: точная версия MAJOR.MINOR.PATCH")

    return errors
