from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AppSessionRequest(BaseModel):
    app_user_id: int | None = None
    email: EmailStr | None = None
    migration_wallet: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
