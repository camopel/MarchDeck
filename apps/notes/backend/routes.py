"""Notes app routes.

Provides:
  GET    /list                → list all notes (summary)
  POST   /create              → create a new note
  GET    /{note_id}           → get full note
  PUT    /{note_id}           → update note
  DELETE /{note_id}           → delete note
  POST   /upload              → upload image
  GET    /images/{filename}   → serve uploaded image
  GET    /search?q=...        → full-text search
"""
from __future__ import annotations

import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter()

_DB_DIR = Path.home() / ".local" / "share" / "marchdeck"
_DB_PATH = _DB_DIR / "notes.db"
_IMAGES_DIR = _DB_DIR / "notes_images"


def _ensure_dirs() -> None:
    _DB_DIR.mkdir(parents=True, exist_ok=True)
    _IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def _get_db() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    return conn


def _strip_md(text: str) -> str:
    """Strip markdown formatting symbols, keep only visible text."""
    s = text
    s = re.sub(r"^#+\s*", "", s)                        # headings
    s = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", s)     # images
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)      # links
    s = re.sub(r"(\*\*|__)(.*?)\1", r"\2", s)           # bold
    s = re.sub(r"(\*|_)(.*?)\1", r"\2", s)              # italic
    s = re.sub(r"~~(.*?)~~", r"\1", s)                   # strikethrough
    s = re.sub(r"`{1,3}([^`]*)`{1,3}", r"\1", s)       # code
    s = re.sub(r"^[-*+]\s+", "", s)                      # list items
    s = re.sub(r"^\d+\.\s+", "", s)                      # ordered list
    s = re.sub(r"^>\s+", "", s)                          # blockquotes
    return s.strip()


def _extract_title(content: str) -> str:
    """Extract title from first non-empty line, strip all markdown formatting."""
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped:
            title = _strip_md(stripped)
            return title[:100] if title else stripped[:100]
    return ""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class CreateBody(BaseModel):
    content: str = ""


class UpdateBody(BaseModel):
    content: Optional[str] = None
    pinned: Optional[bool] = None


@router.get("/list")
async def list_notes():
    """List all notes with preview."""
    db = _get_db()
    try:
        rows = db.execute(
            "SELECT id, title, content, pinned, updated_at FROM notes "
            "ORDER BY pinned DESC, updated_at DESC"
        ).fetchall()
        notes = []
        for r in rows:
            content = r["content"]
            # Preview: first 100 chars
            preview = content[:100] if content else ""
            notes.append({
                "id": r["id"],
                "title": r["title"],
                "preview": preview,
                "pinned": bool(r["pinned"]),
                "updated_at": r["updated_at"],
            })
        return {"notes": notes}
    finally:
        db.close()


@router.post("/create")
async def create_note(body: CreateBody):
    """Create a new note."""
    db = _get_db()
    try:
        note_id = uuid.uuid4().hex
        title = _extract_title(body.content)
        now = _now_iso()
        db.execute(
            "INSERT INTO notes (id, title, content, pinned, created_at, updated_at) "
            "VALUES (?, ?, ?, 0, ?, ?)",
            (note_id, title, body.content, now, now),
        )
        db.commit()
        return {
            "id": note_id,
            "title": title,
            "content": body.content,
            "pinned": False,
            "created_at": now,
            "updated_at": now,
        }
    finally:
        db.close()


@router.get("/search")
async def search_notes(q: str = Query(..., min_length=1)):
    """Full-text search in title + content."""
    db = _get_db()
    try:
        pattern = f"%{q}%"
        rows = db.execute(
            "SELECT id, title, content, pinned, updated_at FROM notes "
            "WHERE title LIKE ? OR content LIKE ? "
            "ORDER BY pinned DESC, updated_at DESC",
            (pattern, pattern),
        ).fetchall()
        notes = []
        for r in rows:
            content = r["content"]
            preview = content[:100] if content else ""
            notes.append({
                "id": r["id"],
                "title": r["title"],
                "preview": preview,
                "pinned": bool(r["pinned"]),
                "updated_at": r["updated_at"],
            })
        return {"notes": notes}
    finally:
        db.close()


