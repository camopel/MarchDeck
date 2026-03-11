"""FAISS index builder for ArXiv papers.

Embeds title + abstract using Ollama, builds FAISS index.
Supports progress callback for UI updates.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Callable

import numpy as np
import requests

log = logging.getLogger("arxiv.embed")

OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "nomic-embed-text"
EMBED_DIM = 768


def embed_batch(texts: list[str], model: str = EMBED_MODEL) -> np.ndarray:
    """Embed a batch of texts via Ollama API (single call)."""
    resp = requests.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": model, "input": texts},
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    embeddings = data.get("embeddings", [])
    if not embeddings:
        return np.zeros((len(texts), EMBED_DIM), dtype=np.float32)
    return np.array(embeddings, dtype=np.float32)


def build_index(
    db_path: str,
    data_dir: str,
    progress_cb: Callable[[int, int], None] | None = None,
) -> int:
    """Build FAISS index from papers in DB.
    
    Args:
        db_path: Path to arxivkb.db
        data_dir: Directory to save index files
        progress_cb: Optional callback(processed, total) for progress updates
    
    Returns:
        Number of papers indexed
    """
    import faiss

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT arxiv_id, title, abstract FROM papers").fetchall()
    conn.close()

    if not rows:
        log.info("No papers to index")
        return 0

    total = len(rows)
    log.info(f"Indexing {total} papers...")

    # Build texts and embed in batches
    BATCH_SIZE = 10  # Show progress per batch
    all_embeddings = []
    arxiv_ids = []

    for i in range(0, total, BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        texts = [f"{r['title']}. {r['abstract']}" for r in batch]
        ids = [r["arxiv_id"] for r in batch]

        try:
            embs = embed_batch(texts)
            all_embeddings.append(embs)
            arxiv_ids.extend(ids)
        except Exception as e:
            log.warning(f"Embed batch failed: {e}")
            # Skip failed batch
            continue

        processed = min(i + BATCH_SIZE, total)
        if progress_cb:
            progress_cb(processed, total)

    if not all_embeddings:
        log.warning("No embeddings generated")
        return 0

    matrix = np.vstack(all_embeddings)
    dim = matrix.shape[1]

    # Build FAISS index
    index = faiss.IndexFlatIP(dim)
    faiss.normalize_L2(matrix)
    index.add(matrix)

    # Save
    out_dir = Path(data_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(out_dir / "index.faiss"))
    np.save(str(out_dir / "index_ids.npy"), np.array(arxiv_ids))

    # Update paper status in DB
    conn = sqlite3.connect(db_path)
    for aid in arxiv_ids:
        conn.execute("UPDATE papers SET status = 'embedded' WHERE arxiv_id = ?", (aid,))
    conn.commit()
    conn.close()

    log.info(f"Indexed {len(arxiv_ids)} papers, dim={dim}")
    return len(arxiv_ids)
