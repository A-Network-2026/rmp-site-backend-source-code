from __future__ import annotations

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from app.core.config import settings

_GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
# Groq does not offer an embeddings endpoint; use a lightweight local fallback
# via a simple hash-based pseudo-embedding so ChromaDB still works.
_EMBED_DIM = 384


class OllamaService:
    """LLM service backed by Groq (OpenAI-compatible API)."""

    def __init__(self) -> None:
        raw_model = settings.ollama_chat_model.strip()
        self.chat_model = self._normalize_model(raw_model)
        self.api_key = settings.groq_api_key

    @staticmethod
    def _normalize_model(model: str) -> str:
        legacy_map = {
            "llama3": "llama-3.1-8b-instant",
            "llama3-8b-8192": "llama-3.1-8b-instant",
        }
        return legacy_map.get(model.lower(), model)

    @staticmethod
    def _clip_text(text: str, max_chars: int) -> str:
        if max_chars <= 0:
            return ""
        if len(text) <= max_chars:
            return text
        suffix = "\n\n[Context truncated to fit model limits]"
        keep = max(0, max_chars - len(suffix))
        return f"{text[:keep]}{suffix}"

    def _prepare_prompts(self, system_prompt: str, user_prompt: str) -> tuple[str, str]:
        max_system = max(800, int(settings.llm_max_system_chars))
        max_user = max(300, int(settings.llm_max_user_chars))
        max_total = max(1200, int(settings.llm_max_input_chars))

        clipped_system = self._clip_text(system_prompt, max_system)
        clipped_user = self._clip_text(user_prompt, max_user)

        total_len = len(clipped_system) + len(clipped_user)
        if total_len <= max_total:
            return clipped_system, clipped_user

        overflow = total_len - max_total
        reduce_user = min(max(0, len(clipped_user) - 300), overflow)
        if reduce_user > 0:
            clipped_user = self._clip_text(clipped_user, len(clipped_user) - reduce_user)
            overflow -= reduce_user

        if overflow > 0:
            reduce_system = min(max(0, len(clipped_system) - 800), overflow)
            if reduce_system > 0:
                clipped_system = self._clip_text(clipped_system, len(clipped_system) - reduce_system)

        return clipped_system, clipped_user

    async def _chat_once(self, model: str, system_prompt: str, user_prompt: str) -> str:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        async with httpx.AsyncClient(timeout=120) as client:
            try:
                response = await client.post(_GROQ_CHAT_URL, json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
            except httpx.HTTPStatusError as e:
                status_code = e.response.status_code
                error_body = e.response.text[:500]
                raise RuntimeError(f"Groq API HTTP {status_code}: {error_body}") from e
            except httpx.HTTPError as e:
                raise RuntimeError(f"Groq API connection error: {str(e)}") from e
        return data["choices"][0]["message"]["content"].strip()

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=6), reraise=True)
    async def chat(self, system_prompt: str, user_prompt: str) -> str:
        prepared_system, prepared_user = self._prepare_prompts(system_prompt, user_prompt)
        fallback_models = [
            self.chat_model,
            "llama-3.1-8b-instant",
            "llama-3.3-70b-versatile",
        ]
        tried: set[str] = set()
        last_error: Exception | None = None

        for model in fallback_models:
            if model in tried:
                continue
            tried.add(model)
            try:
                return await self._chat_once(
                    model=model,
                    system_prompt=prepared_system,
                    user_prompt=prepared_user,
                )
            except RuntimeError as exc:
                last_error = exc
                error_text = str(exc)

                if "Groq API HTTP 413" in error_text:
                    # Retry once with heavily compacted prompts before moving on.
                    compact_system = self._clip_text(prepared_system, max(800, len(prepared_system) // 2))
                    compact_user = self._clip_text(prepared_user, max(300, len(prepared_user) // 2))
                    try:
                        return await self._chat_once(
                            model=model,
                            system_prompt=compact_system,
                            user_prompt=compact_user,
                        )
                    except RuntimeError as compact_exc:
                        last_error = compact_exc

                # Only continue fallback chain for model deprecation errors.
                if "model_decommissioned" not in error_text and "Groq API HTTP 413" not in error_text:
                    raise

        if last_error is not None:
            raise last_error
        raise RuntimeError("Groq API chat failed for all fallback models")

    async def embed_text(self, text: str) -> list[float]:
        """Deterministic pseudo-embedding so ChromaDB works without a vector model."""
        import hashlib
        import struct
        seed = hashlib.sha256(text.encode()).digest()
        floats: list[float] = []
        for i in range(_EMBED_DIM):
            b = seed[(i * 2) % len(seed) : (i * 2) % len(seed) + 4]
            if len(b) < 4:
                b = b + seed[: 4 - len(b)]
            val = struct.unpack("<f", b)[0]
            floats.append(float(val))
        norm = (sum(x * x for x in floats) ** 0.5) or 1.0
        return [x / norm for x in floats]


ollama_service = OllamaService()
