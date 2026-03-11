"""March — Chat + Dashboard backend routes.

Proxies session management to March's WS channel REST API.
WebSocket connections are proxied directly to March.

Mounted at /api/app/march by March Deck server.py.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import urllib.request
import urllib.error
from pathlib import Path

import websockets
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Request
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()

# ── Configuration (set by configure() from server.py) ─────────────────────
_MARCH_API_URL = "http://localhost:8101"
_MARCH_WS_URL = "ws://localhost:8101"
_OPENCLAW_WORKSPACE = str(Path.home() / ".openclaw" / "workspace")


def configure(march_api_url: str = "", openclaw_workspace: str = "") -> None:
    """Called by server.py after config is loaded."""
    global _MARCH_API_URL, _MARCH_WS_URL, _OPENCLAW_WORKSPACE
    if march_api_url:
        _MARCH_API_URL = march_api_url.rstrip("/")
        # Derive WS URL from HTTP URL
        _MARCH_WS_URL = _MARCH_API_URL.replace("http://", "ws://").replace("https://", "wss://")
    if openclaw_workspace:
        _OPENCLAW_WORKSPACE = openclaw_workspace


# ── March API helpers ─────────────────────────────────────────────────────

async def _march_get(path: str) -> dict:
    """GET request to March REST API."""
    url = f"{_MARCH_API_URL}{path}"
    try:
        def _do():
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        return await asyncio.to_thread(_do)
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        raise HTTPException(status_code=e.code, detail=body)
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"March agent unavailable: {e}")


async def _march_post(path: str, body: dict | None = None) -> dict:
    """POST request to March REST API."""
    url = f"{_MARCH_API_URL}{path}"
    try:
        def _do():
            data = json.dumps(body or {}).encode()
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        return await asyncio.to_thread(_do)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        raise HTTPException(status_code=e.code, detail=body_text)
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"March agent unavailable: {e}")


async def _march_put(path: str, body: dict) -> dict:
    """PUT request to March REST API."""
    url = f"{_MARCH_API_URL}{path}"
    try:
        def _do():
            data = json.dumps(body).encode()
            req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        return await asyncio.to_thread(_do)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        raise HTTPException(status_code=e.code, detail=body_text)
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"March agent unavailable: {e}")


async def _march_delete(path: str) -> dict:
    """DELETE request to March REST API."""
    url = f"{_MARCH_API_URL}{path}"
    try:
        def _do():
            req = urllib.request.Request(url, method="DELETE")
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        return await asyncio.to_thread(_do)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        raise HTTPException(status_code=e.code, detail=body_text)
    except (urllib.error.URLError, OSError) as e:
        raise HTTPException(status_code=503, detail=f"March agent unavailable: {e}")


# ── Models ────────────────────────────────────────────────────────────────

class CreateSession(BaseModel):
    name: str
    description: str = ""


class RenameSession(BaseModel):
    name: str


class SendMessage(BaseModel):
    content: str


# ── Health ────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    try:
        result = await _march_get("/health")
        return {"status": "ok", "march_connected": True, "march_status": result}
    except HTTPException:
        return {"status": "ok", "march_connected": False}


# ── Sessions CRUD (proxied to March) ─────────────────────────────────────

@router.get("/sessions")
async def list_sessions():
    return await _march_get("/sessions")


@router.post("/sessions")
async def create_session(body: CreateSession):
    return await _march_post("/sessions", {"name": body.name, "description": body.description})


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    return await _march_delete(f"/sessions/{session_id}")


@router.put("/sessions/{session_id}")
async def rename_session(session_id: str, body: RenameSession):
    return await _march_put(f"/sessions/{session_id}", {"name": body.name})


@router.get("/sessions/{session_id}/history")
async def get_history(session_id: str):
    return await _march_get(f"/sessions/{session_id}/history")


# ── Send message via REST (non-streaming) ─────────────────────────────────

@router.post("/sessions/{session_id}/message")
async def send_message(session_id: str, body: SendMessage):
    """Send a message and collect the full response (non-streaming)."""
    try:
        async with websockets.connect(
            f"{_MARCH_WS_URL}/ws/{session_id}",
            open_timeout=5,
            max_size=20_000_000,
        ) as ws:
            await ws.send(json.dumps({
                "type": "message",
                "content": body.content,
            }))

            full_content = ""
            tool_calls = []
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=120)
                    msg = json.loads(raw)
                    mtype = msg.get("type", "")

                    if mtype == "stream.delta":
                        full_content += msg.get("content", "")
                    elif mtype == "tool.start":
                        tool_calls.append({
                            "name": msg.get("name", ""),
                            "args": msg.get("args", {}),
                        })
                    elif mtype == "tool.result":
                        for tc in reversed(tool_calls):
                            if tc["name"] == msg.get("name", ""):
                                tc["result"] = msg.get("result", "")
                                break
                    elif mtype == "stream.end":
                        break
                    elif mtype == "error":
                        full_content += f"\n\n⚠️ Error: {msg.get('message', 'Unknown error')}"
                        break
                except asyncio.TimeoutError:
                    full_content += "\n\n⚠️ Response timed out"
                    break

            return {
                "role": "assistant",
                "content": full_content,
                "tool_calls": tool_calls,
            }
    except (OSError, websockets.exceptions.WebSocketException) as e:
        raise HTTPException(status_code=503, detail=f"March agent not available: {e}")


# ── WebSocket proxy ───────────────────────────────────────────────────────

@router.websocket("/ws/{session_id}")
async def ws_proxy(ws: WebSocket, session_id: str):
    """Proxy WebSocket between frontend and March.

    March handles all session persistence — we just relay messages.
    """
    await ws.accept()

    march_ws = None
    try:
        march_ws = await asyncio.wait_for(
            websockets.connect(
                f"{_MARCH_WS_URL}/ws/{session_id}",
                max_size=20_000_000,
            ),
            timeout=5,
        )
    except Exception as e:
        await ws.send_json({"type": "error", "message": f"Cannot connect to March: {e}"})
        await ws.close(code=4503)
        return

    async def forward_client_to_march():
        try:
            while True:
                data = await ws.receive_text()
                await march_ws.send(data)
        except (WebSocketDisconnect, Exception):
            pass

    async def forward_march_to_client():
        try:
            async for raw in march_ws:
                msg = json.loads(raw)
                await ws.send_json(msg)
        except (websockets.exceptions.ConnectionClosed, Exception):
            pass

    try:
        client_task = asyncio.create_task(forward_client_to_march())
        march_task = asyncio.create_task(forward_march_to_client())

        done, pending = await asyncio.wait(
            [client_task, march_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
    finally:
        if march_ws:
            try:
                await march_ws.close()
            except Exception:
                pass
        try:
            await ws.close()
        except Exception:
            pass


# ── Dashboard endpoints ──────────────────────────────────────────────────

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[^[\]]*")


def _strip_ansi(s: str) -> str:
    return ANSI_RE.sub("", s)


async def _run_cmd(cmd: str, timeout: float = 15) -> tuple[int, str]:
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
    return proc.returncode or 0, _strip_ansi(text)


# ── Service management ────────────────────────────────────────────────

@router.get("/service/status")
async def service_status():
    """Check March systemd service status."""
    code, text = await _run_cmd("systemctl --user is-active march 2>/dev/null || echo 'unknown'")
    is_active = text.strip() == "active"
    return {"active": is_active, "status": text.strip()}



@router.post("/service/restart")
async def service_restart():
    """Restart March systemd service."""
    code, text = await _run_cmd("systemctl --user restart march 2>&1")
    return {"ok": code == 0, "output": text.strip()}


# ── Usage/metrics ─────────────────────────────────────────────────────

@router.get("/usage")
async def usage_stats():
    """Read today's token usage from March turn log."""
    import json as _json
    from datetime import date
    turn_log = Path.home() / ".march" / "logs" / "turns.jsonl"
    today = date.today().isoformat()
    total_input = 0
    total_output = 0
    total_cost = 0.0
    entries = []
    if turn_log.exists():
        for line in turn_log.read_text().strip().split("\n"):
            if not line.strip():
                continue
            try:
                entry = _json.loads(line)
                if entry.get("ts", "").startswith(today):
                    inp = entry.get("input_tokens", 0)
                    out = entry.get("output_tokens", 0)
                    cost = entry.get("cost", 0.0)
                    total_input += inp
                    total_output += out
                    total_cost += cost
                    entries.append({
                        "ts": entry.get("ts"),
                        "session_id": entry.get("session_id", ""),
                        "model": entry.get("model", ""),
                        "input_tokens": inp,
                        "output_tokens": out,
                        "cost": cost,
                    })
            except _json.JSONDecodeError:
                continue
    return {
        "date": today,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cost": round(total_cost, 4),
        "entries": entries[-50:],  # last 50 entries
    }


