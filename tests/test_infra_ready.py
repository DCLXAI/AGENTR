from app.api.routes import infra
from app.core.config import Settings


def _ready_settings(**overrides) -> Settings:
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
        "cors_allowed_origins": "https://console.example.com",
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_ready_returns_ok_when_all_checks_pass(monkeypatch) -> None:
    monkeypatch.setattr(infra, "get_settings", lambda: _ready_settings())
    monkeypatch.setattr(infra, "_check_supabase", lambda: None)
    monkeypatch.setattr(infra, "_check_pinecone", lambda: None)
    response = infra.ready()
    assert response.status == "ok"
    assert response.checks.env == "ok"
    assert response.checks.supabase == "ok"
    assert response.checks.pinecone == "ok"


def test_ready_returns_fail_when_env_missing(monkeypatch) -> None:
    monkeypatch.setattr(infra, "get_settings", lambda: _ready_settings(openai_api_key=""))
    monkeypatch.setattr(infra, "_check_supabase", lambda: None)
    monkeypatch.setattr(infra, "_check_pinecone", lambda: None)
    response = infra.ready()
    assert response.status == "fail"
    assert response.checks.env == "fail"
    assert any(item.startswith("env:OPENAI_API_KEY") for item in response.details.failed)


def test_ready_returns_degraded_when_single_dependency_fails(monkeypatch) -> None:
    monkeypatch.setattr(infra, "get_settings", lambda: _ready_settings())
    monkeypatch.setattr(infra, "_check_supabase", lambda: None)

    def fail_pinecone() -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(infra, "_check_pinecone", fail_pinecone)
    response = infra.ready()
    assert response.status == "degraded"
    assert response.checks.supabase == "ok"
    assert response.checks.pinecone == "fail"
