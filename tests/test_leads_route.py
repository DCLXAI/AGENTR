from fastapi.testclient import TestClient

from app.api.main import create_app
from app.api.routes import leads


class _StubLeadRepo:
    def __init__(self, save_result: bool) -> None:
        self.save_result = save_result
        self.calls: list[dict] = []

    def save_lead_signup(self, *, email: str, source: str, metadata: dict | None = None) -> bool:
        self.calls.append({"email": email, "source": source, "metadata": metadata or {}})
        return self.save_result


def test_lead_signup_success(monkeypatch) -> None:
    stub = _StubLeadRepo(save_result=True)
    monkeypatch.setattr(leads, "get_supabase_repo", lambda: stub)

    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/v1/leads/signup",
        json={"email": "Owner@Example.com", "source": "homepage", "plan": "trial"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert stub.calls[0]["email"] == "owner@example.com"
    assert stub.calls[0]["source"] == "homepage"
    assert stub.calls[0]["metadata"]["plan"] == "trial"


def test_lead_signup_queued_when_repo_disabled(monkeypatch) -> None:
    stub = _StubLeadRepo(save_result=False)
    monkeypatch.setattr(leads, "get_supabase_repo", lambda: stub)

    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/v1/leads/signup",
        json={"email": "test@example.com", "source": "pricing-pro"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "queued"


def test_lead_signup_validates_email(monkeypatch) -> None:
    stub = _StubLeadRepo(save_result=True)
    monkeypatch.setattr(leads, "get_supabase_repo", lambda: stub)

    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/v1/leads/signup",
        json={"email": "invalid-email", "source": "homepage"},
    )

    assert response.status_code == 400
    assert "유효한 이메일" in response.json()["detail"]
