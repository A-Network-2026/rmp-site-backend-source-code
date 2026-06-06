from __future__ import annotations

from uuid import UUID

import chromadb
from chromadb.api.models.Collection import Collection

from app.core.config import settings
from app.services.ollama_service import ollama_service


class ChromaMemoryService:
    def __init__(self) -> None:
        self.client = chromadb.PersistentClient(path=settings.chroma_persist_directory)
        self.collection: Collection = self.client.get_or_create_collection(
            name=settings.chroma_collection,
            metadata={"hnsw:space": "cosine"},
        )

    async def upsert_memory_chunks(
        self,
        user_id: UUID,
        memory_id: UUID,
        chunks: list[str],
        source_type: str,
    ) -> None:
        if not chunks:
            return

        ids: list[str] = []
        metadatas: list[dict] = []
        embeddings: list[list[float]] = []

        for idx, chunk in enumerate(chunks):
            ids.append(f"{user_id}:{memory_id}:{idx}")
            # user_id metadata is mandatory for strict memory isolation in retrieval.
            metadatas.append(
                {
                    "user_id": str(user_id),
                    "memory_id": str(memory_id),
                    "source_type": source_type,
                }
            )
            embeddings.append(await ollama_service.embed_text(chunk))

        self.collection.upsert(ids=ids, documents=chunks, metadatas=metadatas, embeddings=embeddings)

    async def search_memory(self, user_id: UUID, query: str, top_k: int) -> list[str]:
        query_embedding = await ollama_service.embed_text(query)
        result = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            where={"user_id": str(user_id)},
        )
        documents = result.get("documents", [[]])
        return documents[0] if documents else []


chroma_memory_service = ChromaMemoryService()
