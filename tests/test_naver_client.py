from app.core.config import Settings
from app.integrations.naver import client as naver_client_module
from app.integrations.naver.client import NaverCommerceAPIError, NaverCommerceClient, NaverCommerceToken


class _StubResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.content = b"" if status_code == 204 else b'{"ok":true}'

    def json(self) -> dict:
        return self._payload


def _settings(**overrides) -> Settings:
    defaults = {
        "app_env": "dev",
        "service_name": "api",
        "naver_commerce_client_id": "client-id",
        "naver_commerce_client_secret": "$2a$04$NakLTFEXke1WIsd3QQjO.O",
        "naver_commerce_base_url": "https://api.commerce.naver.com",
        "request_timeout_seconds": 5,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_issue_access_token_calls_naver_token_endpoint(monkeypatch) -> None:
    monkeypatch.setattr(naver_client_module, "get_settings", lambda: _settings())
    captured: dict = {}

    def fake_post(url: str, data: dict, timeout: int):
        captured["url"] = url
        captured["data"] = data
        captured["timeout"] = timeout
        return _StubResponse(
            200,
            {
                "access_token": "token-abc",
                "token_type": "Bearer",
                "expires_in": 3600,
            },
        )

    monkeypatch.setattr(naver_client_module.requests, "post", fake_post)
    client = NaverCommerceClient()
    out = client.issue_access_token()

    assert captured["url"] == "https://api.commerce.naver.com/external/v1/oauth2/token"
    assert captured["data"]["grant_type"] == "client_credentials"
    assert captured["data"]["client_id"] == "client-id"
    assert captured["data"]["type"] == "SELF"
    assert captured["data"]["client_secret_sign"]
    assert out.access_token == "token-abc"
    assert out.token_type == "Bearer"
    assert out.expires_in == 3600


def test_issue_access_token_raises_on_bad_request(monkeypatch) -> None:
    monkeypatch.setattr(naver_client_module, "get_settings", lambda: _settings())

    def fake_post(url: str, data: dict, timeout: int):
        return _StubResponse(
            400,
            {
                "code": "BadRequest",
                "message": "client_id 항목이 유효하지 않습니다.",
            },
        )

    monkeypatch.setattr(naver_client_module.requests, "post", fake_post)
    client = NaverCommerceClient()
    try:
        client.issue_access_token()
        assert False, "Expected NaverCommerceAPIError"
    except NaverCommerceAPIError as exc:
        assert "유효하지 않습니다" in str(exc)


def test_answer_qna_uses_comment_content_and_handles_204(monkeypatch) -> None:
    monkeypatch.setattr(naver_client_module, "get_settings", lambda: _settings())
    captured: dict = {}

    def fake_request(
        method: str,
        url: str,
        headers: dict,
        params: dict | None,
        json: dict | None,
        timeout: int,
    ):
        captured["method"] = method
        captured["url"] = url
        captured["json"] = json
        return _StubResponse(204, {})

    monkeypatch.setattr(NaverCommerceClient, "issue_access_token", lambda self: NaverCommerceToken("token", "Bearer", 3600))
    monkeypatch.setattr(naver_client_module.requests, "request", fake_request)

    out = NaverCommerceClient().answer_qna(question_id="663810138", answer_text="답변 테스트")
    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/external/v1/contents/qnas/663810138")
    assert captured["json"] == {"commentContent": "답변 테스트"}
    assert out == {}
