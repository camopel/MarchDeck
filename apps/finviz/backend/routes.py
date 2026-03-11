"""Finviz — March Deck backend.

Routes (mounted at /api/app/finviz):
  GET  /stats               — DB statistics
  GET  /summary/:period     — Get or generate summary (12h, 24h, weekly)
  GET  /headlines            — Raw headlines for a time range
  GET  /article              — Full article content by URL
  GET  /tickers              — Get ticker list from DB
  POST /tickers              — Add tickers (batch)
  DELETE /tickers            — Remove tickers (batch)
  GET  /article-counts       — Article counts per ticker
  GET  /crawler              — Crawler cron status (enabled/disabled)
  POST /crawler              — Toggle crawler cron on/off
  POST /clean-news           — Delete all downloaded news files + DB rows
  GET  /alert-config         — Get daily alert config
  POST /alert-config         — Save daily alert config
  POST /alert-send           — Trigger alert push notification now
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Body
from pydantic import BaseModel

router = APIRouter()

from commons.constants import DATA_DIR as _DATA_HOME
FINVIZ_DIR = _DATA_HOME / "app" / "finviz"
DEFAULT_DB = str(FINVIZ_DIR / "finviz.db")
DEFAULT_NEWS_DIR = str(FINVIZ_DIR / "news")
SUMMARY_FILE = FINVIZ_DIR / "summary.md"
ALERT_CONFIG_PATH = FINVIZ_DIR / "alert_config.json"
APP_SETTINGS_DIR = _DATA_HOME / "app"

# Cron marker — identifies our cron line
_CRON_MARKER = "# marchdeck-finviz-crawler"
_PROJECT_DIR = Path(__file__).resolve().parent.parent.parent.parent  # MarchDeck root
_CRON_SCRIPT = _PROJECT_DIR / "apps" / "finviz" / "scripts" / "finviz_cron.sh"

_generating: dict[str, bool] = {}


def _get_db() -> str:
    return os.environ.get("FINVIZ_DB", DEFAULT_DB)


def _get_news_dir() -> str:
    return os.environ.get("FINVIZ_ARTICLES_DIR", DEFAULT_NEWS_DIR)


def _db_conn() -> sqlite3.Connection:
    db_path = _get_db()
    if not os.path.exists(db_path):
        raise HTTPException(404, detail="Finviz database not found.")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _tickers_db() -> sqlite3.Connection:
    FINVIZ_DIR.mkdir(parents=True, exist_ok=True)
    db_path = FINVIZ_DIR / "finviz.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("""CREATE TABLE IF NOT EXISTS tickers (
        symbol TEXT PRIMARY KEY,
        keywords TEXT NOT NULL DEFAULT '[]',
        added_at TEXT NOT NULL
    )""")
    conn.commit()
    return conn


def _get_preferences() -> dict:
    db_path = APP_SETTINGS_DIR / "marchdeck.db"
    if not db_path.exists():
        return {"timezone": "America/Los_Angeles", "language": "English"}
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        prefs = {}
        for row in conn.execute("SELECT key, value FROM preferences").fetchall():
            prefs[row["key"]] = row["value"]
        conn.close()
        return {
            "timezone": prefs.get("timezone", "America/Los_Angeles"),
            "language": prefs.get("language", "English"),
        }
    except Exception:
        return {"timezone": "America/Los_Angeles", "language": "English"}


# ── Tickers ──

@router.get("/tickers")
async def get_tickers():
    """Get all tracked tickers from DB."""
    conn = _tickers_db()
    try:
        rows = conn.execute("SELECT symbol, keywords FROM tickers ORDER BY symbol").fetchall()
        items = [{"symbol": r["symbol"], "keywords": json.loads(r["keywords"])} for r in rows]
        return {"items": items}
    finally:
        conn.close()


@router.post("/tickers")
async def add_tickers(data: dict = Body(...)):
    """Add tickers (batch). Body: {"tickers": [{"symbol": "NVDA", "keywords": ["nvidia"]}]}"""
    tickers = data.get("tickers", [])
    if not tickers:
        raise HTTPException(400, "No tickers provided")

    conn = _tickers_db()
    try:
        added = []
        for t in tickers:
            sym = t.get("symbol", "").strip().upper()
            if not sym or sym == "MARKET":
                continue
            kw = t.get("keywords", [sym.lower()])
            conn.execute(
                "INSERT OR REPLACE INTO tickers (symbol, keywords, added_at) VALUES (?, ?, ?)",
                (sym, json.dumps(kw), datetime.now(timezone.utc).isoformat()),
            )
            added.append(sym)
        conn.commit()
        return {"ok": True, "added": added}
    finally:
        conn.close()


@router.delete("/tickers")
async def remove_tickers(symbols: str = Query(...)):
    """Remove tickers (batch). ?symbols=NVDA,TSLA"""
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    conn = _tickers_db()
    try:
        for sym in syms:
            conn.execute("DELETE FROM tickers WHERE symbol = ?", (sym,))
        conn.commit()
        return {"ok": True, "removed": syms}
    finally:
        conn.close()


# ── Crawler Cron Control ──

def _get_crontab() -> str:
    """Get current crontab content."""
    try:
        result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        return result.stdout if result.returncode == 0 else ""
    except Exception:
        return ""


def _set_crontab(content: str):
    """Write crontab content."""
    subprocess.run(["crontab", "-"], input=content, text=True, check=True)


def _cron_line() -> str:
    """Build the cron line for every 5 minutes."""
    return f"*/5 * * * * bash {_CRON_SCRIPT} {_CRON_MARKER}"


def _is_crawler_enabled() -> bool:
    """Check if the finviz crawler cron job is active."""
    crontab = _get_crontab()
    for line in crontab.splitlines():
        if _CRON_MARKER in line and not line.lstrip().startswith("#"):
            return True
    return False


@router.get("/crawler")
async def get_crawler_status():
    """Get crawler cron status."""
    enabled = _is_crawler_enabled()
    # Check if crawler is currently running (pidfile)
    pidfile = FINVIZ_DIR / "crawler.pid"
    running = False
    if pidfile.exists():
        try:
            pid = int(pidfile.read_text().strip())
            os.kill(pid, 0)  # check if process exists
            running = True
        except (ValueError, ProcessLookupError, PermissionError):
            pass
    return {"enabled": enabled, "running": running}


@router.post("/crawler")
async def toggle_crawler(data: dict = Body(...)):
    """Enable or disable the crawler cron job. Body: {"enabled": true/false}"""
    enable = data.get("enabled", False)
    crontab = _get_crontab()

    # Remove existing finviz crawler lines
    lines = [l for l in crontab.splitlines() if _CRON_MARKER not in l]

    if enable:
        lines.append(_cron_line())

    new_crontab = "\n".join(lines)
    if new_crontab and not new_crontab.endswith("\n"):
        new_crontab += "\n"

    _set_crontab(new_crontab)
    return {"enabled": enable}


# ── Clean News ──

@router.post("/clean-news")
async def clean_news():
    """Delete all downloaded news files and clear DB articles."""
    news_dir = _get_news_dir()
    files_deleted = 0

    # Delete all files in news directory
    if os.path.exists(news_dir):
        for item in Path(news_dir).rglob("*"):
            if item.is_file():
                item.unlink()
                files_deleted += 1
        # Remove empty subdirectories
        for item in sorted(Path(news_dir).rglob("*"), reverse=True):
            if item.is_dir() and not any(item.iterdir()):
                item.rmdir()

    # Clear DB
    db_deleted = 0
    try:
        conn = _db_conn()
        db_deleted = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
        conn.execute("DELETE FROM articles")
        conn.commit()
        conn.close()
    except Exception:
        pass

    # Clear cached summaries
    if SUMMARY_FILE.exists():
        SUMMARY_FILE.unlink()
    meta_file = FINVIZ_DIR / "summary_meta.json"
    if meta_file.exists():
        meta_file.unlink()

    return {"ok": True, "files_deleted": files_deleted, "db_deleted": db_deleted}


# ── Articles & Summaries ──

def _period_to_hours(period: str) -> int:
    return {"12h": 12, "24h": 24, "weekly": 168}.get(period, 24)


def _get_articles_for_period(hours: int, topic: str = "Market", limit: int = 200) -> list[dict]:
    """Fetch articles filtered strictly by ticker column."""
    conn = _db_conn()
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        news_dir = _get_news_dir()

        # Market = articles with no ticker (general headlines)
        if topic == "Market":
            rows = conn.execute(
                """SELECT title, url, publish_at, article_path
                   FROM articles WHERE publish_at >= ? AND (ticker IS NULL OR ticker = '')
                   AND status = 'done'
                   ORDER BY publish_at DESC LIMIT ?""",
                (cutoff, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT title, url, publish_at, article_path
                   FROM articles WHERE publish_at >= ? AND ticker = ?
                   AND status = 'done'
                   ORDER BY publish_at DESC LIMIT ?""",
                (cutoff, topic, limit),
            ).fetchall()

        articles = []
        for r in rows:
            content = None
            if r["article_path"]:
                fp = os.path.join(news_dir, r["article_path"])
                if os.path.exists(fp):
                    content = Path(fp).read_text(errors="replace")[:3000]
            articles.append({"title": r["title"], "url": r["url"], "date": r["publish_at"], "content": content})
        return articles
    finally:
        conn.close()


