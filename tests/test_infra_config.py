import pytest

from app.core.config import Settings


def _api_settings(**overrides) -> Settings:
    defaults = {
        "app_env": "prod",
        "service_name": "api",
        "openai_api_key": "x",
        "gemini_api_key": "x",
        "pinecone_api_key": "x",
        "pinecone_index": "shop-rag",
        "pinecone_cloud": "aws",
        "pinecone_region": "us-east-1",
        "deliveryapi_key": "x",
        "deliveryapi_secret": "x",
        "supabase_url": "https://example.supabase.co",
        "supabase_service_role_key": "x",
        "token_encryption_key": "x",
        "sentry_dsn": "https://examplePublicKey@o0.ingest.sentry.io/0",
        "infra_test_token": "x",
        "cors_allowed_origins": "https://console.example.com",
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_validate_runtime_fails_when_required_env_missing() -> None:
    settings = _api_settings(openai_api_key="")
    with pytest.raises(ValueError):
        settings.validate_runtime()


def test_validate_runtime_requires_cors_in_prod_api() -> None:
    settings = _api_settings(cors_allowed_origins="")
    with pytest.raises(ValueError):
        settings.validate_runtime()


def test_validate_runtime_requires_sentry_and_infra_token_in_prod_api() -> None:
    settings_without_sentry = _api_settings(sentry_dsn="")
    with pytest.raises(ValueError):
        settings_without_sentry.validate_runtime()

    settings_without_infra_token = _api_settings(infra_test_token="")
    with pytest.raises(ValueError):
        settings_without_infra_token.validate_runtime()


def test_get_cors_allowed_origins_parses_csv() -> None:
    settings = _api_settings(cors_allowed_origins="https://a.com, https://b.com")
    assert settings.get_cors_allowed_origins() == ["https://a.com", "https://b.com"]
