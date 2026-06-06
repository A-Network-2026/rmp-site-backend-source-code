from fastapi import APIRouter

from app.services.chat_service import _WHITEPAPER_UNAVAILABLE_MSG
from app.services.whitepaper_service import whitepaper_service


router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/knowledge")
async def knowledge_health() -> dict:
    snapshot = whitepaper_service.get_snapshot(_WHITEPAPER_UNAVAILABLE_MSG)
    return {
        "status": "ok",
        "whitepaper": {
            "loaded": snapshot.loaded,
            "source_path": snapshot.source_path,
            "source_mtime": snapshot.source_mtime,
            "loaded_at": snapshot.loaded_at,
            "character_count": snapshot.character_count,
        },
        "user_training": {
            "enabled": True,
            "endpoints": [
                "/api/v1/memory/text",
                "/api/v1/memory/upload",
                "/api/v1/memory/training-example",
            ],
        },
    }
