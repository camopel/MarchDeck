#!/usr/bin/env python3
"""
Install script for marchdeck v2 — Personal PWA App Marketplace.

Installs Python dependencies, generates VAPID keys, creates config and data directories.
Works on macOS and Linux (Python 3.9+).

Architecture:
  - Built-in apps:  apps/<id>/backend/routes.py + apps/<id>/frontend/App.tsx

  - Commons:        scripts/commons/  (shared Python utilities)
  - Frontend:       frontend/src/commons/  (shared React components/hooks)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPTS_DIR.parent
DATA_DIR = Path("~/.march-deck").expanduser()
CONFIG_PATH = DATA_DIR / "config.yaml"

REQUIRED_PACKAGES = [
    "fastapi>=0.100",
    "uvicorn[standard]>=0.20",
    "psutil>=5.9",
    "pywebpush>=2.0",
    "py-vapid>=1.9",
    "pyyaml>=6.0",
]


def run(cmd: list[str], check: bool = True, capture: bool = True) -> subprocess.CompletedProcess:
    display = " ".join(str(c) for c in cmd)
    print(f"  → {display}")
    return subprocess.run(cmd, check=check, capture_output=capture, text=True)


def pip_install(packages: list[str]) -> None:
    """Install packages with --user (no venv)."""
    base_cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--user"]
    attempts = [
        base_cmd + packages,
        [sys.executable, "-m", "pip", "install", "--quiet"] + packages,
    ]

    for cmd in attempts:
        result = run(cmd, check=False)
        if result.returncode == 0:
            return
        last_err = result.stderr

    print(f"  ⚠️  pip install may have failed. Last error:\n{last_err[:300]}")
    print("  Continuing anyway — packages may already be installed.")


def generate_vapid_keys(certs_dir: Path, email: str) -> tuple[str, str]:
    """Generate VAPID key pair and write to certs_dir. Returns (private_pem_path, public_key_b64)."""
    private_pem = certs_dir / "vapid_private.pem"
    public_txt = certs_dir / "vapid_public.txt"

    if private_pem.exists() and public_txt.exists():
        print("  ✅ VAPID keys already exist — skipping generation")
        return str(private_pem), public_txt.read_text().strip()

    try:
        from py_vapid import Vapid
    except ImportError:
        print("  ❌ py-vapid not available — skipping VAPID key generation")
        return "", ""

    print("  Generating VAPID key pair...")
    vapid = Vapid()
    vapid.generate_keys()

    # Write private key
    vapid.save_key(str(private_pem))

    # Export public key as URL-safe base64 (application server key for browsers)
    from py_vapid import b64urlencode

    pub_key_bytes = vapid.public_key.public_bytes(
        encoding=__import__("cryptography.hazmat.primitives.serialization", fromlist=["Encoding"]).Encoding.X962,
        format=__import__("cryptography.hazmat.primitives.serialization", fromlist=["PublicFormat"]).PublicFormat.UncompressedPoint,
    )
    pub_key_b64 = b64urlencode(pub_key_bytes)
    public_txt.write_text(pub_key_b64)

    print(f"  ✅ VAPID private key: {private_pem}")
    print(f"  ✅ VAPID public key:  {pub_key_b64[:40]}...")
    return str(private_pem), pub_key_b64


def main() -> None:
    print("🔧 Installing March Deck...\n")

    # 1. Python version check
    v = sys.version_info
    print(f"Python: {v.major}.{v.minor}.{v.micro}")
    if v < (3, 9):
        print("❌ Python 3.9+ required")
        sys.exit(1)
    print(f"  ✅ Python {v.major}.{v.minor}\n")

    # 2. Platform check
    if sys.platform == "win32":
        print("❌ Windows is not supported. Use macOS or Linux.")
        sys.exit(1)
    print(f"  ✅ Platform: {sys.platform}\n")

    # 3. Install Python packages
    print("📦 Installing Python packages...")
    pip_install(REQUIRED_PACKAGES)
    print()

    # 4. Verify imports
    print("🔍 Verifying imports...")
    errors = []
    checks = [
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("psutil", "psutil"),
        ("pywebpush", "pywebpush"),
        ("py-vapid", "py_vapid"),
        ("pyyaml", "yaml"),
    ]
    for name, module in checks:
        result = run(
            [sys.executable, "-c", f"import {module}; print('ok')"],
            check=False,
        )
        if result.returncode == 0 and "ok" in result.stdout:
            print(f"  ✅ {name}")
        else:
            print(f"  ❌ {name}")
            errors.append(name)
    print()

    if errors:
        print(f"❌ Missing packages: {', '.join(errors)}")
        print("   Try: pip install " + " ".join(errors))
        sys.exit(1)

    # 5. Create data directories
    print(f"📁 Setting up data directory: {DATA_DIR}")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    certs_dir = DATA_DIR / "certs"
    certs_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = DATA_DIR / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    (logs_dir / "server").mkdir(exist_ok=True)
    (logs_dir / "finviz").mkdir(exist_ok=True)
    app_dir = DATA_DIR / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    for app_name in ("march", "finviz", "arxiv", "notes", "system", "files", "cast", "openclaw"):
        (app_dir / app_name).mkdir(exist_ok=True)
    (app_dir / "finviz" / "articles").mkdir(exist_ok=True)
    print(f"  ✅ {DATA_DIR}\n")

    # 6. Read existing config or use defaults
    config = {}
    if CONFIG_PATH.exists():
        try:
            config = yaml.safe_load(CONFIG_PATH.read_text()) or {}
        except Exception:
            pass
    vapid_email = config.get("push", {}).get("vapid_email", "nobody@localhost")

    # 7. Write default config if not present
    if not CONFIG_PATH.exists():
        example = SCRIPTS_DIR / "config.example.yaml"
        if example.exists():
            shutil.copy(example, CONFIG_PATH)
            print(f"  ✅ Config copied to {CONFIG_PATH}")
        else:
            # Write minimal config
            default_config = {
                "server": {"host": "0.0.0.0", "port": 8800},
                "push": {"vapid_email": "nobody@localhost"},
                "llm": {"default": "", "providers": {}},
                "apps": {
                    "finviz": {"crawl_interval": 7200},
                    "arxiv": {"embedding_model": "nomic-embed-text"},
                    "files": {"root": "/", "show_hidden": False},
                },
            }
            CONFIG_PATH.write_text(yaml.dump(default_config, default_flow_style=False, sort_keys=False))
            print(f"  ✅ Default config written to {CONFIG_PATH}")
    elif CONFIG_PATH.exists():
        print(f"  ✅ Config already exists: {CONFIG_PATH}")
    print()

    # 8. Generate VAPID keys
    print("🔑 Setting up VAPID keys for push notifications...")
    private_key_path, public_key = generate_vapid_keys(certs_dir, vapid_email)
    print()

    # 9. Verify apps are present
    print("📱 Checking built-in apps...")
    apps_dir = REPO_DIR / "apps"
    if apps_dir.is_dir():
        app_names = [d.name for d in sorted(apps_dir.iterdir()) if d.is_dir() and (d / "app.json").exists()]
        for name in app_names:
            print(f"  ✅ {name}")
        if not app_names:
            print("  ⚠️  No apps found in apps/")
    else:
        print(f"  ⚠️  Apps directory not found: {apps_dir}")
    print()

    # 10. Quick server test (import check)
    print("🧪 Testing server startup (import check)...")
    result = run(
        [sys.executable, "-c",
         "from pathlib import Path; import importlib.util; "
         f"spec = importlib.util.spec_from_file_location('server', '{SCRIPTS_DIR}/server.py'); "
         "m = importlib.util.module_from_spec(spec); print('ok')"],
        check=False,
    )
    if result.returncode == 0:
        print("  ✅ Server imports OK")
    else:
        print(f"  ⚠️  Server import test inconclusive: {result.stderr[:200]}")
    print()

    # 11. Print summary
    print("=" * 50)
    print("✅ March Deck installed successfully!")
    print()
    print("▶  Start the server:")
    print(f"   python3 {SCRIPTS_DIR}/server.py")
    print()
    port = config.get("server", {}).get("port", 8800)
    print(f"   Then open: http://localhost:{port}/")
    print()
    print("📱 Add to home screen:")
    print("   iOS Safari  → Share → Add to Home Screen")
    print("   Android     → Chrome menu → Add to Home Screen")
    print()
    if public_key:
        print(f"🔔 VAPID public key: {public_key[:40]}...")
        print()

    print("🛠  systemd service (Linux):")
    print("   See README.md for systemd/launchd setup instructions.")
    print()


if __name__ == "__main__":
    main()
