"""March Deck constants — canonical paths and shared values.

All runtime data lives under ~/.march-deck (hardcoded, not configurable).
"""
from __future__ import annotations

from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────
DATA_DIR = Path.home() / ".march-deck"
CERTS_DIR = DATA_DIR / "certs"
LOGS_DIR = DATA_DIR / "logs"
APP_DATA_DIR = DATA_DIR / "app"
CONFIG_FILE = DATA_DIR / "config.yaml"

# ── Defaults ──────────────────────────────────────────────────────────
DEFAULT_PORT = 8800
DEFAULT_MARCH_API_URL = "http://localhost:8101"
DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434"
