from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token, hash_password, verify_password
from app.db.models import User, UserProfile


class AuthService:
    async def register(self, db: AsyncSession, email: str, password: str) -> str:
        existing = await db.execute(select(User).where(User.email == email.lower()))
        if existing.scalar_one_or_none():
            raise ValueError("Email already exists")

        user = User(email=email.lower(), hashed_password=hash_password(password))
        db.add(user)
        await db.flush()

        profile = UserProfile(user_id=user.id)
        db.add(profile)

        await db.commit()
        return create_access_token(str(user.id))

    async def login(self, db: AsyncSession, email: str, password: str) -> str:
        result = await db.execute(select(User).where(User.email == email.lower()))
        user = result.scalar_one_or_none()
        if not user or not verify_password(password, user.hashed_password):
            raise ValueError("Invalid credentials")
        return create_access_token(str(user.id))

    async def create_app_session(
        self,
        db: AsyncSession,
        *,
        app_user_id: int | None,
        email: str | None,
        migration_wallet: str | None,
    ) -> str:
        normalized_email = (email or "").strip().lower()
        if not normalized_email:
            if app_user_id is None:
                raise ValueError("Either email or app_user_id is required")
            normalized_email = f"appuser-{app_user_id}@ai.a-network.local"

        result = await db.execute(select(User).where(User.email == normalized_email))
        user = result.scalar_one_or_none()

        if user is None:
            fallback_password = hash_password(f"app-session::{normalized_email}")
            user = User(email=normalized_email, hashed_password=fallback_password)
            db.add(user)
            await db.flush()

            profile = UserProfile(user_id=user.id)
            db.add(profile)
            await db.flush()

        profile_result = await db.execute(select(UserProfile).where(UserProfile.user_id == user.id))
        profile = profile_result.scalar_one_or_none()
        if profile is None:
            profile = UserProfile(user_id=user.id)
            db.add(profile)

        metadata = dict(profile.profile_metadata or {})
        if app_user_id is not None:
            metadata["app_user_id"] = app_user_id
        if migration_wallet:
            metadata["migration_wallet"] = migration_wallet.strip()
        profile.profile_metadata = metadata

        await db.commit()
        return create_access_token(str(user.id))


auth_service = AuthService()
