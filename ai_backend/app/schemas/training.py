from pydantic import BaseModel, Field


class TrainingExampleCreateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    ideal_response: str = Field(min_length=1, max_length=12000)
    tags: dict = Field(default_factory=dict)
