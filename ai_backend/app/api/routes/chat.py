from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from tenacity import RetryError

from app.api.deps import get_current_user
from app.db.models import User
from app.db.session import get_db_session
from app.schemas.chat import (
    ChatMessageRequest,
    ChatMessageResponse,
    ChatResearchRequest,
    ChatResearchResponse,
    CitationDTO,
    MessageDTO,
)
from app.services.chat_service import chat_service


router = APIRouter(prefix="/chat")


def _extract_chat_error(exc: Exception) -> str:
    if isinstance(exc, RetryError):
        inner = exc.last_attempt.exception()
        if inner is not None:
            return str(inner)
    return str(exc)


@router.post("/message", response_model=ChatMessageResponse)
async def send_chat_message(
    payload: ChatMessageRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> ChatMessageResponse:
    try:
        conversation, assistant_message = await chat_service.send_message(
            db=db,
            user_id=current_user.id,
            message_text=payload.message,
            conversation_id=payload.conversation_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Chat provider error: {_extract_chat_error(exc)}",
        ) from exc

    return ChatMessageResponse(
        conversation_id=conversation.id,
        assistant_message=assistant_message.content,
    )


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageDTO])
async def list_conversation_messages(
    conversation_id: UUID,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> list[MessageDTO]:
    messages = await chat_service.list_messages(db=db, user_id=current_user.id, conversation_id=conversation_id)
    return [
        MessageDTO(
            id=msg.id,
            role=msg.role,
            content=msg.content,
            created_at=msg.created_at,
        )
        for msg in messages
    ]


@router.post("/research", response_model=ChatResearchResponse)
async def send_chat_research(
    payload: ChatResearchRequest,
    db: AsyncSession = Depends(get_db_session),
    current_user: User = Depends(get_current_user),
) -> ChatResearchResponse:
    try:
        conversation, assistant_message, citations = await chat_service.send_research_message(
            db=db,
            user_id=current_user.id,
            message_text=payload.message,
            conversation_id=payload.conversation_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Chat provider error: {_extract_chat_error(exc)}",
        ) from exc

    return ChatResearchResponse(
        conversation_id=conversation.id,
        assistant_message=assistant_message.content,
        citations=[CitationDTO(index=idx + 1, snippet=snippet) for idx, snippet in enumerate(citations)],
    )
