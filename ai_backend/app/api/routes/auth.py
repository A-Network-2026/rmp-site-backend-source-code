from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_db_session
from app.schemas.auth import AppSessionRequest, LoginRequest, RegisterRequest, TokenResponse
from app.services.auth_service import auth_service


router = APIRouter(prefix="/auth")


@router.post("/register", response_model=TokenResponse)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db_session)) -> TokenResponse:
    try:
        token = await auth_service.register(db, payload.email, payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return TokenResponse(access_token=token)


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db_session)) -> TokenResponse:
    try:
        token = await auth_service.login(db, payload.email, payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    return TokenResponse(access_token=token)


@router.post("/app-session", response_model=TokenResponse)
async def app_session(
    payload: AppSessionRequest,
    db: AsyncSession = Depends(get_db_session),
    x_support_token: str | None = Header(default=None),
) -> TokenResponse:
    if not settings.ads_support_token or x_support_token != settings.ads_support_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid support token")

    try:
        token = await auth_service.create_app_session(
            db,
            app_user_id=payload.app_user_id,
            email=payload.email,
            migration_wallet=payload.migration_wallet,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return TokenResponse(access_token=token)
