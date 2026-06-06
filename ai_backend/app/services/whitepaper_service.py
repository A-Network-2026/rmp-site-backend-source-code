from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from pathlib import Path
import re

from app.core.config import settings


_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_MULTI_NEWLINE_RE = re.compile(r"\n{3,}")


@dataclass
class WhitepaperSnapshot:
    loaded: bool
    source_path: str
    loaded_at: str | None
    source_mtime: str | None
    character_count: int


class WhitepaperService:
    def __init__(self) -> None:
        self._cached_path: str | None = None
        self._cached_mtime: float | None = None
        self._cached_text: str | None = None
        self._cached_loaded_at: datetime | None = None

    @staticmethod
    def _resolve_source_path() -> Path:
        configured = Path(settings.whitepaper_source_path)
        if configured.is_absolute():
            return configured

        backend_root = Path(__file__).resolve().parents[2]
        primary = (backend_root / configured).resolve()
        if primary.exists():
            return primary

        repo_root = backend_root.parent
        fallback = (repo_root / "docs" / "whitepaper.html").resolve()
        return fallback

    @staticmethod
    def _html_to_text(html: str) -> str:
        no_scripts = re.sub(r"<script[\\s\\S]*?</script>", " ", html, flags=re.IGNORECASE)
        no_styles = re.sub(r"<style[\\s\\S]*?</style>", " ", no_scripts, flags=re.IGNORECASE)
        # Preserve lightweight structure so the LLM sees sections and bullets.
        with_breaks = re.sub(r"</?(h1|h2|h3|h4|h5|h6|p|div|section|article|br|tr|table)>", "\n", no_styles, flags=re.IGNORECASE)
        with_breaks = re.sub(r"<li[^>]*>", "\n- ", with_breaks, flags=re.IGNORECASE)
        no_tags = _TAG_RE.sub(" ", with_breaks)
        plain = unescape(no_tags)
        plain = re.sub(r"[ \t\r\f\v]+", " ", plain)
        plain = re.sub(r" *\n *", "\n", plain)
        plain = _MULTI_NEWLINE_RE.sub("\n\n", plain)
        return plain.strip()

    def get_canonical_knowledge(self, fallback_text: str) -> str:
        source_path = self._resolve_source_path()
        if not source_path.exists():
            return fallback_text

        stat = source_path.stat()
        path_str = str(source_path)
        mtime = stat.st_mtime
        if (
            self._cached_text is not None
            and self._cached_path == path_str
            and self._cached_mtime == mtime
        ):
            return self._cached_text

        raw_html = source_path.read_text(encoding="utf-8", errors="ignore")
        text = self._html_to_text(raw_html)
        if not text:
            return fallback_text

        max_chars = max(1000, settings.whitepaper_max_chars)
        text = text[:max_chars]

        self._cached_path = path_str
        self._cached_mtime = mtime
        self._cached_text = text
        self._cached_loaded_at = datetime.now(tz=timezone.utc)
        return text

    def get_snapshot(self, fallback_text: str) -> WhitepaperSnapshot:
        text = self.get_canonical_knowledge(fallback_text)
        source_path = self._resolve_source_path()

        loaded_at = self._cached_loaded_at.isoformat() if self._cached_loaded_at else None
        source_mtime = None
        if source_path.exists():
            source_mtime = datetime.fromtimestamp(source_path.stat().st_mtime, tz=timezone.utc).isoformat()

        return WhitepaperSnapshot(
            loaded=source_path.exists(),
            source_path=str(source_path),
            loaded_at=loaded_at,
            source_mtime=source_mtime,
            character_count=len(text),
        )


whitepaper_service = WhitepaperService()