def _get_cached_summary(period: str, language: str, topic: str = "Market") -> dict | None:
    meta_file = FINVIZ_DIR / "summary_meta.json"
    if SUMMARY_FILE.exists() and meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text())
            # Only return cache if language matches
            if meta.get("language") != language:
                return None
            meta["summary"] = SUMMARY_FILE.read_text()
            return meta
        except Exception:
            pass
    return None


def _save_cached_summary(period: str, language: str, summary: str, article_count: int, topic: str = "Market") -> dict:
    FINVIZ_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "period": period,
        "language": language,
        "topic": topic,
        "article_count": article_count,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    SUMMARY_FILE.write_text(summary)
    (FINVIZ_DIR / "summary_meta.json").write_text(json.dumps(data, ensure_ascii=False))
    data["summary"] = summary
    return data


def _generate_summary_llm(articles: list[dict], period: str, language: str, topic: str = "Market") -> str:
    import asyncio
    from commons.llm import get_llm_client

    digest_parts = []
    for i, a in enumerate(articles[:80], 1):
        snippet = ""
        if a["content"]:
            snippet = f"\n   Content: {a['content'][:500]}"
        digest_parts.append(f"{i}. [{a['date']}] {a['title']}{snippet}")

    digest = "\n".join(digest_parts)
    period_label = {"12h": "last 12 hours", "24h": "last 24 hours", "weekly": "past week"}.get(period, period)

    topic_instruction = ""
    if topic != "Market":
        topic_instruction = f"\nFocus specifically on {topic} and related news. "

    lang_instruction = ""
    if language != "English":
        lang_instruction = f"\n\nIMPORTANT: Write the entire summary in {language}. All text must be in {language}."

    prompt = f"""Summarize the following financial news from the {period_label} into a concise briefing.
{topic_instruction}
Group by major themes. For each theme:
- Key developments and their market impact
- Notable stock movements mentioned
- Forward-looking implications

Be concise but informative. Use bullet points.{lang_instruction}

---
{digest}
---

{"" if topic == "Market" else topic + " "}Briefing ({period_label}):"""

    client = get_llm_client()
    result = asyncio.run(client.chat(
        messages=[{"role": "user", "content": prompt}],
    ))
    return result["content"]


