from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db.models import User, UserProfile
from app.db.session import get_db_session
from app.schemas.profile import ProfileResponse, ProfileUpdateRequest


router = APIRouter(prefix="/profile")


@router.get("/me", response_model=ProfileResponse)
async def get_my_profile(
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> ProfileResponse:
    result = await db.execute(select(UserProfile).where(UserProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        profile = UserProfile(user_id=current_user.id)
        db.add(profile)
        await db.commit()
        await db.refresh(profile)

    return ProfileResponse(
        display_name=profile.display_name,
        personality_prompt=profile.personality_prompt,
        private_context=profile.private_context,
        ai_token_balance=profile.ai_token_balance,
    )


@router.patch("/me", response_model=ProfileResponse)
async def update_my_profile(
    payload: ProfileUpdateRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> ProfileResponse:
    result = await db.execute(select(UserProfile).where(UserProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        profile = UserProfile(user_id=current_user.id)
        db.add(profile)

    if payload.display_name is not None:
        profile.display_name = payload.display_name
    if payload.personality_prompt is not None:
        profile.personality_prompt = payload.personality_prompt
    if payload.private_context is not None:
        profile.private_context = payload.private_context

    await db.commit()
    await db.refresh(profile)

    return ProfileResponse(
        display_name=profile.display_name,
        personality_prompt=profile.personality_prompt,
        private_context=profile.private_context,
        ai_token_balance=profile.ai_token_balance,
    )
