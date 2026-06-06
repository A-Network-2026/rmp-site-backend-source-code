from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ChatMessageRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: UUID | None = None


class ChatMessageResponse(BaseModel):
    conversation_id: UUID
    assistant_message: str


class ChatResearchRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    conversation_id: UUID | None = None


class CitationDTO(BaseModel):
    index: int
    snippet: str


class ChatResearchResponse(BaseModel):
    conversation_id: UUID
    assistant_message: str
    citations: list[CitationDTO]


class MessageDTO(BaseModel):
    id: UUID
    role: str
    content: str
    created_at: datetime
