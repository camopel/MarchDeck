"""ArXiv — March Deck backend.

Routes (mounted at /api/app/arxiv):
  GET  /stats              — DB statistics
  GET  /categories         — All arXiv categories with enabled flag
  PUT  /categories/{code}  — Enable/disable a category
  GET  /paper/{id}         — Paper detail with translated abstract
  GET  /pdf/{id}           — Serve PDF file
  GET  /search             — Semantic search across papers
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

router = APIRouter()

from commons.constants import DATA_DIR as _DATA_HOME
DEFAULT_DATA_DIR = str(_DATA_HOME / "app" / "arxiv")

# ---------------------------------------------------------------------------
# LLM client — uses unified LLM layer from commons
# ---------------------------------------------------------------------------
def _get_llm_client():
    """Get the configured LLM client."""
    from commons.llm import get_llm_client
    return get_llm_client()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_data_dir() -> str:
    return os.environ.get("ARXIVKB_DATA_DIR", DEFAULT_DATA_DIR)


def _db_conn() -> sqlite3.Connection:
    db_path = os.path.join(_get_data_dir(), "arxivkb.db")
    if not os.path.exists(db_path):
        raise HTTPException(404, detail="ArXiv database not found. Run the install script.")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _get_translate_language() -> str:
    """Read translate language from March Deck settings DB."""
    settings_db = os.environ.get(
        "PRIVATEAPP_SETTINGS_DB",
        os.path.expanduser("~/.march-deck/app/marchdeck.db"),
    )
    if not os.path.exists(settings_db):
        return ""
    try:
        conn = sqlite3.connect(settings_db)
        row = conn.execute("SELECT value FROM preferences WHERE key = 'language'").fetchone()
        conn.close()
        return row[0].strip() if row and row[0] else ""
    except Exception:
        return ""


async def _translate(text: str, target_lang: str) -> str | None:
    """Translate text via the unified LLM client."""
    try:
        client = _get_llm_client()
        result = await client.chat(
            messages=[
                {"role": "system", "content": f"Translate the following academic abstract to {target_lang}. Return ONLY the translation, no preamble."},
                {"role": "user", "content": text},
            ],
            temperature=0.1,
            max_tokens=2000,
        )
        return result["content"].strip()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/stats")
async def science_stats():
    conn = _db_conn()
    try:
        papers = conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        try:
            chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        except Exception:
            chunks = 0
        try:
            categories = conn.execute("SELECT COUNT(*) FROM categories WHERE enabled = 1").fetchone()[0]
        except Exception:
            categories = 0

        last_row = conn.execute(
            "SELECT DATE(created_at) as d, COUNT(*) as cnt FROM papers GROUP BY DATE(created_at) ORDER BY d DESC LIMIT 1"
        ).fetchone()

        return {
            "papers": papers,
            "chunks": chunks,
            "categories": categories,
            "last_crawl": last_row[0] if last_row else None,
            "last_crawl_count": last_row[1] if last_row else 0,
        }
    finally:
        conn.close()


@router.get("/categories")
async def science_categories():
    conn = _db_conn()
    try:
        try:
            rows = conn.execute("SELECT code, description, group_name, enabled FROM categories ORDER BY group_name, code").fetchall()
            return {"categories": [{"code": r["code"], "description": r["description"] or "", "group": r["group_name"] or "", "enabled": bool(r["enabled"])} for r in rows]}
        except Exception:
            return {"categories": []}
    finally:
        conn.close()


@router.put("/categories/{code}")
async def toggle_category(code: str, request: Request):
    """Enable or disable a category for crawling. Cleans papers when disabled."""
    body = await request.json()
    enabled = body.get("enabled", True)
    conn = _db_conn()
    try:
        conn.execute("UPDATE categories SET enabled = ? WHERE code = ?", (1 if enabled else 0, code))
        conn.commit()

        # If disabling, clean up downloaded papers for this category
        if not enabled:
            import shutil
            papers_dir = os.path.join(_get_data_dir(), "papers", code.replace(".", "_"))
            if os.path.isdir(papers_dir):
                shutil.rmtree(papers_dir, ignore_errors=True)
            # Remove papers that contain this category
            conn.execute(
                "DELETE FROM papers WHERE categories = ? OR categories LIKE ? OR categories LIKE ? OR categories LIKE ?",
                (code, f"{code},%", f"%,{code},%", f"%,{code}"),
            )
            conn.commit()

            # If no categories are enabled, clean ALL remaining papers and PDFs
            enabled_count = conn.execute("SELECT COUNT(*) as c FROM categories WHERE enabled = 1").fetchone()
            if enabled_count and enabled_count["c"] == 0:
                conn.execute("DELETE FROM papers")
                conn.commit()
                papers_root = os.path.join(_get_data_dir(), "papers")
                if os.path.isdir(papers_root):
                    shutil.rmtree(papers_root, ignore_errors=True)
                    os.makedirs(papers_root, exist_ok=True)
                # Also remove FAISS index
                for f in ["index.faiss", "index.npy"]:
                    fp = os.path.join(_get_data_dir(), f)
                    if os.path.exists(fp):
                        os.remove(fp)
                # Reset crawl status
                _save_crawl_status({"running": False, "message": ""})

        # Return updated stats
        stats = conn.execute("SELECT COUNT(*) as c FROM categories WHERE enabled = 1").fetchone()
        paper_count = conn.execute("SELECT COUNT(*) as c FROM papers").fetchone()
        return {
            "code": code,
            "enabled": enabled,
            "categories_enabled": stats["c"] if stats else 0,
            "papers": paper_count["c"] if paper_count else 0,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


def _pdf_path(arxiv_id: str, category: str = "") -> str:
    """Derive PDF path from arxiv_id under category folder."""
    if category:
        return os.path.join(_get_data_dir(), "papers", category.replace(".", "_"), f"{arxiv_id}.pdf")
    # Fallback: check new structure first, then old flat structure
    data_dir = _get_data_dir()
    new_path_glob = os.path.join(data_dir, "papers", "*", f"{arxiv_id}.pdf")
    import glob as _glob
    matches = _glob.glob(new_path_glob)
    if matches:
        return matches[0]
    return os.path.join(data_dir, "pdfs", f"{arxiv_id}.pdf")


@router.get("/paper/{arxiv_id}")
async def science_paper(arxiv_id: str):
    """Paper detail — returns immediately, no translation blocking."""
    conn = _db_conn()
    try:
        row = conn.execute(
            "SELECT id, arxiv_id, title, abstract, published FROM papers WHERE arxiv_id = ?",
            (arxiv_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Paper not found")

        has_pdf = os.path.exists(_pdf_path(row["arxiv_id"]))
        target_lang = _get_translate_language()

        # Check if translation already cached
        abstract_translated = None
        if target_lang and row["abstract"]:
            tr = conn.execute(
                "SELECT abstract FROM translations WHERE paper_id = ? AND language = ?",
                (row["id"], target_lang),
            ).fetchone()
            if tr:
                abstract_translated = tr[0]

        return {
            "arxiv_id": row["arxiv_id"],
            "title": row["title"],
            "abstract": row["abstract"],
            "abstract_translated": abstract_translated,
            "translate_language": target_lang or None,
            "published": row["published"],
            "has_pdf": has_pdf,
        }
    finally:
        conn.close()


@router.get("/paper/{arxiv_id}/translate")
async def science_paper_translate(arxiv_id: str):
    """Translate abstract on demand — called async by frontend."""
    conn = _db_conn()
    try:
        row = conn.execute(
            "SELECT id, abstract FROM papers WHERE arxiv_id = ?", (arxiv_id,),
        ).fetchone()
        if not row or not row["abstract"]:
            return {"translated": None}

        target_lang = _get_translate_language()
        if not target_lang:
            return {"translated": None}

        # Check cache
        tr = conn.execute(
            "SELECT abstract FROM translations WHERE paper_id = ? AND language = ?",
            (row["id"], target_lang),
        ).fetchone()
        if tr:
            return {"translated": tr[0], "language": target_lang}

        # Translate
        translated = await _translate(row["abstract"], target_lang)
        if translated:
            try:
                conn.execute(
                    "INSERT INTO translations (paper_id, language, abstract) VALUES (?, ?, ?)",
                    (row["id"], target_lang, translated),
                )
                conn.commit()
            except Exception:
                pass
        return {"translated": translated, "language": target_lang}
    finally:
        conn.close()


@router.get("/pdf/{arxiv_id}")
async def science_pdf(arxiv_id: str):
    """Serve PDF file for inline viewing."""
    pdf_file = _pdf_path(arxiv_id)
    if not os.path.exists(pdf_file):
        raise HTTPException(404, "PDF not found")
    return FileResponse(
        pdf_file,
        media_type="application/pdf",
        filename=f"{arxiv_id}.pdf",
        headers={"Content-Disposition": "inline"},
    )


@router.get("/search")
async def science_search(
    q: str = Query(..., min_length=2),
    top_k: int = Query(10, ge=1, le=50),
):
    """Semantic search over paper abstracts via FAISS, fallback to text search."""
    data_dir = _get_data_dir()
    db_path = os.path.join(data_dir, "arxivkb.db")

    # Try semantic search first
    try:
        import sys
        scripts_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        # Also add the skill scripts dir
        skill_dir = os.environ.get("ARXIVKB_SKILL_DIR",
                                     os.path.expanduser("~/.openclaw/workspace/skills/arxivkb/scripts"))
        if skill_dir not in sys.path:
            sys.path.insert(0, skill_dir)
        from search import search as semantic_search
        results = semantic_search(q, db_path, data_dir, top_k=top_k)
        if results:
            return {"count": len(results), "method": "semantic", "results": results}
    except Exception:
        pass

    # Fallback: text search
    conn = _db_conn()
    try:
        rows = conn.execute(
            """SELECT arxiv_id, title, published
               FROM papers
               WHERE title LIKE ? OR abstract LIKE ?
               ORDER BY published DESC LIMIT ?""",
            (f"%{q}%", f"%{q}%", top_k),
        ).fetchall()
        return {
            "count": len(rows),
            "method": "text",
            "results": [
                {"arxiv_id": r["arxiv_id"], "title": r["title"], "published": r["published"]}
                for r in rows
            ],
        }
    finally:
        conn.close()


# ── Crawl trigger ─────────────────────────────────────────────────────

_crawl_running = False
_CRAWL_STATUS_FILE = _DATA_HOME / "app" / "arxiv" / "crawl_status.json"


def _load_crawl_status() -> dict:
    default = {"running": False, "message": ""}
    if _CRAWL_STATUS_FILE.exists():
        try:
            return json.loads(_CRAWL_STATUS_FILE.read_text())
        except Exception:
            pass
    return default


def _save_crawl_status(status: dict) -> None:
    _CRAWL_STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CRAWL_STATUS_FILE.write_text(json.dumps(status))


@router.get("/crawl/status")
async def crawl_status():
    s = _load_crawl_status()
    # If file says running but no crawl task is active, it's stale — reset
    if s.get("running") and not _crawl_running:
        s = {"running": False, "message": ""}
        _save_crawl_status(s)
    return s


@router.post("/crawl")
async def trigger_crawl(request: Request):
    """Trigger a crawl of enabled categories."""
    global _crawl_running
    if _crawl_running:
        return {"status": "already_running"}

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    days_back = body.get("days_back", 7)

    conn = _db_conn()
    try:
        rows = conn.execute("SELECT code, description FROM categories WHERE enabled = 1").fetchall()
        cat_map = {r["description"]: r["code"] for r in rows}
        topics = list(cat_map.keys())
    finally:
        conn.close()

    if not topics:
        return {"status": "no_categories", "message": "Enable at least one category first"}

    import asyncio
    _crawl_running = True
    _save_crawl_status({"running": True, "message": "Discovering papers..."})

    async def _do_crawl():
        global _crawl_running
        try:
            import sys
            scripts_dir = os.path.join(os.path.dirname(__file__), "..", "scripts")
            sys.path.insert(0, scripts_dir)
            from arxiv_crawler import crawl_topics

            base_dir = str(_DATA_HOME / "app" / "arxiv" / "papers")

            _save_crawl_status({"running": True, "message": "Discovering papers..."})
            papers = await asyncio.to_thread(
                crawl_topics, topics, base_dir, max_results=50, days_back=days_back, download_pdfs=False
            )
            total = len(papers)
            _save_crawl_status({"running": True, "message": f"Downloading 0/{total}"})

            # Download PDFs into category/ structure
            from arxiv_crawler import download_pdf
            downloaded = 0
            skipped = 0
            for p in papers:
                cats = p.get("categories", [])
                cat_code = ""
                for c in cats:
                    if c in [v for v in cat_map.values()]:
                        cat_code = c
                        break
                if not cat_code and cats:
                    cat_code = cats[0]
                paper_dir = os.path.join(base_dir, cat_code.replace(".", "_"))
                pdf_file = os.path.join(paper_dir, f"{p.get('arxiv_id')}.pdf")

                # Skip if already downloaded
                if os.path.exists(pdf_file):
                    skipped += 1
                    p["pdf_path"] = pdf_file
                    continue

                os.makedirs(paper_dir, exist_ok=True)
                try:
                    await asyncio.to_thread(
                        download_pdf, p.get("arxiv_id"), paper_dir, p.get("pdf_url")
                    )
                    p["pdf_path"] = pdf_file
                    downloaded += 1
                    remaining = total - downloaded - skipped
                    _save_crawl_status({"running": True, "message": f"Downloading {downloaded}/{total - skipped}"})
                except Exception:
                    pass

            # Save to DB
            conn2 = _db_conn()
            try:
                for p in papers:
                    try:
                        conn2.execute(
                            """INSERT OR IGNORE INTO papers (arxiv_id, title, abstract, published, categories)
                               VALUES (?, ?, ?, ?, ?)""",
                            (p.get("arxiv_id"), p.get("title", ""), p.get("abstract", ""),
                             p.get("published", ""), ",".join(p.get("categories", []))),
                        )
                    except Exception:
                        pass
                conn2.commit()
            finally:
                conn2.close()

            # Build FAISS index only if new papers were downloaded
            if downloaded > 0:
                _save_crawl_status({"running": True, "message": "Indexing..."})
                try:
                    scripts_dir = os.path.join(os.path.dirname(__file__), "..", "scripts")
                    data_dir = str(_DATA_HOME / "app" / "arxiv")
                    db_path = str(_DATA_HOME / "app" / "arxiv" / "arxivkb.db")
                    status_file = str(_CRAWL_STATUS_FILE)

                    proc = await asyncio.create_subprocess_exec(
                        sys.executable, os.path.join(scripts_dir, "run_index.py"),
                        db_path, data_dir, status_file,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    stdout, stderr = await proc.communicate()
                    if stdout:
                        log.info(stdout.decode().strip())
                    if proc.returncode != 0 and stderr:
                        log.warning(f"Index error: {stderr.decode().strip()}")
                except Exception as e:
                    log.warning(f"FAISS index build failed: {e}")

            from datetime import datetime, timezone
            now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
            if downloaded > 0:
                _save_crawl_status({"running": False, "message": f"Downloaded {downloaded} new papers on {now}"})
            else:
                _save_crawl_status({"running": False, "message": f"No new papers found ({now})"})
        except Exception as e:
            log.warning(f"Crawl failed: {e}")
            _save_crawl_status({"running": False, "message": f"Crawl failed: {e}"})
        finally:
            _crawl_running = False

    asyncio.create_task(_do_crawl())
    return {"status": "started", "topics": len(topics)}


# ── Translate ─────────────────────────────────────────────────────────

@router.post("/translate")
async def translate_text(request: Request):
    """Translate text using the configured LLM."""
    body = await request.json()
    text = body.get("text", "")
    target_lang = body.get("language", "en")
    if not text:
        raise HTTPException(400, "Missing text")
    if target_lang == "en":
        return {"translated": text, "language": "en"}
    try:
        from commons.llm import get_llm_client
        client = get_llm_client()
        result = await client.chat(messages=[
            {"role": "system", "content": f"Translate the following text to {target_lang}. Return only the translation, nothing else."},
            {"role": "user", "content": text},
        ])
        return {"translated": result.get("content", text), "language": target_lang}
    except Exception as e:
        raise HTTPException(503, f"Translation failed: {e}")


if __name__ == "__main__":
    from fastapi import FastAPI
    import uvicorn

    app = FastAPI(title="Science KB")
    app.include_router(router, prefix="/api/app/arxiv")

    dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
    if os.path.isdir(dist):
        from fastapi.staticfiles import StaticFiles
        app.mount("/", StaticFiles(directory=dist, html=True))

    uvicorn.run(app, host="0.0.0.0", port=8803)