def _do_generate(period: str, language: str, topic: str = "Market"):
    key = f"{period}:{language}:{topic}"
    try:
        hours = _period_to_hours(period)
        articles = _get_articles_for_period(hours, topic=topic)
        if not articles:
            _save_cached_summary(period, language, f"No articles found for {topic} in this period. The crawler may not have ingested articles for this ticker yet — try again after the next crawl cycle.", 0, topic)
            return
        summary = _generate_summary_llm(articles, period, language, topic)
        _save_cached_summary(period, language, summary, len(articles), topic)
    except Exception as e:
        _save_cached_summary(period, language, f"Error: {e}", 0, topic)
    finally:
        _generating.pop(key, None)


@router.get("/article-counts")
async def finviz_article_counts(hours: int = Query(0, ge=0, le=8760)):
    """Article counts per ticker. hours=0 (default) means all time."""
    conn = _db_conn()
    try:
        if hours > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
            market_count = conn.execute(
                "SELECT COUNT(*) FROM articles WHERE publish_at >= ? AND (ticker IS NULL OR ticker = '') AND status = 'done'",
                (cutoff,),
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT ticker, COUNT(*) as cnt FROM articles WHERE publish_at >= ? AND ticker IS NOT NULL AND ticker != '' AND status = 'done' GROUP BY ticker ORDER BY ticker",
                (cutoff,),
            ).fetchall()
        else:
            market_count = conn.execute(
                "SELECT COUNT(*) FROM articles WHERE (ticker IS NULL OR ticker = '') AND status = 'done'",
            ).fetchone()[0]
            rows = conn.execute(
                "SELECT ticker, COUNT(*) as cnt FROM articles WHERE ticker IS NOT NULL AND ticker != '' AND status = 'done' GROUP BY ticker ORDER BY ticker",
            ).fetchall()
        counts = {"Market": market_count}
        for r in rows:
            counts[r["ticker"]] = r["cnt"]
        return counts
    finally:
        conn.close()


