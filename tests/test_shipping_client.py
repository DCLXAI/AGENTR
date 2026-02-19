import requests

from app.core.config import Settings
from app.integrations.shipping import client as shipping_client_module
from app.integrations.shipping.client import ShippingAPIError, ShippingClient


class _StubResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"status={self.status_code}")


def _settings(**overrides) -> Settings:
    defaults = {
        "app_env": "dev",
        "service_name": "api",
        "deliveryapi_key": "legacy-key",
        "deliveryapi_secret": "legacy-secret",
        "deliveryapi_base_url": "https://legacy.example.com",
        "sweettracker_api_key": "sweet-key",
        "sweettracker_base_url": "https://info.sweettracker.co.kr",
        "request_timeout_seconds": 5,
        "max_retry_attempts": 2,
    }
    defaults.update(overrides)
    return Settings(**defaults)


def test_track_delivery_uses_sweettracker_get_and_parses_payload(monkeypatch) -> None:
    monkeypatch.setattr(shipping_client_module, "get_settings", lambda: _settings())
    captured: dict = {}

    def fake_get(url: str, params: dict, timeout: int):
        captured["url"] = url
        captured["params"] = params
        return _StubResponse(
            200,
            {
                "result": "Y",
                "trackingDetails": [
                    {"timeString": "2026-02-19 18:00:00", "where": "서울허브", "kind": "배송중"}
                ],
            },
        )

    monkeypatch.setattr(shipping_client_module.requests, "get", fake_get)
    monkeypatch.setattr(shipping_client_module.requests, "post", lambda *args, **kwargs: _StubResponse(500, {}))

    client = ShippingClient()
    out = client.track_delivery(courier_code="lotte", tracking_number="123456789012")

    assert captured["url"].endswith("/api/v1/trackingInfo")
    assert captured["params"]["t_key"] == "sweet-key"
    assert captured["params"]["t_code"] == "08"
    assert captured["params"]["t_invoice"] == "123456789012"
    assert out.status == "배송중"
    assert "서울허브" in out.last_detail


def test_track_delivery_falls_back_to_post_when_get_not_allowed(monkeypatch) -> None:
    monkeypatch.setattr(shipping_client_module, "get_settings", lambda: _settings())
    calls = {"get": 0, "post": 0}

    def fake_get(url: str, params: dict, timeout: int):
        calls["get"] += 1
        return _StubResponse(405, {"message": "Method Not Allowed"})

    def fake_post(url: str, json: dict, timeout: int):
        calls["post"] += 1
        return _StubResponse(
            200,
            {
                "result": "Y",
                "lastDetail": {"timeString": "2026-02-19 19:00:00", "where": "부산", "kind": "배달완료"},
            },
        )

    monkeypatch.setattr(shipping_client_module.requests, "get", fake_get)
    monkeypatch.setattr(shipping_client_module.requests, "post", fake_post)

    client = ShippingClient()
    out = client.track_delivery(courier_code="08", tracking_number="123456789012")

    assert calls["get"] == 1
    assert calls["post"] == 1
    assert out.status == "배달완료"


def test_track_delivery_raises_on_api_failure_payload(monkeypatch) -> None:
    monkeypatch.setattr(shipping_client_module, "get_settings", lambda: _settings())

    def fake_get(url: str, params: dict, timeout: int):
        return _StubResponse(200, {"result": "N", "msg": "운송장 정보가 없습니다."})

    monkeypatch.setattr(shipping_client_module.requests, "get", fake_get)
    monkeypatch.setattr(shipping_client_module.requests, "post", lambda *args, **kwargs: _StubResponse(500, {}))

    client = ShippingClient()
    try:
        client.track_delivery(courier_code="08", tracking_number="123456789012")
        assert False, "Expected ShippingAPIError"
    except ShippingAPIError as exc:
        assert "운송장 정보가 없습니다." in str(exc)
