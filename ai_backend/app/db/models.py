from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
import uuid

from app.db.base import Base


class User(Base):
    __tablename__ = "ai_users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    profile: Mapped[UserProfile] = relationship("UserProfile", back_populates="user", uselist=False)


class UserProfile(Base):
    __tablename__ = "ai_user_profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_users.id", ondelete="CASCADE"), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    personality_prompt: Mapped[str] = mapped_column(Text, default="Be helpful, concise, and safe.")
    private_context: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile_metadata: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)
    ai_token_balance: Mapped[int] = mapped_column(Integer, default=20, server_default="20", nullable=False)

    user: Mapped[User] = relationship("User", back_populates="profile")


class Conversation(Base):
    __tablename__ = "ai_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str | None] = mapped_column(String(250), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Message(Base):
    __tablename__ = "ai_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MemoryItem(Base):
    __tablename__ = "ai_memory_items"
    __table_args__ = (UniqueConstraint("user_id", "source_ref", name="uq_ai_memory_items_user_source"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_users.id", ondelete="CASCADE"), index=True)
    source_type: Mapped[str] = mapped_column(String(50))
    source_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content: Mapped[str] = mapped_column(Text)
    memory_metadata: Mapped[dict] = mapped_column("metadata", JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TrainingExample(Base):
    __tablename__ = "ai_training_examples"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_users.id", ondelete="CASCADE"), index=True)
    prompt: Mapped[str] = mapped_column(Text)
    ideal_response: Mapped[str] = mapped_column(Text)
    training_tags: Mapped[dict] = mapped_column("tags", JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AiSsvTransaction(Base):
    """De-duplication log for AdMob Server-Side Verification callbacks."""

    __tablename__ = "ai_ssv_transactions"
    __table_args__ = (UniqueConstraint("transaction_id", name="uq_ai_ssv_transaction_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    transaction_id: Mapped[str] = mapped_column(String(512), nullable=False, unique=True, index=True)
    user_profile_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("ai_user_profiles.id", ondelete="CASCADE"), index=True)
    ad_unit_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    reward_amount: Mapped[int] = mapped_column(Integer, nullable=False, default=8)
    reward_item: Mapped[str] = mapped_column(String(64), nullable=False, default="AI_TOKEN")
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


Index("ix_ai_messages_user_conversation", Message.user_id, Message.conversation_id)
