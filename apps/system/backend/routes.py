"""System Monitor — March Deck backend.

Mounted at /api/app/system by server.py.

Endpoints:
  GET /stats    — CPU, RAM, disk, GPU, uptime, services
  GET /cron     — Scheduled jobs (OpenClaw cron + systemd timers)
  POST /action/restart  — Reboot system
  POST /action/shutdown — Shutdown system
  POST /action/update   — Run system updates (apt/brew)

Performance notes:
- GPU, CPU, RAM, disk fetched in parallel via ThreadPoolExecutor
- Service status cached for 15s
- nvidia-smi is the authoritative GPU source; AMD sysfs as supplement
- Cross-platform: Linux (systemd) + macOS (launchd)
"""
from __future__ import annotations

import asyncio
import glob
import os
import platform
import shutil
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

# ── Thread pool for blocking I/O ─────────────────────────────────────
_executor = ThreadPoolExecutor(max_workers=6)

# ── Service cache (refresh every 15s) ────────────────────────────────
_svc_cache: list[dict] = []
_svc_cache_ts: float = 0.0
_SVC_CACHE_TTL = 15.0


def _run(cmd: list[str], timeout: int = 5) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


# ── GPU via nvidia-smi ────────────────────────────────────────────────

def _fetch_nvidia_gpu() -> list[dict]:
    """Query nvidia-smi for all GPU stats. Returns list (one entry per GPU)."""
    if not shutil.which("nvidia-smi"):
        return []
    try:
        r = _run([
            "nvidia-smi",
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,"
                        "temperature.gpu,power.draw,power.limit",
            "--format=csv,noheader,nounits",
        ])
        if r.returncode != 0 or not r.stdout.strip():
            return []
        result = []
        for line in r.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 7:
                continue
            def _fv(s: str) -> float | None:
                return float(s) if s not in ("[N/A]", "N/A", "") else None
            result.append({
                "name": parts[0],
                "utilization_percent": _fv(parts[1]),
                "memory_used_mb": _fv(parts[2]),
                "memory_total_mb": _fv(parts[3]),
                "temperature_c": _fv(parts[4]),
                "power_draw_w": _fv(parts[5]),
                "power_limit_w": _fv(parts[6]),
            })
        return result
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []


def _fetch_amd_gpus() -> list[dict]:
    """Read AMD GPU stats from sysfs. Skips if nothing found."""
    result = []
    try:
        for card_path in glob.glob("/sys/class/drm/card*/device/gpu_busy_percent"):
            device_dir = os.path.dirname(card_path)

            def _rsi(p: str) -> int | None:
                try:
                    with open(p) as f:
                        return int(f.read().strip())
                except Exception:
                    return None

            util = _rsi(card_path)
            vram_used = _rsi(os.path.join(device_dir, "mem_info_vram_used"))
            vram_total = _rsi(os.path.join(device_dir, "mem_info_vram_total"))
            temp: float | None = None
            try:
                hwmon_paths = glob.glob(os.path.join(device_dir, "hwmon", "hwmon*", "temp1_input"))
                if hwmon_paths:
                    raw = _rsi(hwmon_paths[0])
                    if raw is not None:
                        temp = raw / 1000.0  # millidegrees → degrees
            except Exception:
                pass

            result.append({
                "name": "AMD GPU",
                "utilization_percent": float(util) if util is not None else None,
                "memory_used_mb": round(vram_used / 1048576, 1) if vram_used else None,
                "memory_total_mb": round(vram_total / 1048576, 1) if vram_total else None,
                "temperature_c": temp,
                "power_draw_w": None,
                "power_limit_w": None,
            })
    except Exception:
        pass
    return result


def _fetch_gpu() -> list[dict] | None:
    """Fetch GPU stats: NVIDIA first (nvidia-smi), AMD sysfs supplemental."""
    nvidia = _fetch_nvidia_gpu()
    amd = _fetch_amd_gpus()
    combined = nvidia + amd
    return combined if combined else None


# ── CPU / RAM / Disk ──────────────────────────────────────────────────

