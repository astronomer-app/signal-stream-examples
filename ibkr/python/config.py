"""Environment parsing for main.py."""

from __future__ import annotations

import os
import sys
from typing import NoReturn


def fail(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    sys.exit(1)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        fail(f"Missing required environment variable: {name}")
    return value


def read_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        return int(raw)
    except ValueError:
        fail(f"{name} must be an integer")


def read_float(name: str, fallback: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        return float(raw)
    except ValueError:
        fail(f"{name} must be a number")


def read_bool(name: str, fallback: bool) -> bool:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    if raw not in ("true", "false"):
        fail(f'{name} must be "true" or "false"')
    return raw == "true"
