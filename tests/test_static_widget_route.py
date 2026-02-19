from fastapi.testclient import TestClient

from app.api.main import create_app


def test_static_faq_widget_is_served() -> None:
    app = create_app()
    client = TestClient(app)

    response = client.get("/static/faq_widget.js")
    assert response.status_code == 200
    assert "data-api-base-url" in response.text
    assert "tenant_id" in response.text

