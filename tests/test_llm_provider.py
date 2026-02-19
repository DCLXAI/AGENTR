import pytest

from app.core.config import Settings
from app.services.llm_provider import available_provider_order


def _settings(**overrides) -> Settings:
    defaults = {
        "app_env": "dev",
        "service_name": "api",
        "llm_primary_provider": "gemini",
        "gemini_api_key": "gem-key",
        "openai_api_key": "openai-key",
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_available_provider_order_prefers_gemini_first() -> None:
    settings = _settings(llm_primary_provider="gemini")
    assert available_provider_order(settings) == ["gemini", "openai"]


def test_available_provider_order_prefers_openai_first() -> None:
    settings = _settings(llm_primary_provider="openai")
    assert available_provider_order(settings) == ["openai", "gemini"]


def test_available_provider_order_skips_missing_provider() -> None:
    settings = _settings(openai_api_key="")
    assert available_provider_order(settings) == ["gemini"]


def test_available_provider_order_requires_at_least_one_key() -> None:
    settings = _settings(openai_api_key="", gemini_api_key="")
    with pytest.raises(ValueError):
        available_provider_order(settings)
