from fastapi.testclient import TestClient

from app.api.main import create_app
from app.api.routes import infra_test
from app.core.config import Settings


class _FakeSentrySDK:
    @staticmethod
    def capture_exception(_exc):
        return "event-error-123"

    @staticmethod
    def capture_message(_message, level="info"):
        return f"event-{level}-123"

    @staticmethod
    def flush(timeout=2.0):
        return None


def _settings(**overrides) -> Settings:
    defaults = {
        "app_env": "dev",
        "service_name": "api",
        "openai_api_key": "x",
        "gemini_api_key": "x",
        "pinecone_api_key": "x",
        "pinecone_index": "shop-rag",
        "pinecone_cloud": "aws",
        "pinecone_region": "us-east-1",
        "deliveryapi_key": "x",
        "supabase_url": "https://example.supabase.co",
        "supabase_service_role_key": "x",
        "token_encryption_key": "x",
        "cors_allowed_origins": "https://console.example.com",
        "sentry_dsn": "https://examplePublicKey@o0.ingest.sentry.io/0",
        "infra_test_token": "token-123",
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_sentry_test_route_requires_token(monkeypatch) -> None:
    monkeypatch.setattr(infra_test, "get_settings", lambda: _settings())
    monkeypatch.setattr(infra_test, "_get_sentry_sdk", lambda: _FakeSentrySDK())
    app = create_app()
    client = TestClient(app)

    response = client.post("/v1/infra/sentry-test", json={"message": "x", "level": "info"})
    assert response.status_code == 401


def test_sentry_test_route_returns_event_id(monkeypatch) -> None:
    monkeypatch.setattr(infra_test, "get_settings", lambda: _settings())
    monkeypatch.setattr(infra_test, "_get_sentry_sdk", lambda: _FakeSentrySDK())
    app = create_app()
    client = TestClient(app)

    response = client.post(
        "/v1/infra/sentry-test",
        headers={"x-infra-test-token": "token-123"},
        json={"message": "hello", "level": "info"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["event_id"] == "event-info-123"
    assert body["request_id"]
    assert body["sent_at"]


def test_egress_ip_route_requires_token(monkeypatch) -> None:
    monkeypatch.setattr(infra_test, "get_settings", lambda: _settings())
    app = create_app()
    client = TestClient(app)

    response = client.get("/v1/infra/egress-ip")
    assert response.status_code == 401


def test_egress_ip_route_returns_ip(monkeypatch) -> None:
    monkeypatch.setattr(infra_test, "get_settings", lambda: _settings())
    monkeypatch.setattr(infra_test, "_resolve_egress_ip", lambda timeout_seconds=2.0: ("203.0.113.10", "ipify"))
    app = create_app()
    client = TestClient(app)

    response = client.get(
        "/v1/infra/egress-ip",
        headers={"x-infra-test-token": "token-123"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["egress_ip"] == "203.0.113.10"
    assert body["provider"] == "ipify"
    assert body["request_id"]
    assert body["checked_at"]
