from pydantic import BaseModel, Field


class MemoryCreateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    source_type: str = Field(default="manual", max_length=50)
    source_ref: str | None = Field(default=None, max_length=255)
