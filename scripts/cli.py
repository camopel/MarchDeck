#!/usr/bin/env python3
"""march-deck CLI — project management commands.

Usage:
    march-deck new <app-name>     Create a new app from template
    march-deck serve              Start the server
    march-deck build              Build all app frontends
    march-deck help               Show this help
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = REPO_DIR / "templates" / "app"
APPS_DIR = REPO_DIR / "apps"


def _slugify(name: str) -> str:
    """Convert name to a valid app id (lowercase, hyphens)."""
    s = re.sub(r"[^a-zA-Z0-9\s-]", "", name.strip().lower())
    return re.sub(r"[\s_]+", "-", s).strip("-")


def cmd_new(args: list[str]) -> None:
    if not args:
        print("Usage: march-deck new <app-name>")
        print("  e.g. march-deck new stock-tracker")
        sys.exit(1)

    raw_name = " ".join(args)
    app_id = _slugify(raw_name)
    if not app_id:
        print(f"❌ Invalid app name: {raw_name}")
        sys.exit(1)

    dest = APPS_DIR / app_id
    if dest.exists():
        print(f"❌ App already exists: {dest}")
        sys.exit(1)

    if not TEMPLATES_DIR.exists():
        print(f"❌ Template not found at {TEMPLATES_DIR}")
        sys.exit(1)

    # Copy template
    shutil.copytree(str(TEMPLATES_DIR), str(dest))

    # Replace placeholders in all files
    title = raw_name.title() if raw_name != app_id else app_id.replace("-", " ").title()
    replacements = {
        "my-app": app_id,
        "My App": title,
    }

    for root, _dirs, files in os.walk(dest):
        for fname in files:
            fpath = Path(root) / fname
            if fpath.suffix in (".py", ".ts", ".tsx", ".json", ".css", ".html"):
                try:
                    text = fpath.read_text()
                    for old, new in replacements.items():
                        text = text.replace(old, new)
                    fpath.write_text(text)
                except (UnicodeDecodeError, PermissionError):
                    pass

    print(f"✅ Created app: apps/{app_id}/")
    print(f"   Backend:  apps/{app_id}/backend/routes.py")
    print(f"   Frontend: apps/{app_id}/frontend/src/App.tsx")
    print()
    print("Next steps:")
    print(f"  1. Edit apps/{app_id}/app.json (icon, description)")
    print(f"  2. cd apps/{app_id}/frontend && npm install && npm run dev")
    print(f"  3. Restart the server to mount the backend")


def cmd_serve(_args: list[str]) -> None:
    server = REPO_DIR / "scripts" / "server.py"
    os.execvp(sys.executable, [sys.executable, str(server)] + _args)


def cmd_build(_args: list[str]) -> None:
    # Build shell frontend
    shell_dir = REPO_DIR / "frontend"
    if (shell_dir / "package.json").exists():
        print("🔨 Building shell frontend...")
        subprocess.run(["npm", "install", "--silent"], cwd=shell_dir, check=True)
        subprocess.run(["npm", "run", "build"], cwd=shell_dir, check=True)

    # Build each app frontend
    for app_dir in sorted(APPS_DIR.iterdir()):
        fe = app_dir / "frontend"
        if (fe / "package.json").exists():
            print(f"🔨 Building {app_dir.name}...")
            subprocess.run(["npm", "install", "--silent"], cwd=fe, check=True)
            subprocess.run(["npm", "run", "build"], cwd=fe, check=True)

    print("✅ All frontends built")


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("help", "--help", "-h"):
        print(__doc__)
        sys.exit(0)

    cmd = args[0]
    rest = args[1:]

    commands = {
        "new": cmd_new,
        "serve": cmd_serve,
        "build": cmd_build,
    }

    fn = commands.get(cmd)
    if fn is None:
        print(f"❌ Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)

    fn(rest)


if __name__ == "__main__":
    main()
