from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "A-Network AI Backend"
    app_env: str = "development"
    api_v1_prefix: str = "/api/v1"

    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 60 * 24 * 7
    ads_support_token: str = ""

    postgres_dsn: str

    chroma_persist_directory: str = "./chroma_data"
    chroma_collection: str = "anet_user_memory"

    groq_api_key: str
    ollama_chat_model: str = "llama-3.1-8b-instant"  # Groq model name
    ollama_embed_model: str = "nomic-embed-text"  # unused; kept for compat

    rag_top_k: int = 6
    research_top_k: int = 10
    chunk_size: int = 900
    chunk_overlap: int = 180
    max_upload_size_bytes: int = 5 * 1024 * 1024
    whitepaper_source_path: str = "docs/whitepaper.html"
    whitepaper_max_chars: int = 50000
    llm_max_input_chars: int = 16000
    llm_max_system_chars: int = 12000
    llm_max_user_chars: int = 4000

    # AdMob Server-Side Verification
    admob_ssv_secret: str = ""
    admob_ssv_verify_signature: bool = False
    ai_token_ad_reward_amount: int = 8

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    @field_validator("groq_api_key")
    @classmethod
    def groq_api_key_required(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("GROQ_API_KEY environment variable is required and cannot be empty")
        return v.strip()


settings = Settings()