@router.get("/stats")
async def finviz_stats():
    conn = _db_conn()
    try:
        total = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
        with_content = conn.execute(
            "SELECT COUNT(*) FROM articles WHERE article_path IS NOT NULL"
        ).fetchone()[0]
        cutoff_24h = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        last_24h = conn.execute(
            "SELECT COUNT(*) FROM articles WHERE publish_at >= ?", (cutoff_24h,)
        ).fetchone()[0]
        pending_count = conn.execute(
            "SELECT COUNT(*) FROM articles WHERE status = 'pending'"
        ).fetchone()[0]
        failed_count = conn.execute(
            "SELECT COUNT(*) FROM articles WHERE status = 'failed'"
        ).fetchone()[0]
        last_crawl_row = conn.execute(
            "SELECT MAX(fetched_at) FROM articles"
        ).fetchone()
        last_crawl_at = last_crawl_row[0] if last_crawl_row else None
        return {
            "total": total,
            "with_content": with_content,
            "last_24h": last_24h,
            "pending_count": pending_count,
            "failed_count": failed_count,
            "last_crawl_at": last_crawl_at,
        }
    finally:
        conn.close()


@router.get("/summary/{period}")
async def finviz_summary(period: str, regenerate: int = 0, topic: str = "Market"):
    if period not in ("12h", "24h", "weekly"):
        raise HTTPException(400, "Period must be 12h, 24h, or weekly")

    prefs = _get_preferences()
    language = prefs["language"]
    key = f"{period}:{language}:{topic}"

    if regenerate:
        # Clear cached summary
        if SUMMARY_FILE.exists():
            SUMMARY_FILE.unlink()
        meta_file = FINVIZ_DIR / "summary_meta.json"
        if meta_file.exists():
            meta_file.unlink()

    cached = _get_cached_summary(period, language, topic)
    if cached and not regenerate:
        return {**cached, "status": "ready", "generating": key in _generating}

    if key in _generating:
        return {"status": "generating", "period": period, "language": language, "topic": topic}

    _generating[key] = True
    thread = threading.Thread(target=_do_generate, args=(period, language, topic), daemon=True)
    thread.start()
    return {"status": "generating", "period": period, "language": language, "topic": topic}


@router.get("/headlines")
async def finviz_headlines(
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(100, ge=1, le=500),
):
    conn = _db_conn()
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        rows = conn.execute(
            """SELECT title, url, publish_at, article_path
               FROM articles WHERE publish_at >= ?
               ORDER BY publish_at DESC LIMIT ?""",
            (cutoff, limit),
        ).fetchall()
        return {
            "count": len(rows),
            "headlines": [
                {"title": r["title"], "url": r["url"], "date": r["publish_at"],
                 "has_content": r["article_path"] is not None}
                for r in rows
            ],
        }
    finally:
        conn.close()


