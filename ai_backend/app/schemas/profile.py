from pydantic import BaseModel, Field


class ProfileResponse(BaseModel):
    display_name: str | None
    personality_prompt: str
    private_context: str | None
    ai_token_balance: int


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    personality_prompt: str | None = None
    private_context: str | None = None
