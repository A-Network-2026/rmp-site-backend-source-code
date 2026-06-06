"""
AdMob Server-Side Verification (SSV) callback handler.

Google calls GET /api/ads/ssv/<secret> after a rewarded ad is fully watched.
We look up the user via the integer app_user_id stored in profile metadata,
de-duplicate by transaction_id, then credit ai_token_balance.

Reference: https://developers.google.com/admob/android/ssv
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import AiSsvTransaction, UserProfile
from app.db.session import get_db_session

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get(
    "/api/ads/ssv/{secret}",
    response_class=PlainTextResponse,
    include_in_schema=False,
)
async def admob_ssv_callback(
    secret: str,
    request: Request,
    ad_unit_id: Optional[str] = None,
    custom_data: Optional[str] = None,
    reward_amount: Optional[str] = None,
    reward_item: Optional[str] = None,
    transaction_id: Optional[str] = None,
    user_id: Optional[str] = None,
    key_id: Optional[str] = None,
    signature: Optional[str] = None,
    db: AsyncSession = Depends(get_db_session),
) -> PlainTextResponse:
    """
    Always returns HTTP 200 so Google does not retry on application errors.
    """

    # ── 1. Path-secret guard ──────────────────────────────────────────────────
    if not settings.admob_ssv_secret or secret != settings.admob_ssv_secret:
        logger.warning("SSV: invalid secret from %s", request.client.host if request.client else "unknown")
        return PlainTextResponse("OK", status_code=200)

    # ── 2. Resolve integer app_user_id from custom_data ───────────────────────
    raw_id = custom_data or user_id
    try:
        app_user_id = int(raw_id) if raw_id else None
    except (ValueError, TypeError):
        app_user_id = None

    if not app_user_id or app_user_id <= 0:
        logger.warning("SSV: cannot resolve user from custom_data=%s user_id=%s", custom_data, user_id)
        return PlainTextResponse("OK", status_code=200)

    # ── 3. Find UserProfile by app_user_id stored in metadata ─────────────────
    result = await db.execute(
        select(UserProfile).where(
            UserProfile.profile_metadata["app_user_id"].astext == str(app_user_id)
        )
    )
    profile = result.scalar_one_or_none()

    if profile is None:
        logger.warning("SSV: no profile found for app_user_id=%s", app_user_id)
        return PlainTextResponse("OK", status_code=200)

    # ── 4. Validate reward item ────────────────────────────────────────────────
    item = (reward_item or "AI_TOKEN").upper()
    if item != "AI_TOKEN":
        logger.warning("SSV: unexpected reward_item=%s, ignoring", reward_item)
        return PlainTextResponse("OK", status_code=200)

    # Enforce reward value from server config only; never trust callback amount.
    amount = max(1, int(settings.ai_token_ad_reward_amount))

    # ── 5. De-duplicate by transaction_id ─────────────────────────────────────
    txn_id = (transaction_id or "").strip()
    if not txn_id:
        logger.warning("SSV: missing transaction_id for app_user_id=%s, ignoring", app_user_id)
        return PlainTextResponse("OK", status_code=200)

    dup = await db.execute(
        select(AiSsvTransaction.id).where(AiSsvTransaction.transaction_id == txn_id).limit(1)
    )
    if dup.scalar_one_or_none() is not None:
        logger.info("SSV: duplicate transaction_id=%s, skipping", txn_id)
        return PlainTextResponse("OK", status_code=200)

    # ── 6. Record transaction and credit tokens ────────────────────────────────
    try:
        ssv_row = AiSsvTransaction(
            transaction_id=txn_id,
            user_profile_id=profile.id,
            ad_unit_id=ad_unit_id,
            reward_amount=amount,
            reward_item=item,
        )
        db.add(ssv_row)

        await db.execute(
            update(UserProfile)
            .where(UserProfile.id == profile.id)
            .values(ai_token_balance=UserProfile.ai_token_balance + amount)
        )

        await db.commit()
        logger.info(
            "SSV: credited %d %s to app_user_id=%s (profile=%s), txn=%s",
            amount, item, app_user_id, profile.id, txn_id,
        )
    except Exception as exc:
        await db.rollback()
        logger.error("SSV: DB error crediting reward: %s", exc, exc_info=True)

    return PlainTextResponse("OK", status_code=200)
