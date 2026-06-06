from fastapi import FastAPI, Response

from app.api.routes import ads_ssv, auth, chat, health, memory, profile
from app.core.config import settings
from app.db.session import init_db


app = FastAPI(title=settings.app_name)


@app.api_route("/", methods=["GET", "HEAD"])
async def root() -> dict:
    return {
        "ok": True,
        "service": settings.app_name,
        "apiPrefix": settings.api_v1_prefix
    }


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    return Response(status_code=204)


@app.on_event("startup")
async def on_startup() -> None:
    await init_db()


app.include_router(health.router, prefix=settings.api_v1_prefix, tags=["health"])
app.include_router(auth.router, prefix=settings.api_v1_prefix, tags=["auth"])
app.include_router(profile.router, prefix=settings.api_v1_prefix, tags=["profile"])
app.include_router(chat.router, prefix=settings.api_v1_prefix, tags=["chat"])
app.include_router(memory.router, prefix=settings.api_v1_prefix, tags=["memory"])
app.include_router(ads_ssv.router, tags=["ads"])
