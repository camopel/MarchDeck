"""Video Cast — March Deck backend routes.

Mounted at /api/app/cast by March Deck server.py.

Endpoints:
  GET  /health
  GET  /devices              — discover Chromecast devices on LAN
  POST /extract              — extract m3u8 URL from olevod page
  POST /cast                 — cast m3u8 to Chromecast device
  GET  /status               — current playback status
  POST /control              — play/pause/stop/seek/volume
  GET  /tv/status            — TV power state
  POST /tv/power             — toggle TV power on/off
  POST /tv/pair/start        — start pairing (shows PIN on TV)
  POST /tv/pair/finish       — finish pairing with PIN
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

import pychromecast
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()

# ── Globals (module-level singletons) ────────────────────────────────────────

_cast: Optional[pychromecast.Chromecast] = None
_cast_lock = threading.Lock()


# ── Pydantic models ─────────────────────────────────────────────────────────

class ExtractRequest(BaseModel):
    url: str


class CastRequest(BaseModel):
    device_name: str
    m3u8_url: str
    title: str = ""
    poster: str = ""


class ControlRequest(BaseModel):
    action: str  # play, pause, stop, seek, volume_up, volume_down, mute, unmute, volume_set
    value: Optional[float] = None


class PairFinishRequest(BaseModel):
    pin: str


# ── Android TV Remote (power control) ───────────────────────────────────────

_CERT_DIR = Path(__file__).resolve().parent.parent / "certs"
_CERTFILE = str(_CERT_DIR / "androidtv.crt")
_KEYFILE = str(_CERT_DIR / "androidtv.key")
_atv_remote = None
_atv_lock = asyncio.Lock() if False else threading.Lock()  # placeholder; real lock below


def _is_paired() -> bool:
    """Check if we have Android TV Remote certs."""
    return os.path.exists(_CERTFILE) and os.path.exists(_KEYFILE)


async def _get_atv_host() -> str:
    """Get the Chromecast host IP. Uses cached cast or discovers."""
    if _cast and _cast.cast_info:
        return _cast.cast_info.host
    # Discover
    devs = await asyncio.get_event_loop().run_in_executor(None, _discover_devices)
    if devs:
        return devs[0]["host"]
    raise ValueError("No Chromecast found on network")


# ── Helpers: Stream extraction ───────────────────────────────────────────────

_CHROMIUM_TAG = "cast-playwright"


def _kill_orphan_playwright():
    """Kill only chromium processes tagged as ours via user-data-dir name."""
    import subprocess
    try:
        result = subprocess.run(
            ["pgrep", "-af", _CHROMIUM_TAG],
            capture_output=True, text=True, timeout=3,
        )
        for line in result.stdout.strip().split('\n'):
            if not line.strip():
                continue
            pid_str = line.split()[0]
            try:
                os.kill(int(pid_str), 9)
            except (ProcessLookupError, PermissionError, ValueError):
                pass
    except Exception:
        pass


def _extract_stream_sync(url: str) -> dict:
    """Use Playwright to load olevod SPA and extract HLS m3u8 URL.

    Accepts URLs like:
      https://www.olevod.com/player/vod/1-80175-1.html
      https://www.olevod.com/details-1-80175.html  (extracts vod id)
    """
    # Parse the URL to get router path
    # player URL: /player/vod/{src}-{id}-{ep}.html
    # details URL: /details-{src}-{id}.html
    m_player = re.search(r'/player/vod/(\d+-\d+-\d+\.html)', url)
    m_details = re.search(r'/details-(\d+)-(\d+)\.html', url)

    if m_player:
        router_path = f"/player/vod/{m_player.group(1)}"
        vod_match = re.search(r'(\d+)-(\d+)-(\d+)', m_player.group(1))
        vod_id = vod_match.group(2) if vod_match else None
    elif m_details:
        src, vid = m_details.group(1), m_details.group(2)
        router_path = f"/player/vod/{src}-{vid}-1.html"
        vod_id = vid
    else:
        raise ValueError(f"Unrecognized olevod URL: {url}")

    # Create a fresh Playwright instance per request (avoids greenlet/thread issues)
    from playwright.sync_api import sync_playwright
    pw = None
    browser = None
    ctx = None
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                f"--{_CHROMIUM_TAG}",
            ],
        )
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            locale="zh-CN",
            viewport={"width": 1920, "height": 1080},
        )
        page = ctx.new_page()

        try:
            from playwright_stealth import stealth_sync
            stealth_sync(page)
        except ImportError:
            pass

        m3u8_urls: list[str] = []
        vod_detail: Optional[dict] = None

        def on_request(req):
            u = req.url
            if ".m3u8" in u and "master" in u:
                m3u8_urls.append(u)

        def on_response(resp):
            nonlocal vod_detail
            u = resp.url
            if "vod/detail" in u and vod_id and vod_id in u:
                try:
                    import json
                    vod_detail = json.loads(resp.text())
                except Exception:
                    pass

        page.on("request", on_request)
        page.on("response", on_response)

        # Load SPA entry
        page.goto("https://www.olevod.com/", timeout=30000)
        time.sleep(3)

        # Navigate via Vue router to player
        page.evaluate(f"""() => {{
            const app = document.querySelector('#app');
            const router = app.__vue_app__.config.globalProperties.$router;
            router.push('{router_path}');
        }}""")

        # Wait for player to init and m3u8 to be fetched
        deadline = time.time() + 25
        while time.time() < deadline and not m3u8_urls:
            time.sleep(1)

        # Get video info
        video_info = page.evaluate("""() => {
            const v = document.querySelector('video');
            if (!v) return null;
            return {
                duration: v.duration || 0,
                poster: v.poster || '',
                paused: v.paused,
            };
        }""")

        # If vod_detail wasn't captured from network, fetch it via Playwright
        if not vod_detail and vod_id:
            try:
                vod_detail_str = page.evaluate(f"""async () => {{
                    try {{
                        const resp = await fetch('/api/v1/pub/vod/detail/{vod_id}/false');
                        if (resp.ok) return await resp.text();
                    }} catch(e) {{}}
                    try {{
                        const resp = await fetch('https://api.olelive.com/v1/pub/vod/detail/{vod_id}/false');
                        if (resp.ok) return await resp.text();
                    }} catch(e) {{}}
                    return null;
                }}""")
                if vod_detail_str:
                    import json as _json
                    vod_detail = _json.loads(vod_detail_str)
            except Exception as e:
                log.warning(f"Playwright VOD detail fetch failed: {e}")

        # Fallback: extract title from page DOM
        if not vod_detail:
            try:
                page_title = page.evaluate("""() => {
                    const app = document.querySelector('#app');
                    if (app && app.__vue_app__) {
                        const stores = app.__vue_app__.config.globalProperties;
                        try {
                            const pinia = stores.$pinia;
                            if (pinia) {
                                for (const [key, store] of Object.entries(pinia.state.value || {})) {
                                    const s = store;
                                    if (s && s.vodInfo && s.vodInfo.name) return s.vodInfo.name;
                                    if (s && s.name) return s.name;
                                }
                            }
                        } catch(e) {}
                    }
                    const t = document.title;
                    if (t && t !== '欧乐影院') return t.split(' - ')[0];
                    return '';
                }""")
                if page_title:
                    vod_detail = {"data": {"name": page_title}}
            except Exception as e:
                log.warning(f"DOM title extraction failed: {e}")

        # Extract title from vod_detail
        title = ""
        poster = ""
        episodes = []
        if vod_detail and "data" in vod_detail:
            d = vod_detail["data"]
            title = d.get("name", "")
            pic = d.get("pic", "")
            if pic and not pic.startswith("http"):
                poster = f"https://static.olelive.com/{pic}"
            else:
                poster = pic
            for ep in d.get("urls", []):
                episodes.append({
                    "index": ep.get("index", 0),
                    "title": ep.get("title", ""),
                })

        if not poster and video_info and video_info.get("poster"):
            poster = video_info["poster"]

        result = {
            "m3u8_url": m3u8_urls[0] if m3u8_urls else None,
            "title": title,
            "poster": poster,
            "duration": video_info.get("duration", 0) if video_info else 0,
            "episodes": episodes,
        }
        return result
    finally:
        for obj in [ctx, browser]:
            try:
                if obj:
                    obj.close()
            except Exception:
                pass
        try:
            if pw:
                pw.stop()
        except Exception:
            pass
        # Kill any leaked chromium with our tag in their command line
        _kill_orphan_playwright()


# ── Helpers: Chromecast ──────────────────────────────────────────────────────

def _discover_devices() -> list[dict]:
    """Discover Chromecast devices on LAN."""
    chromecasts, browser = pychromecast.get_chromecasts()
    devices = []
    for cc in chromecasts:
        ci = cc.cast_info
        devices.append({
            "name": cc.name,
            "model": cc.model_name,
            "uuid": str(cc.uuid),
            "host": ci.host if ci else "",
            "port": ci.port if ci else 0,
        })
    pychromecast.discovery.stop_discovery(browser)
    return devices


_zconf = None
_cast_browser = None

def _get_cast(device_name: str) -> pychromecast.Chromecast:
    """Get or create a Chromecast connection."""
    global _cast, _zconf, _cast_browser
    with _cast_lock:
        if _cast is not None and _cast.name == device_name:
            try:
                if _cast.socket_client.is_connected:
                    return _cast
            except Exception:
                _cast = None

        # Discover and connect
        chromecasts, browser = pychromecast.get_chromecasts()
        # Don't stop discovery immediately — find our target first
        target = None
        for cc in chromecasts:
            if cc.name == device_name:
                target = cc
                break

        if not target:
            pychromecast.discovery.stop_discovery(browser)
            raise ValueError(f"Chromecast '{device_name}' not found on network")

        # Wait for connection with browser still active
        target.wait(timeout=10)
        _cast = target
        # Now safe to stop discovery
        pychromecast.discovery.stop_discovery(browser)
        return _cast


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/devices")
async def devices():
    """Discover Chromecast devices on LAN."""
    try:
        devs = await asyncio.get_event_loop().run_in_executor(None, _discover_devices)
        return {"devices": devs}
    except Exception as e:
        log.exception("Device discovery failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/extract")
async def extract(req: ExtractRequest):
    """Extract HLS m3u8 URL from an olevod page."""
    try:
        result = await asyncio.get_event_loop().run_in_executor(
            None, _extract_stream_sync, req.url
        )
        if not result.get("m3u8_url"):
            raise HTTPException(status_code=404, detail="Could not extract stream URL")
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("Stream extraction failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cast")
async def cast(req: CastRequest):
    """Cast an m3u8 URL to a Chromecast device. Auto-powers on TV if off."""
    # Turn on TV first if it's off
    if _is_paired():
        try:
            from androidtvremote2 import AndroidTVRemote
            host = await _get_atv_host()
            remote = AndroidTVRemote("March Deck", _CERTFILE, _KEYFILE, host)
            await remote.async_connect()
            if not remote.is_on:
                log.info("TV is off — powering on before casting")
                remote.send_key_command("POWER")
                await asyncio.sleep(5)  # give TV time to wake up
            remote.disconnect()
        except Exception as e:
            log.warning(f"TV power-on check failed (continuing with cast): {e}")

    try:
        def _do_cast():
            cc = _get_cast(req.device_name)
            mc = cc.media_controller
            mc.play_media(
                req.m3u8_url,
                "application/x-mpegURL",
                title=req.title or "Video Cast",
                thumb=req.poster or None,
            )
            # Don't block for too long — just fire and return
            mc.block_until_active(timeout=10)
            return {"status": "casting", "device": req.device_name}

        return await asyncio.get_event_loop().run_in_executor(None, _do_cast)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        log.exception("Cast failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def status():
    """Get current playback status from connected Chromecast."""
    global _cast
    if _cast is None:
        return {"state": "idle"}

    try:
        def _get_status():
            mc = _cast.media_controller
            ms = mc.status
            return {
                "state": str(ms.player_state).lower() if ms.player_state else "idle",
                "title": ms.title or "",
                "current_time": ms.current_time or 0,
                "duration": ms.duration or 0,
                "volume": _cast.status.volume_level if _cast.status else 0,
                "muted": _cast.status.volume_muted if _cast.status else False,
                "thumb": ms.images[0].url if ms.images else "",
            }

        return await asyncio.get_event_loop().run_in_executor(None, _get_status)
    except Exception as e:
        log.warning(f"Status error: {e}")
        return {"state": "idle"}


@router.post("/control")
async def control(req: ControlRequest):
    """Control playback on Chromecast."""
    global _cast
    action = req.action.lower()

    # Volume/mute goes through Android TV Remote — doesn't need active cast
    if action in ("volume_up", "volume_down", "mute", "unmute", "volume_set"):
        return await _atv_volume_control(action, req.value)

    if _cast is None:
        raise HTTPException(status_code=400, detail="No active Chromecast connection")

    def _do_control():
        mc = _cast.media_controller
        action = req.action.lower()

        if action == "play":
            mc.play()
        elif action == "pause":
            mc.pause()
        elif action == "stop":
            mc.stop()
            return {"status": "stopped"}
        elif action == "seek":
            if req.value is None:
                raise ValueError("seek requires a value (offset in seconds)")
            current = mc.status.current_time or 0
            target = max(0, current + req.value)
            mc.seek(target)
        else:
            raise ValueError(f"Unknown action: {action}")

        return {"status": "ok", "action": action}

    try:
        return await asyncio.get_event_loop().run_in_executor(None, _do_control)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("Control failed")
        raise HTTPException(status_code=500, detail=str(e))


# ── TV Power (Android TV Remote) ────────────────────────────────────────────

async def _get_atv_remote():
    """Create a connected Android TV Remote instance."""
    if not _is_paired():
        raise ValueError("Not paired with TV. Pair first for volume/power control.")
    from androidtvremote2 import AndroidTVRemote
    host = await _get_atv_host()
    remote = AndroidTVRemote("March Deck", _CERTFILE, _KEYFILE, host)
    await remote.async_connect()
    return remote


async def _atv_volume_control(action: str, value=None):
    """Use Android TV Remote for real TV volume control."""
    try:
        remote = await _get_atv_remote()
        if action == "volume_up":
            remote.send_key_command("VOLUME_UP")
        elif action == "volume_down":
            remote.send_key_command("VOLUME_DOWN")
        elif action == "mute" or action == "unmute":
            remote.send_key_command("MUTE")
        elif action == "volume_set":
            pass
        remote.disconnect()
        return {"status": "ok", "action": action}
    except Exception as e:
        log.warning(f"ATV volume control failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class KeyRequest(BaseModel):
    key: str  # HOME, BACK, DPAD_UP, DPAD_DOWN, DPAD_LEFT, DPAD_RIGHT, DPAD_CENTER, MENU


async def _atv_send_key(key: str):
    """Send a key command via Android TV Remote."""
    try:
        remote = await _get_atv_remote()
        remote.send_key_command(key.upper())
        remote.disconnect()
        return {"status": "ok", "key": key}
    except Exception as e:
        log.warning(f"ATV key command failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/tv/status")
async def tv_status():
    """Check TV power state and pairing status."""
    paired = _is_paired()
    if not paired:
        return {"paired": False, "is_on": None}

    try:
        from androidtvremote2 import AndroidTVRemote
        host = await _get_atv_host()
        remote = AndroidTVRemote("March Deck", _CERTFILE, _KEYFILE, host)
        await remote.async_connect()
        is_on = remote.is_on
        remote.disconnect()
        return {"paired": True, "is_on": is_on}
    except Exception as e:
        log.warning(f"TV status check failed: {e}")
        return {"paired": paired, "is_on": None, "error": str(e)}


@router.post("/tv/power")
async def tv_power():
    """Toggle TV power (on/off)."""
    if not _is_paired():
        raise HTTPException(status_code=400, detail="Not paired. Pair with the TV first.")

    try:
        from androidtvremote2 import AndroidTVRemote
        host = await _get_atv_host()
        remote = AndroidTVRemote("March Deck", _CERTFILE, _KEYFILE, host)
        await remote.async_connect()
        is_on_before = remote.is_on
        remote.send_key_command("POWER")
        # Give it a moment
        await asyncio.sleep(1)
        is_on_after = remote.is_on
        remote.disconnect()
        return {
            "status": "ok",
            "was_on": is_on_before,
            "is_on": is_on_after,
        }
    except Exception as e:
        log.exception("TV power toggle failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tv/pair/start")
async def tv_pair_start():
    """Start Android TV Remote pairing. Shows a PIN on the TV screen."""
    try:
        from androidtvremote2 import AndroidTVRemote

        _CERT_DIR.mkdir(parents=True, exist_ok=True)
        host = await _get_atv_host()

        remote = AndroidTVRemote("March Deck", _CERTFILE, _KEYFILE, host)
        await remote.async_generate_cert_if_missing()
        await remote.async_start_pairing()

        # Store remote in module-level for finish step
        global _atv_remote
        _atv_remote = remote

        return {"status": "pairing_started", "message": "Check your TV for a PIN code"}
    except Exception as e:
        log.exception("Pairing start failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tv/pair/finish")
async def tv_pair_finish(req: PairFinishRequest):
    """Finish pairing with the PIN shown on TV."""
    global _atv_remote
    if _atv_remote is None:
        raise HTTPException(status_code=400, detail="No pairing in progress. Call /tv/pair/start first.")

    try:
        await _atv_remote.async_finish_pairing(req.pin)
        # Verify connection works
        await _atv_remote.async_connect()
        is_on = _atv_remote.is_on
        _atv_remote.disconnect()
        _atv_remote = None
        return {"status": "paired", "is_on": is_on}
    except Exception as e:
        _atv_remote = None
        log.exception("Pairing finish failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/tv/key")
async def tv_key(req: KeyRequest):
    """Send a remote key command to the TV (HOME, BACK, DPAD_*, etc.)."""
    return await _atv_send_key(req.key)
