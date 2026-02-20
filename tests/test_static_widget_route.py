from fastapi.testclient import TestClient

from app.api.main import create_app


def test_static_faq_widget_is_served() -> None:
    app = create_app()
    client = TestClient(app)

    response = client.get("/static/faq_widget.js")
    assert response.status_code == 200
    assert "data-api-base-url" in response.text
    assert "tenant_id" in response.text


def test_static_mvp_demo_page_is_served() -> None:
    app = create_app()
    client = TestClient(app)

    response = client.get("/static/mvp_demo.html")
    assert response.status_code == 200
    assert "쇼핑몰 CS 자동화 MVP 데모" in response.text
    assert "/v1/chat/query" in response.text
    assert "실시간 문의 자동응답 모니터" in response.text


def test_root_redirects_to_mvp_demo() -> None:
    app = create_app()
    client = TestClient(app)

    response = client.get("/", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/static/mvp_demo.html"