@router.get("/article")
async def finviz_article(url: str = Query(...)):
    conn = _db_conn()
    try:
        row = conn.execute(
            "SELECT title, url, publish_at, article_path FROM articles WHERE url = ?", (url,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Article not found")
        content = None
        if row["article_path"]:
            fp = os.path.join(_get_news_dir(), row["article_path"])
            if os.path.exists(fp):
                content = Path(fp).read_text(errors="replace")
        return {"title": row["title"], "url": row["url"], "date": row["publish_at"], "content": content}
    finally:
        conn.close()


# ── Alert Config ──

_ALERT_MARKER = "# marchdeck-finviz-alert"
_ALERT_SCRIPT = _PROJECT_DIR / "apps" / "finviz" / "scripts" / "finviz_alert.sh"


def _alert_cron_line(hour: int, minute: int) -> str:
    """Build cron line for daily alert at specified time."""
    return f"{minute} {hour} * * * bash {_ALERT_SCRIPT} {_ALERT_MARKER}"


def _is_alert_enabled() -> bool:
    """Check if the finviz alert cron job is active."""
    crontab = _get_crontab()
    for line in crontab.splitlines():
        if _ALERT_MARKER in line and not line.lstrip().startswith("#"):
            return True
    return False


def _set_alert_cron(enabled: bool, hour: int = 8, minute: int = 0):
    """Enable or disable the alert cron job."""
    crontab = _get_crontab()
    lines = [l for l in crontab.splitlines() if _ALERT_MARKER not in l]
    if enabled:
        lines.append(_alert_cron_line(hour, minute))
    new_crontab = "\n".join(lines)
    if new_crontab and not new_crontab.endswith("\n"):
        new_crontab += "\n"
    _set_crontab(new_crontab)


@router.get("/alert-config")
async def get_alert_config():
    if ALERT_CONFIG_PATH.exists():
        try:
            data = json.loads(ALERT_CONFIG_PATH.read_text())
            # Sync enabled state with actual cron
            data["enabled"] = _is_alert_enabled()
            return data
        except Exception:
            pass
    return {"enabled": _is_alert_enabled(), "schedule_hour": 8, "schedule_minute": 0}


class AlertConfigBody(BaseModel):
    enabled: bool
    schedule_hour: int
    schedule_minute: int


@router.post("/alert-config")
async def save_alert_config(body: AlertConfigBody):
    ALERT_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ALERT_CONFIG_PATH.write_text(json.dumps(body.dict(), indent=2))
    # Update cron job
    _set_alert_cron(body.enabled, body.schedule_hour, body.schedule_minute)
    return {"saved": True, "enabled": body.enabled}


@router.post("/alert-send")
async def send_alert_now():
    """Send a push notification with the latest finviz summary."""
    from commons.push import PushManager
    from commons.constants import DATA_DIR
    from app_loader import get_preference

    # Read email from user preferences (Settings UI), fall back to config
    vapid_email = get_preference("push_email", "")
    if not vapid_email:
        from commons.constants import CONFIG_FILE
        import yaml
        try:
            cfg = yaml.safe_load(CONFIG_FILE.read_text()) or {}
        except Exception:
            cfg = {}
        vapid_email = cfg.get("push", {}).get("vapid_email", "nobody@localhost")

    push = PushManager(str(DATA_DIR), vapid_email)

    # Get article count for last 24h
    try:
        conn = _db_conn()
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        count = conn.execute(
            "SELECT COUNT(*) FROM articles WHERE publish_at >= ? AND status = 'done'",
            (cutoff,),
        ).fetchone()[0]
        conn.close()
    except Exception:
        count = 0

    body = f"{count} articles in the last 24 hours" if count else "No new articles"
    sent = push.send(
        title="📰 Finviz Daily Briefing",
        body=body,
        url="/app/finviz/",
        tag="finviz-alert",
    )
    return {"sent": sent}


if __name__ == "__main__":
    from fastapi import FastAPI
    import uvicorn
    app = FastAPI(title="Finviz")
    app.include_router(router, prefix="/api/app/finviz")
    uvicorn.run(app, host="0.0.0.0", port=8802)
