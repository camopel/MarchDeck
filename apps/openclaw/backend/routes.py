"""OpenClaw — admin app for March Deck.

Mounted at /api/app/openclaw by March Deck server.py.

Key use case: when openclaw.json is broken and the OC gateway won't start,
this app (running on March Deck) lets you view, edit, diff, and restore config.

Uses OpenOpenClaw's native .bak rotation for backups (openclaw.json.bak, .bak.1, .bak.2, ...).

Endpoints:
  GET  /health
  GET  /config              — current openclaw.json
  PUT  /config              — save openclaw.json (auto-backup before save)
  GET  /config/backups      — list available .bak files
  POST /config/backup       — create a manual backup
  POST /config/restore      — restore from a named backup
  GET  /config/diff/:name   — diff current vs a backup
  GET  /status              — `openclaw status`
  GET  /doctor              — `openclaw doctor`
  POST /restart             — `openclaw gateway restart`
  POST /upgrade             — git pull + npm update + restart
  GET  /version             — openclaw version
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)
router = APIRouter()

OC_CONFIG = Path.home() / ".openclaw" / "openclaw.json"
OC_DIR = Path.home() / ".openclaw"
OC_REPO = Path.home() / "Workspace" / "openclaw"

# Max .bak files to keep (matches OpenOpenClaw's own rotation)
MAX_BAK_FILES = 5

# ── Helpers ──────────────────────────────────────────────────────────

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[^[\]]*")


def strip_ansi(s: str) -> str:
    return ANSI_RE.sub("", s)


async def run_cmd(cmd: str, timeout: float = 30) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "Command timed out"
    text = stdout.decode("utf-8", errors="replace") if stdout else ""
    return proc.returncode or 0, strip_ansi(text)


def _list_bak_files() -> list[Path]:
    """List all .bak* files for openclaw.json, sorted newest first."""
    bak_files = []
    for f in OC_DIR.iterdir():
        if f.name.startswith("openclaw.json.bak") or f.name.startswith("openclaw.json.pre-"):
            bak_files.append(f)
    # Sort by modification time, newest first
    bak_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return bak_files


def _rotate_bak() -> str | None:
    """Create a .bak backup using OpenOpenClaw's rotation scheme.

    Shifts .bak → .bak.1 → .bak.2 → ... and copies current config to .bak.
    Returns the backup filename or None.
    """
    if not OC_CONFIG.exists():
        return None

    # Shift existing numbered backups up
    for i in range(MAX_BAK_FILES - 1, 0, -1):
        src = OC_DIR / f"openclaw.json.bak.{i}"
        dst = OC_DIR / f"openclaw.json.bak.{i + 1}"
        if src.exists():
            if i + 1 >= MAX_BAK_FILES:
                src.unlink()  # Drop oldest
            else:
                shutil.move(str(src), str(dst))

    # Shift .bak → .bak.1
    bak = OC_DIR / "openclaw.json.bak"
    if bak.exists():
        shutil.move(str(bak), str(OC_DIR / "openclaw.json.bak.1"))

    # Copy current → .bak
    shutil.copy2(str(OC_CONFIG), str(bak))
    return "openclaw.json.bak"


def _json_diff(a: dict, b: dict, path: str = "") -> list[str]:
    """Simple recursive diff between two JSON objects."""
    diffs = []
    all_keys = set(list(a.keys()) + list(b.keys()))
    for key in sorted(all_keys):
        p = f"{path}.{key}" if path else key
        if key not in a:
            diffs.append(f"+ {p}: {json.dumps(b[key], ensure_ascii=False)[:120]}")
        elif key not in b:
            diffs.append(f"- {p}: {json.dumps(a[key], ensure_ascii=False)[:120]}")
        elif a[key] != b[key]:
            if isinstance(a[key], dict) and isinstance(b[key], dict):
                diffs.extend(_json_diff(a[key], b[key], p))
            else:
                old = json.dumps(a[key], ensure_ascii=False)[:80]
                new = json.dumps(b[key], ensure_ascii=False)[:80]
                diffs.append(f"~ {p}:\n    old: {old}\n    new: {new}")
    return diffs


# ── Routes ───────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    return {"status": "ok"}


# ── Config CRUD ──────────────────────────────────────────────────────

@router.get("/config")
async def get_config():
    if not OC_CONFIG.exists():
        raise HTTPException(404, "openclaw.json not found")
    try:
        data = json.loads(OC_CONFIG.read_text())
        return JSONResponse(data)
    except Exception as e:
        # Return raw text if JSON is broken — this is the recovery scenario
        return JSONResponse({
            "error": f"Config is invalid JSON: {e}",
            "raw": OC_CONFIG.read_text()[:50000],
        }, status_code=422)


@router.put("/config")
async def put_config(body: dict = Body(...)):
    """Save openclaw.json. Auto-creates .bak backup before overwriting."""
    backup = _rotate_bak()
    try:
        text = json.dumps(body, indent=2, ensure_ascii=False) + "\n"
        OC_CONFIG.write_text(text)
        return {"ok": True, "size": len(text), "backup": backup}
    except Exception as e:
        raise HTTPException(500, f"Failed to write config: {e}")


# ── Config Backups ───────────────────────────────────────────────────

@router.get("/config/backups")
async def list_backups():
    bak_files = _list_bak_files()
    backups = []
    for f in bak_files:
        stat = f.stat()
        backups.append({
            "name": f.name,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return JSONResponse({"backups": backups, "count": len(backups)})


@router.post("/config/backup")
async def create_backup():
    name = _rotate_bak()
    if not name:
        raise HTTPException(404, "No config file to back up")
    return {"ok": True, "name": name}


@router.post("/config/restore")
async def restore_backup(name: str = Body(..., embed=True)):
    """Restore config from a .bak file. Rotates current config first."""
    backup_path = OC_DIR / name
    if not backup_path.exists() or not name.startswith("openclaw.json."):
        raise HTTPException(404, f"Backup not found: {name}")

    # Validate the backup is valid JSON
    try:
        data = json.loads(backup_path.read_text())
    except Exception as e:
        raise HTTPException(422, f"Backup is invalid JSON: {e}")

    # Rotate current config before restoring
    _rotate_bak()

    # Restore
    shutil.copy2(str(backup_path), str(OC_CONFIG))
    return {"ok": True, "restored": name, "keys": list(data.keys())}


@router.get("/config/diff/{name}")
async def diff_backup(name: str):
    """Show diff between current config and a .bak file."""
    backup_path = OC_DIR / name
    if not backup_path.exists() or not name.startswith("openclaw.json."):
        raise HTTPException(404, f"Backup not found: {name}")

    try:
        current = json.loads(OC_CONFIG.read_text())
    except Exception:
        return JSONResponse({"error": "Current config is invalid JSON", "diff": []})

    try:
        backup = json.loads(backup_path.read_text())
    except Exception:
        return JSONResponse({"error": "Backup is invalid JSON", "diff": []})

    diffs = _json_diff(backup, current)
    return {"diff": diffs, "changes": len(diffs)}


# ── Chats (channel transcripts) ─────────────────────────────────────

def _load_sessions_store() -> dict:
    store_path = Path.home() / ".openclaw" / "agents" / "main" / "sessions" / "sessions.json"
    if not store_path.exists():
        return {}
    return json.loads(store_path.read_text())


@router.get("/channels")
async def list_channels():
    """List Matrix channel sessions with their labels."""
    store = _load_sessions_store()

    # Build a room-id → label map from openclaw config groups
    room_labels: dict[str, str] = {}
    try:
        oc = json.loads(OC_CONFIG.read_text())
        groups = oc.get("channels", {}).get("matrix", {}).get("groups", {})
        for room_id, info in groups.items():
            if isinstance(info, dict) and info.get("label"):
                room_labels[room_id.lower()] = info["label"]
    except Exception:
        pass

    channels = []
    for key, val in store.items():
        if not isinstance(val, dict):
            continue
        chat_type = val.get("chatType", "")
        if chat_type == "channel":
            # Try displayName → config label → fallback
            label = val.get("displayName") or ""
            if not label or label.startswith("matrix:g-"):
                # Try matching room ID from the key
                for room_id, room_label in room_labels.items():
                    if room_id.lower() in key.lower():
                        label = room_label
                        break
            if not label or label.startswith("matrix:g-"):
                label = key.split(":")[-1][:30]
            channels.append({
                "key": key,
                "label": label,
                "sessionId": val.get("sessionId", ""),
            })
        elif key.endswith(":main") and chat_type == "direct":
            channels.append({
                "key": key,
                "label": "Main (system)",
                "sessionId": val.get("sessionId", ""),
            })
    # Deduplicate by sessionId (keep the one with the best label)
    seen: dict[str, dict] = {}
    for c in channels:
        sid = c["sessionId"]
        # Strip "matrix:" prefix from labels
        lbl = c["label"]
        if lbl.startswith("matrix:"):
            lbl = lbl[7:]
            c["label"] = lbl
        if sid not in seen or (len(c["label"]) > 2 and True):
            seen[sid] = c

    # Filter out channels with no meaningful label (orphan sessions)
    result = [c for c in seen.values()
              if not c["label"].startswith("g-")]
    result.sort(key=lambda c: (0 if "main" in c["label"].lower() else 1, c["label"]))
    return JSONResponse({"channels": result})


@router.get("/channels/{channel_key:path}/history")
async def channel_history(channel_key: str, limit: int = 60):
    """Read recent messages from a channel transcript."""
    store = _load_sessions_store()
    target = store.get(channel_key) or store.get(channel_key.lower())
    if not target:
        raise HTTPException(404, f"Channel not found: {channel_key}")

    session_id = target.get("sessionId")
    if not session_id:
        raise HTTPException(500, "Channel has no session ID")

    sessions_dir = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
    transcript = sessions_dir / f"{session_id}.jsonl"
    if not transcript.exists():
        return JSONResponse({"messages": [], "note": "No transcript file"})

    lines = transcript.read_text().strip().split("\n")
    messages = []
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        if entry.get("type") != "message":
            continue

        msg = entry.get("message", {})
        role = msg.get("role", "unknown")
        ts = entry.get("timestamp")

        # Skip toolResult entirely
        if role in ("tool", "toolResult"):
            continue

        content = msg.get("content", "")

        if isinstance(content, list):
            parts = []
            for p in content:
                if isinstance(p, dict) and p.get("type") == "text":
                    t = p.get("text", "")
                    if t.strip():
                        parts.append(t[:3000] + "…" if len(t) > 3000 else t)
                # Skip toolCall parts silently — they're internal
            content = "\n".join(parts)
        elif isinstance(content, str) and len(content) > 3000:
            content = content[:3000] + "…"

        # For user messages: strip system/metadata noise, keep only human text
        if role == "user" and content:
            # Remove ALL "System: [timestamp] ..." lines (exec notifications, Matrix msgs, etc.)
            content = re.sub(
                r"System:\s*\[[^\]]*\]\s*[^\n]*",
                "", content,
            )
            # Remove conversation info JSON blocks
            content = re.sub(
                r"Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*",
                "", content,
            )
            # Remove sender metadata JSON blocks
            content = re.sub(
                r"Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*",
                "", content,
            )
            # Remove queued message headers
            content = re.sub(r"\[Queued messages[^\]]*\]\s*---\s*", "", content)
            content = re.sub(r"Queued #\d+\s*", "", content)
            # Remove leftover "---" separators
            content = re.sub(r"^---\s*$", "", content, flags=re.MULTILINE)
            # Remove session startup instructions (internal)
            content = re.sub(
                r"A new session was started via /new or /reset\.[\s\S]*",
                "", content,
            )
            # Remove heartbeat prompts
            content = re.sub(
                r"Read HEARTBEAT\.md if it exists[\s\S]*?HEARTBEAT_OK\.",
                "", content,
            )
            # Remove "Current time: ..." lines
            content = re.sub(r"Current time:.*", "", content)
            # Remove openclaw internal tags like <<HUMAN_CONVERSATION_START>>
            content = re.sub(r"<<\w+>>", "", content)
            # Collapse excessive blank lines
            content = re.sub(r"\n{3,}", "\n\n", content)
            content = content.strip()

        if not content or not content.strip():
            continue

        messages.append({
            "role": role,
            "content": content,
            "ts": ts,
            "model": msg.get("model") or entry.get("model"),
        })

    return JSONResponse({"messages": messages[-limit:], "count": len(messages)})


# ── Status / Doctor ──────────────────────────────────────────────────

@router.get("/status")
async def get_status():
    code, text = await run_cmd("openclaw status", timeout=20)
    return {"returncode": code, "output": text}


@router.get("/doctor")
async def get_doctor():
    code, text = await run_cmd("openclaw doctor", timeout=30)
    return {"returncode": code, "output": text}


# ── Service control ──────────────────────────────────────────────────

@router.post("/restart")
async def restart_gateway():
    code, text = await run_cmd("openclaw gateway restart", timeout=15)
    return {"returncode": code, "output": text}


@router.post("/upgrade")
async def upgrade():
    """Run `openclaw update --yes` which handles git fetch/rebase/install/build/doctor."""
    code, text = await run_cmd("openclaw update --yes", timeout=300)
    return {"returncode": code, "output": text}


@router.get("/version")
async def get_version():
    code, text = await run_cmd("openclaw --version", timeout=5)
    return {"version": text.strip(), "returncode": code}