def _fetch_system() -> dict:
    try:
        import psutil
    except ImportError:
        raise RuntimeError("psutil not installed")

    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    cpu_freq = psutil.cpu_freq()
    boot_time = psutil.boot_time()
    cpu_pct = psutil.cpu_percent(interval=None)

    try:
        load_1, load_5, load_15 = os.getloadavg()
    except AttributeError:
        load_1 = load_5 = load_15 = 0.0

    # OS version
    os_version: str | None = None
    try:
        import subprocess as _sp
        r = _sp.run(["lsb_release", "-ds"], capture_output=True, text=True, timeout=3)
        if r.returncode == 0:
            os_version = r.stdout.strip().strip('"')
    except Exception:
        pass

    # NVIDIA driver version
    gpu_driver: str | None = None
    try:
        r = _sp.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            gpu_driver = r.stdout.strip().splitlines()[0].strip()
    except Exception:
        pass

    # CUDA version from version.json
    cuda_version: str | None = None
    try:
        import json as _json
        with open("/usr/local/cuda/version.json") as f:
            vj = _json.load(f)
        cuda_version = vj.get("cuda", {}).get("version", "").split(".")[0:2]
        cuda_version = ".".join(cuda_version) if cuda_version else None
    except Exception:
        pass

    # Kernel version
    kernel_version: str | None = None
    try:
        kernel_version = platform.release()
    except Exception:
        pass

    return {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "os_version": os_version,
        "gpu_driver": gpu_driver,
        "cuda_version": cuda_version,
        "kernel_version": kernel_version,
        "uptime_seconds": int(time.time() - boot_time),
        "cpu": {
            "cores": psutil.cpu_count(logical=False),
            "threads": psutil.cpu_count(logical=True),
            "percent": cpu_pct,
            "freq_mhz": round(cpu_freq.current) if cpu_freq else None,
            "load_1m": round(load_1, 2),
            "load_5m": round(load_5, 2),
            "load_15m": round(load_15, 2),
        },
        "memory": {
            "total": mem.total,
            "used": mem.used,
            "available": mem.available,
            "percent": mem.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
    }


# ── Service discovery (cached) ────────────────────────────────────────

def _get_macos_services() -> list[dict]:
    """Discover launchd user agents on macOS."""
    services: list[dict] = []
    agents_dir = os.path.expanduser("~/Library/LaunchAgents")
    if not os.path.isdir(agents_dir):
        return services

    PATTERNS = ["openclaw", "march", "litellm", "ollama"]
    for fname in sorted(os.listdir(agents_dir)):
        if not fname.endswith(".plist"):
            continue
        label = fname.replace(".plist", "")
        if not any(p in label.lower() for p in PATTERNS):
            continue
        # Check if loaded
        try:
            r = subprocess.run(
                ["launchctl", "list", label],
                capture_output=True, text=True, timeout=3,
            )
            active = r.returncode == 0
        except Exception:
            active = False
        services.append({
            "name": label.split(".")[-1] if "." in label else label,
            "unit": label,
            "active": active,
            "scope": "user",
        })
    return services

def _get_service_statuses_uncached() -> list[dict]:
    """Discover and check service statuses. Called at most every 15s.

    Linux: systemd user/system units + process detection.
    macOS: launchd user agents + process detection.
    """
    if platform.system() == "Darwin":
        return _get_macos_services()
    if platform.system() != "Linux":
        return []

    services: list[dict] = []
    seen: set[str] = set()

    def _display_name(unit: str) -> str:
        return unit.replace(".service", "").replace(".timer", "")

    def _check_unit(unit: str, scope: str) -> dict | None:
        cmd = ["systemctl"]
        if scope == "user":
            cmd.append("--user")
        cmd += ["is-active", unit]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
            return {
                "name": _display_name(unit),
                "unit": unit,
                "active": r.stdout.strip() == "active",
                "scope": scope,
            }
        except Exception:
            return None

    # 1. User systemd units — read unit files directly, batch is-active check
    user_unit_dir = os.path.expanduser("~/.config/systemd/user")
    units_to_check: list[tuple[str, str]] = []

    if os.path.isdir(user_unit_dir):
        for fname in sorted(os.listdir(user_unit_dir)):
            if not (fname.endswith(".service") or fname.endswith(".timer")):
                continue
            base = fname.rsplit(".", 1)[0]
            if fname.endswith(".timer") and base + ".service" in seen:
                continue
            if fname.endswith(".service"):
                timer_path = os.path.join(user_unit_dir, base + ".timer")
                if os.path.exists(timer_path):
                    continue
            try:
                er = subprocess.run(
                    ["systemctl", "--user", "is-enabled", fname],
                    capture_output=True, text=True, timeout=3,
                )
                if er.stdout.strip() in ("disabled", "masked"):
                    continue
            except Exception:
                pass
            units_to_check.append((fname, "user"))
            seen.add(fname)

    # 2. System units — scan for known patterns only
    SYSTEM_PATTERNS = ["openclaw", "matrix", "synapse", "litellm", "ollama"]
    try:
        r = subprocess.run(
            ["systemctl", "list-unit-files", "--type=service", "--no-legend",
             "--no-pager", "--state=enabled,generated"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            for line in r.stdout.strip().splitlines():
                parts = line.split()
                if not parts:
                    continue
                unit = parts[0]
                if any(p in unit.lower() for p in SYSTEM_PATTERNS) and unit not in seen:
                    units_to_check.append((unit, "system"))
                    seen.add(unit)
    except Exception:
        pass

    # Batch all is-active checks in parallel
    with ThreadPoolExecutor(max_workers=min(8, len(units_to_check) or 1)) as pool:
        results = list(pool.map(lambda u: _check_unit(u[0], u[1]), units_to_check))
    services = [r for r in results if r is not None]

    # 3. Process-based detection (no systemd)
    PROCESS_PATTERNS = [
        ("litellm", "litellm.*--port"),
        ("privateapp", r"server\.py.*--port"),
    ]
    for name, pattern in PROCESS_PATTERNS:
        if any(s["name"] == name for s in services):
            continue
        try:
            r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=3)
            if r.stdout.strip():
                services.append({"name": name, "unit": "process", "active": True, "scope": "process"})
        except Exception:
            pass

    return services


def _get_service_statuses() -> list[dict]:
    """Return cached service statuses, refresh if stale."""
    global _svc_cache, _svc_cache_ts
    now = time.monotonic()
    if now - _svc_cache_ts > _SVC_CACHE_TTL:
        _svc_cache = _get_service_statuses_uncached()
        _svc_cache_ts = now
    return _svc_cache


# ── Main stats endpoint ───────────────────────────────────────────────

@router.get("/stats")
async def system_stats():
    """Real-time system stats: CPU, RAM, disk, GPU, uptime.

    GPU and system metrics are fetched in parallel for minimal latency.
    Service status is cached for 15s.
    """
    loop = asyncio.get_event_loop()

    try:
        # Run GPU fetch and system fetch concurrently
        gpu_fut = loop.run_in_executor(_executor, _fetch_gpu)
        sys_fut = loop.run_in_executor(_executor, _fetch_system)
        svc_fut = loop.run_in_executor(_executor, _get_service_statuses)

        gpu, sys_data, services = await asyncio.gather(gpu_fut, sys_fut, svc_fut)
    except RuntimeError as e:
        if "psutil" in str(e):
            raise HTTPException(500, "psutil not installed — run install.py")
        raise

    return {
        **sys_data,
        "gpu": gpu,
        "services": services,
    }


# ── System Actions ────────────────────────────────────────────────────

_IS_MACOS = platform.system() == "Darwin"
_IS_LINUX = platform.system() == "Linux"


@router.post("/action/restart")
async def action_restart():
    """Restart the system."""
    try:
        if _IS_MACOS:
            subprocess.Popen(["sudo", "shutdown", "-r", "now"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(["sudo", "reboot"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"status": "ok", "message": "System is restarting..."}
    except Exception as e:
        raise HTTPException(500, f"Failed to restart: {e}")


@router.post("/action/shutdown")
async def action_shutdown():
    """Shutdown the system."""
    try:
        subprocess.Popen(["sudo", "shutdown", "-h", "now"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"status": "ok", "message": "System is shutting down..."}
    except Exception as e:
        raise HTTPException(500, f"Failed to shutdown: {e}")




# ── Cron Jobs (OpenClaw) ─────────────────────────────────────────────

@router.get("/cron")
async def cron_jobs():
    """List cron/scheduled jobs from OpenClaw + systemd timers. Cached 30s."""
    global _cron_cache, _cron_cache_ts
    now_mono = time.monotonic()
    if _cron_cache is not None and now_mono - _cron_cache_ts < _CRON_CACHE_TTL:
        return {"jobs": _cron_cache}

    import json as _json
    import shutil

    jobs: list[dict] = []
    now_ms = int(time.time() * 1000)

    # 1. OpenClaw cron jobs
    openclaw_bin = shutil.which("openclaw")
    if not openclaw_bin:
        for p in [os.path.expanduser("~/.local/bin/openclaw"), "/usr/local/bin/openclaw"]:
            if os.path.isfile(p):
                openclaw_bin = p
                break
        if not openclaw_bin:
            candidates = glob.glob(os.path.expanduser("~/.local/share/mise/installs/node/*/bin/openclaw"))
            if candidates:
                openclaw_bin = candidates[-1]

    if openclaw_bin:
        try:
            r = subprocess.run(
                [openclaw_bin, "cron", "list", "--json"],
                capture_output=True, text=True, timeout=10,
                env={**os.environ, "HOME": os.path.expanduser("~"), "PATH": os.environ.get("PATH", "") + ":/usr/local/bin:/usr/bin"},
            )
            if r.returncode == 0:
                data = _json.loads(r.stdout)
                for job in data.get("jobs", []):
                    sched = job.get("schedule", {})
                    state = job.get("state", {})
                    expr = sched.get("expr", "")
                    tz = sched.get("tz", "")
                    sched_desc = expr + (f" ({tz.split('/')[-1]})" if tz else "")

                    def _ms_to_rel(ms: int | None, future: bool) -> str | None:
                        if not ms:
                            return None
                        diff = (ms - now_ms) / 1000 if future else (now_ms - ms) / 1000
                        if future and diff < 0:
                            return "overdue"
                        if abs(diff) < 3600:
                            return f"{'in ' if future else ''}{int(abs(diff) / 60)}m{'' if future else ' ago'}"
                        if abs(diff) < 86400:
                            return f"{'in ' if future else ''}{abs(diff) / 3600:.1f}h{'' if future else ' ago'}"
                        return f"{'in ' if future else ''}{abs(diff) / 86400:.1f}d{'' if future else ' ago'}"

                    jobs.append({
                        "id": job.get("id", ""),
                        "name": job.get("name", "unknown"),
                        "description": job.get("description", ""),
                        "source": "openclaw",
                        "enabled": job.get("enabled", False),
                        "schedule": sched_desc,
                        "next_run": _ms_to_rel(state.get("nextRunAtMs"), True),
                        "last_run": _ms_to_rel(state.get("lastRunAtMs"), False),
                        "last_status": state.get("lastStatus", "unknown"),
                        "last_duration_s": round(state.get("lastDurationMs", 0) / 1000, 1),
                        "consecutive_errors": state.get("consecutiveErrors", 0),
                    })
        except Exception:
            pass

    # 2. Systemd user timers
    try:
        r = subprocess.run(
            ["systemctl", "--user", "list-timers", "--no-pager", "--output=json"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0 and r.stdout.strip().startswith("["):
            timer_list = _json.loads(r.stdout)
            now_s = now_ms / 1000
            for t in timer_list:
                unit = t.get("unit", "")
                if not unit.endswith(".timer") or "snap." in unit:
                    continue
                timer_name = unit.replace(".timer", "")
                if any(j["name"] == timer_name for j in jobs):
                    continue
                next_usec = t.get("next")
                last_usec = t.get("last")

                def _usec_to_rel(usec: int | None, future: bool) -> str | None:
                    if not usec or usec <= 0:
                        return None
                    diff = (usec / 1_000_000 - now_s) if future else (now_s - usec / 1_000_000)
                    if future and diff < 0:
                        return "overdue"
                    if abs(diff) < 3600:
                        return f"{'in ' if future else ''}{int(abs(diff) / 60)}m{'' if future else ' ago'}"
                    if abs(diff) < 86400:
                        return f"{'in ' if future else ''}{abs(diff) / 3600:.1f}h{'' if future else ' ago'}"
                    return f"{'in ' if future else ''}{abs(diff) / 86400:.1f}d{'' if future else ' ago'}"

                sched_desc = ""
                try:
                    cat_r = subprocess.run(["systemctl", "--user", "cat", unit], capture_output=True, text=True, timeout=5)
                    for line in cat_r.stdout.splitlines():
                        line = line.strip()
                        if line.startswith("OnCalendar="):
                            sched_desc = line.split("=", 1)[1]
                            break
                        elif line.startswith("OnUnitActiveSec="):
                            sched_desc = f"every {line.split('=', 1)[1]}"
                            break
                except Exception:
                    pass

                active = bool(next_usec and next_usec > 0)
                jobs.append({
                    "id": unit,
                    "name": timer_name,
                    "source": "systemd",
                    "enabled": active,
                    "schedule": sched_desc or "timer",
                    "next_run": _usec_to_rel(next_usec, True),
                    "last_run": _usec_to_rel(last_usec, False),
                    "last_status": "ok" if active else "inactive",
                    "last_duration_s": 0,
                    "consecutive_errors": 0,
                })
    except Exception:
        pass

    _cron_cache = jobs
    _cron_cache_ts = now_mono
    return {"jobs": jobs}


# ── Standalone mode ───────────────────────────────────────────────────
if __name__ == "__main__":
    from fastapi import FastAPI
    import uvicorn

    standalone_app = FastAPI(title="System Monitor")
    standalone_app.include_router(router, prefix="/api/system")
    uvicorn.run(standalone_app, host="0.0.0.0", port=8801)
