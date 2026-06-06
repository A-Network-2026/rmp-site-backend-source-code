from __future__ import annotations

import io
from uuid import UUID

from fastapi import UploadFile
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.models import MemoryItem, TrainingExample
from app.services.chroma_service import chroma_memory_service
from app.utils.text_chunking import chunk_text


class MemoryService:
    @staticmethod
    def _extract_upload_text(raw_bytes: bytes, filename: str | None, content_type: str | None) -> str:
        lower_name = (filename or "").lower()
        lower_type = (content_type or "").lower()

        if lower_name.endswith(".pdf") or "pdf" in lower_type:
            reader = PdfReader(io.BytesIO(raw_bytes))
            pages: list[str] = []
            for page in reader.pages:
                page_text = page.extract_text() or ""
                if page_text.strip():
                    pages.append(page_text.strip())
            return "\n\n".join(pages)

        return raw_bytes.decode("utf-8", errors="ignore")

    async def add_memory_text(
        self,
        db: AsyncSession,
        user_id: UUID,
        text: str,
        source_type: str,
        source_ref: str | None,
        metadata: dict | None = None,
    ) -> MemoryItem:
        memory = MemoryItem(
            user_id=user_id,
            source_type=source_type,
            source_ref=source_ref,
            content=text,
            memory_metadata=metadata or {},
        )
        db.add(memory)
        await db.commit()
        await db.refresh(memory)

        chunks = chunk_text(text, settings.chunk_size, settings.chunk_overlap)
        await chroma_memory_service.upsert_memory_chunks(
            user_id=user_id,
            memory_id=memory.id,
            chunks=chunks,
            source_type=source_type,
        )
        return memory

    async def add_uploaded_file_memory(
        self,
        db: AsyncSession,
        user_id: UUID,
        upload: UploadFile,
    ) -> MemoryItem:
        raw_bytes = await upload.read()
        if not raw_bytes:
            raise ValueError("Uploaded file is empty")

        if len(raw_bytes) > settings.max_upload_size_bytes:
            max_mb = settings.max_upload_size_bytes // (1024 * 1024)
            raise ValueError(f"File is too large. Max allowed size is {max_mb} MB")

        text = self._extract_upload_text(raw_bytes, upload.filename, upload.content_type).strip()
        if not text:
            raise ValueError("Could not extract readable text from uploaded file")

        return await self.add_memory_text(
            db=db,
            user_id=user_id,
            text=text,
            source_type="file",
            source_ref=upload.filename,
            metadata={"content_type": upload.content_type},
        )

    async def add_training_example(
        self,
        db: AsyncSession,
        user_id: UUID,
        prompt: str,
        ideal_response: str,
        tags: dict | None = None,
    ) -> TrainingExample:
        example = TrainingExample(
            user_id=user_id,
            prompt=prompt,
            ideal_response=ideal_response,
            training_tags=tags or {},
        )
        db.add(example)
        await db.commit()
        await db.refresh(example)
        return example


memory_service = MemoryService()
