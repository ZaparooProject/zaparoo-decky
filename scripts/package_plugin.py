#!/usr/bin/env python3
"""Build and validate a manual-install Decky plugin archive."""

from __future__ import annotations

import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Any, NoReturn, cast

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR_NAME = "Zaparoo"
SOURCE_RUNTIME_FILES = (
    Path("dist/index.js"),
    Path("main.py"),
    Path("package.json"),
    Path("plugin.json"),
    Path("README.md"),
    Path("LICENSE"),
    Path("THIRD_PARTY_NOTICES.md"),
)
GENERATED_RUNTIME_FILES = {
    ROOT / "node_modules" / "@decky" / "api" / "LICENSE": Path("LICENSES/LGPL-2.1.txt"),
}
REQUIRED_ARCHIVE_FILES = SOURCE_RUNTIME_FILES + tuple(GENERATED_RUNTIME_FILES.values())
RUNTIME_DEPENDENCY_LICENSES = {
    "@decky/api": "LGPL-2.1",
    "qrcode.react": "ISC",
    "react-icons": "MIT",
    "tslib": "0BSD",
}
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
FORBIDDEN_FLAGS = {"_root", "debug", "remote-binary"}


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {path.relative_to(ROOT)}: {error}")
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return cast(dict[str, Any], value)


def validate_source_files() -> None:
    for relative_path in SOURCE_RUNTIME_FILES:
        path = ROOT / relative_path
        if not path.is_file():
            fail(f"required runtime file is missing: {relative_path}")
    for source in GENERATED_RUNTIME_FILES:
        if not source.is_file():
            fail(f"dependency license is missing: {source.relative_to(ROOT)}")


def validate_package(package: dict[str, Any]) -> str:
    if package.get("name") != "zaparoo-decky":
        fail("package.json name must be zaparoo-decky")
    version = package.get("version")
    if not isinstance(version, str) or VERSION_PATTERN.fullmatch(version) is None:
        fail("package.json version must be semantic")
    if package.get("license") != "GPL-3.0-or-later":
        fail("package.json license must be GPL-3.0-or-later")
    dependencies_value = package.get("dependencies")
    if not isinstance(dependencies_value, dict):
        fail("package.json dependencies must be an object")
    dependencies = cast(dict[str, object], dependencies_value)
    if set(dependencies) != set(RUNTIME_DEPENDENCY_LICENSES):
        fail("runtime dependency license inventory is incomplete or stale")
    return version


def validate_plugin(plugin: dict[str, Any]) -> None:
    if plugin.get("name") != PLUGIN_DIR_NAME:
        fail(f"plugin.json name must be {PLUGIN_DIR_NAME}")
    if plugin.get("api_version") != 1:
        fail("plugin.json api_version must be 1")
    flags_value = plugin.get("flags")
    if not isinstance(flags_value, list):
        fail("plugin.json flags must be a string array")
    untyped_flags = cast(list[object], flags_value)
    if any(not isinstance(flag, str) for flag in untyped_flags):
        fail("plugin.json flags must be a string array")
    forbidden = FORBIDDEN_FLAGS.intersection(cast(list[str], flags_value))
    if forbidden:
        fail(f"plugin.json contains forbidden flags: {', '.join(sorted(forbidden))}")

    publish_value = plugin.get("publish")
    if not isinstance(publish_value, dict):
        fail("plugin.json publish metadata is required")
    publish = cast(dict[str, Any], publish_value)
    for key in ("tags", "description", "image"):
        if not publish.get(key):
            fail(f"plugin.json publish.{key} is required")


def validate_dependency_notices() -> None:
    notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    for dependency, expected_license in RUNTIME_DEPENDENCY_LICENSES.items():
        dependency_package = load_json(ROOT / "node_modules" / dependency / "package.json")
        dependency_version = dependency_package.get("version")
        if dependency_package.get("license") != expected_license:
            fail(f"unexpected license for {dependency}")
        if not isinstance(dependency_version, str):
            fail(f"invalid installed version for {dependency}")
        version_notice = f"Version {dependency_version},"
        if f"## {dependency}" not in notices or version_notice not in notices:
            fail(f"third-party notice is stale or missing for {dependency}")


def validate_source() -> str:
    validate_source_files()
    package = load_json(ROOT / "package.json")
    plugin = load_json(ROOT / "plugin.json")
    version = validate_package(package)
    validate_plugin(plugin)

    lockfile = (ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
    if not lockfile.startswith("lockfileVersion: '9.0'"):
        fail("pnpm-lock.yaml must use lockfileVersion 9.0")
    validate_dependency_notices()

    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    required_licenses = ("GNU GENERAL PUBLIC LICENSE", "BSD 3-Clause License")
    if any(required not in license_text for required in required_licenses):
        fail("LICENSE must include GPL-3.0 and Decky template BSD text")
    return version


def create_archive(version: str) -> Path:
    output_root = ROOT / "out"
    plugin_root = output_root / PLUGIN_DIR_NAME
    if output_root.exists():
        shutil.rmtree(output_root)
    plugin_root.mkdir(parents=True)

    for relative_path in SOURCE_RUNTIME_FILES:
        source = ROOT / relative_path
        destination = plugin_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    for source, relative_path in GENERATED_RUNTIME_FILES.items():
        destination = plugin_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    archive_path = output_root / f"{PLUGIN_DIR_NAME}-v{version}.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(plugin_root.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(output_root))

    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        expected = {f"{PLUGIN_DIR_NAME}/{path.as_posix()}" for path in REQUIRED_ARCHIVE_FILES}
        missing = expected.difference(names)
        if missing:
            fail(f"archive is missing required files: {', '.join(sorted(missing))}")
        if any("__pycache__" in name or name.endswith(".pyc") for name in names):
            fail("archive contains Python cache files")

    return archive_path


def main() -> int:
    try:
        version = validate_source()
        archive_path = create_archive(version)
    except RuntimeError as error:
        print(f"package validation failed: {error}", file=sys.stderr)
        return 1
    print(archive_path.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
