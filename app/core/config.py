from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: Literal["dev", "staging", "prod"] = "dev"
    service_name: Literal["api", "console"] = "api"
    llm_primary_provider: Literal["gemini", "openai"] = "gemini"

    openai_api_key: str = Field(default="")
    openai_model_classifier: str = "gpt-4o-mini"
    openai_model_generation: str = "gpt-4o-mini"
    openai_model_generation_upgrade: str = "gpt-4o"
    openai_model_paraphraser: str = "gpt-4o"
    gemini_api_key: str = Field(default="")
    gemini_model_classifier: str = "gemini-2.0-flash-lite"
    gemini_model_generation: str = "gemini-2.0-flash-lite"
    gemini_model_generation_upgrade: str = "gemini-2.0-flash"
    embedding_provider: Literal["gemini", "openai"] = "gemini"
    embedding_model: str = "text-embedding-3-small"
    embedding_model_gemini: str = "models/gemini-embedding-001"
    embedding_output_dimensionality: int = 1536

    pinecone_api_key: str = Field(default="")
    pinecone_index: str = "shop-rag"
    pinecone_index_host: str = Field(default="")
    pinecone_cloud: str = "aws"
    pinecone_region: str = "us-east-1"
    retriever_k: int = 4

    classification_confidence_threshold: float = 0.75
    source_score_threshold: float = 0.35

    default_answer_closing: str = "추가로 궁금하신 점 있으신가요?"
    default_courier_code: str = "lotte"
    crewai_review_enabled: bool = False

    deliveryapi_key: str = Field(default="")
    deliveryapi_secret: str = Field(default="")
    deliveryapi_base_url: str = "https://api.deliveryapi.co.kr"
    sweettracker_api_key: str = Field(default="")
    sweettracker_base_url: str = "https://info.sweettracker.co.kr"
    request_timeout_seconds: int = 20
    max_retry_attempts: int = 3

    cafe24_mall_id: str = Field(default="")
    cafe24_client_id: str = Field(default="")
    cafe24_client_secret: str = Field(default="")
    naver_commerce_client_id: str = Field(default="")
    naver_commerce_client_secret: str = Field(default="")
    naver_commerce_base_url: str = "https://api.commerce.naver.com"
    naver_autoreply_token: str = Field(default="")
    naver_autoreply_worker_enabled: bool = True
    naver_autoreply_worker_interval_seconds: int = 15
    naver_autoreply_worker_page_size: int = 50
    naver_autoreply_worker_tenant_id: str = "tenant-demo"

    supabase_url: str = Field(default="")
    supabase_service_role_key: str = Field(default="")

    token_encryption_key: str = Field(default="")
    sentry_dsn: str = Field(default="")
    infra_test_token: str = Field(default="")
    cors_allowed_origins: str = Field(default="")
    api_base_url: str = Field(default="")

    def _is_missing(self, value: str) -> bool:
        return not value or not value.strip()

    def get_cors_allowed_origins(self) -> list[str]:
        raw = self.cors_allowed_origins.strip()
        if not raw:
            return []
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    def required_env_for_api(self) -> dict[str, str]:
        return {
            "OPENAI_API_KEY": self.openai_api_key,
            "GEMINI_API_KEY": self.gemini_api_key,
            "PINECONE_API_KEY": self.pinecone_api_key,
            "PINECONE_INDEX": self.pinecone_index,
            "PINECONE_CLOUD": self.pinecone_cloud,
            "PINECONE_REGION": self.pinecone_region,
            "DELIVERYAPI_KEY": self.deliveryapi_key or self.sweettracker_api_key,
            "SUPABASE_URL": self.supabase_url,
            "SUPABASE_SERVICE_ROLE_KEY": self.supabase_service_role_key,
            "TOKEN_ENCRYPTION_KEY": self.token_encryption_key,
            "CORS_ALLOWED_ORIGINS": self.cors_allowed_origins,
        }

    def required_env_for_console(self) -> dict[str, str]:
        return {"API_BASE_URL": self.api_base_url}

    def missing_required_env_for_api(self) -> list[str]:
        return [name for name, value in self.required_env_for_api().items() if self._is_missing(value)]

    def missing_required_env_for_console(self) -> list[str]:
        return [name for name, value in self.required_env_for_console().items() if self._is_missing(value)]

    def validate_runtime(self) -> None:
        if self.app_env not in {"staging", "prod"}:
            return

        if self.service_name == "api":
            missing = self.missing_required_env_for_api()
        else:
            missing = self.missing_required_env_for_console()

        if missing:
            missing_names = ", ".join(missing)
            raise ValueError(f"Missing required environment variables for {self.service_name}: {missing_names}")

        if self.service_name == "api":
            if not self.get_cors_allowed_origins():
                raise ValueError("CORS_ALLOWED_ORIGINS must be set for API service in staging/prod.")
            if self._is_missing(self.sentry_dsn):
                raise ValueError("SENTRY_DSN must be set for API service in staging/prod.")
            if self._is_missing(self.infra_test_token):
                raise ValueError("INFRA_TEST_TOKEN must be set for API service in staging/prod.")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
