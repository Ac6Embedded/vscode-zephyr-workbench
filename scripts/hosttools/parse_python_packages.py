#!/usr/bin/env python3
"""Emit python package specs from tools.yml for a given OS."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterable, List


def normalize_flag(value: object) -> bool:
    """Interpret assorted truthy values."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def should_install(entry: dict, os_key: str) -> bool:
    """Decide whether the package should be installed for OS."""
    os_spec = entry.get("os")
    if not isinstance(os_spec, dict):
        return True
    return normalize_flag(os_spec.get(os_key))


def iter_specs(entries: Iterable[dict], os_key: str) -> Iterable[str]:
    """Yield normalized package specs."""
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if not should_install(entry, os_key):
            continue
        url = (entry.get("url") or "").strip()
        name = (entry.get("name") or "").strip()
        version = (entry.get("version") or "").strip()
        if url:
            yield url
        elif name and version:
            yield f"{name}=={version}"
        elif name:
            yield name


def main(argv: List[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("Usage: parse_python_packages.py <tools.yml> <os>\n")
        return 1

    yaml_path = Path(argv[1]).expanduser().resolve()
    os_key = argv[2].strip()

    try:
        import yaml  # type: ignore
    except ImportError:
        sys.stderr.write("PyYAML is required; install it with pip install PyYAML.\n")
        return 2

    try:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        sys.stderr.write(f"Could not find YAML file: {yaml_path}\n")
        return 3

    packages = data.get("python_packages") or []
    for spec in iter_specs(packages, os_key):
        print(spec)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