# ── Config management ─────────────────────────────────────────────────

MARCH_CONFIG = Path.home() / ".march" / "config.yaml"


@router.get("/config")
async def get_config():
    """Read March config."""
    if not MARCH_CONFIG.exists():
        return {"content": "", "exists": False}
    return {"content": MARCH_CONFIG.read_text(), "exists": True}


class ConfigBody(BaseModel):
    content: str


@router.post("/config")
async def save_config(body: ConfigBody):
    """Save March config."""
    MARCH_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    MARCH_CONFIG.write_text(body.content)
    return {"saved": True}


@router.post("/config/backup")
async def backup_config():
    """Backup March config."""
    if not MARCH_CONFIG.exists():
        raise HTTPException(404, "Config not found")
    backup = MARCH_CONFIG.with_suffix(".yaml.bak")
    import shutil
    shutil.copy2(str(MARCH_CONFIG), str(backup))
    return {"backed_up": True, "path": str(backup)}


# ── Logs ──────────────────────────────────────────────────────────────

@router.get("/logs")
async def get_logs(lines: int = 100):
    """Read March logs."""
    # Try journalctl first
    code, text = await _run_cmd(f"journalctl --user -u march --no-pager -n {lines} 2>/dev/null")
    if code == 0 and text.strip():
        return {"lines": text.strip().split("\n"), "source": "journalctl"}
    # Fallback to log files
    log_dir = Path.home() / ".march" / "logs"
    if log_dir.is_dir():
        log_files = sorted(log_dir.glob("*.log"), reverse=True)
        if log_files:
            all_lines = log_files[0].read_text().strip().split("\n")
            return {"lines": all_lines[-lines:], "source": str(log_files[0])}
    return {"lines": [], "source": "none"}