@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """Upload an image file."""
    _ensure_dirs()
    # Validate it's an image
    ct = file.content_type or ""
    if not ct.startswith("image/"):
        raise HTTPException(400, "Only image files are allowed")

    # Determine extension from content type
    ext_map = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
        "image/heic": ".heic",
        "image/heif": ".heif",
    }
    ext = ext_map.get(ct, ".bin")
    if file.filename:
        orig_ext = Path(file.filename).suffix.lower()
        if orig_ext:
            ext = orig_ext

    filename = uuid.uuid4().hex + ext
    dest = _IMAGES_DIR / filename

    data = await file.read()
    dest.write_bytes(data)

    return {"url": f"/api/app/notes/images/{filename}"}


@router.get("/images/{filename}")
async def serve_image(filename: str):
    """Serve an uploaded image."""
    # Sanitize filename — no path traversal
    safe = Path(filename).name
    filepath = _IMAGES_DIR / safe
    if not filepath.exists():
        raise HTTPException(404, "Image not found")
    return FileResponse(str(filepath))


@router.get("/{note_id}/download")
async def download_note(note_id: str):
    """Download note as .md file."""
    db = _get_db()
    try:
        row = db.execute("SELECT title, content FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Note not found")
        title = row["title"] or "untitled"
        # Sanitize filename
        safe_title = re.sub(r'[^\w\s-]', '', title).strip()[:50] or "note"
        content = row["content"] or ""
        from fastapi.responses import Response
        return Response(
            content=content,
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{safe_title}.md"'}
        )
    finally:
        db.close()


@router.get("/{note_id}")
async def get_note(note_id: str):
    """Get a single note with full content."""
    db = _get_db()
    try:
        row = db.execute(
            "SELECT id, title, content, pinned, created_at, updated_at FROM notes WHERE id = ?",
            (note_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Note not found")
        return {
            "id": row["id"],
            "title": row["title"],
            "content": row["content"],
            "pinned": bool(row["pinned"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
    finally:
        db.close()


@router.put("/{note_id}")
async def update_note(note_id: str, body: UpdateBody):
    """Update a note."""
    db = _get_db()
    try:
        row = db.execute("SELECT id, content, pinned FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Note not found")

        content = body.content if body.content is not None else row["content"]
        pinned = int(body.pinned) if body.pinned is not None else row["pinned"]
        title = _extract_title(content)
        now = _now_iso()

        db.execute(
            "UPDATE notes SET title = ?, content = ?, pinned = ?, updated_at = ? WHERE id = ?",
            (title, content, pinned, now, note_id),
        )
        db.commit()

        updated = db.execute(
            "SELECT id, title, content, pinned, created_at, updated_at FROM notes WHERE id = ?",
            (note_id,),
        ).fetchone()
        return {
            "id": updated["id"],
            "title": updated["title"],
            "content": updated["content"],
            "pinned": bool(updated["pinned"]),
            "created_at": updated["created_at"],
            "updated_at": updated["updated_at"],
        }
    finally:
        db.close()


@router.delete("/{note_id}")
async def delete_note(note_id: str):
    """Delete a note."""
    db = _get_db()
    try:
        row = db.execute("SELECT id FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Note not found")
        db.execute("DELETE FROM notes WHERE id = ?", (note_id,))
        db.commit()
        return {"ok": True, "deleted": note_id}
    finally:
        db.close()


if __name__ == "__main__":
    from fastapi import FastAPI
    import uvicorn

    standalone_app = FastAPI(title="Notes")
    standalone_app.include_router(router, prefix="/api/app/notes")

    from fastapi.staticfiles import StaticFiles
    dist = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
    if os.path.isdir(dist):
        standalone_app.mount("/app/notes", StaticFiles(directory=dist, html=True), name="static")

    uvicorn.run(standalone_app, host="0.0.0.0", port=8803)
