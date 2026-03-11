"""My App — backend routes.

Mounted at /api/app/my-app by March Deck server.
"""
from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/hello")
async def hello():
    return {"message": "Hello from My App"}
