import time
from collections import deque

from fastapi.testclient import TestClient

from app.api.main import create_app
from app.api.routes import tools
from app.core.config import Settings
from app.integrations.naver.client import NaverCommerceToken


class _FakeNaverClient:
    def issue_access_token(self) -> NaverCommerceToken:
        return NaverCommerceToken(access_token="token-abc", token_type="Bearer", expires_in=3600)

    def list_qnas(
        self,
        *,
        page: int = 1,
        size: int = 20,
        from_date: str | None = None,
        to_date: str | None = None,
    ):
        return {"items": [{"id": "q1"}], "page": page, "size": size}

    def answer_inquiry(self, inquiry_no: str, answer_text: str):
        return {"inquiryNo": inquiry_no, "result": "ok", "answerContent": answer_text}

    def answer_qna(self, question_id: str | int, answer_text: str):
        return {"questionId": str(question_id), "result": "ok", "commentContent": answer_text}


def test_naver_token_check_route(monkeypatch) -> None:
    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClient())
    app = create_app()
    client = TestClient(app)

    response = client.post("/v1/tools/naver/token-check")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["token_type"] == "Bearer"
    assert payload["expires_in"] == 3600
    assert payload["issued_at"]


def test_naver_qna_list_route(monkeypatch) -> None:
    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClient())
    app = create_app()
    client = TestClient(app)

    response = client.get("/v1/tools/naver/qnas?page=2&size=15")
    assert response.status_code == 200
    payload = response.json()
    assert payload["data"]["page"] == 2
    assert payload["data"]["size"] == 15
    assert payload["data"]["items"][0]["id"] == "q1"


def test_naver_answer_route(monkeypatch) -> None:
    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClient())
    app = create_app()
    client = TestClient(app)

    response = client.post(
        "/v1/tools/naver/inquiries/12345/answer",
        json={"answer": "안내드립니다."},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["data"]["inquiryNo"] == "12345"
    assert payload["data"]["answerContent"] == "안내드립니다."


def test_naver_qna_answer_route(monkeypatch) -> None:
    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClient())
    app = create_app()
    client = TestClient(app)

    response = client.post(
        "/v1/tools/naver/qnas/663810138/answer",
        json={"answer": "상품 문의 답변입니다."},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["data"]["questionId"] == "663810138"
    assert payload["data"]["commentContent"] == "상품 문의 답변입니다."


def test_naver_auto_answer_once_dry_run(monkeypatch) -> None:
    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClient())
    monkeypatch.setattr(
        tools,
        "run_support_flow",
        lambda **kwargs: {
            "answer": "자동 생성 답변입니다.",
            "intent": "policy",
            "confidence": 0.92,
            "needs_human": False,
            "why_fallback": None,
        },
    )

    class _FakeNaverClientWithUnanswered(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            return {
                "contents": [
                    {
                        "questionId": 663810138,
                        "question": "지금 구매하면 바로 사용 가능한가요?",
                        "answered": False,
                    }
                ]
            }

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithUnanswered())
    app = create_app()
    client = TestClient(app)

    response = client.post("/v1/tools/naver/auto-answer-once", json={"dry_run": True})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["posted"] is False
    assert payload["reason"] == "dry_run"
    assert payload["question_id"] == "663810138"
    assert payload["answer"] == "자동 생성 답변입니다."


def test_naver_auto_answer_once_with_specific_question_id(monkeypatch) -> None:
    called = {"posted": False}

    class _FakeNaverClientWithAnswer(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            return {
                "contents": [
                    {
                        "questionId": 663810138,
                        "question": "지금 구매하면 바로 사용 가능한가요?",
                        "answered": True,
                    }
                ]
            }

        def answer_qna(self, question_id: str | int, answer_text: str):
            called["posted"] = True
            return {"questionId": str(question_id), "commentContent": answer_text}

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithAnswer())
    monkeypatch.setattr(
        tools,
        "run_support_flow",
        lambda **kwargs: {
            "answer": "자동 생성 답변입니다.",
            "intent": "policy",
            "confidence": 0.9,
            "needs_human": False,
            "why_fallback": None,
        },
    )

    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/v1/tools/naver/auto-answer-once",
        json={"question_id": "663810138", "dry_run": False},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["posted"] is True
    assert payload["question_id"] == "663810138"
    assert called["posted"] is True


def test_naver_auto_answer_once_runtime_fallback_uses_safe_answer(monkeypatch) -> None:
    called = {"posted": False}

    class _FakeNaverClientWithUnanswered(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            return {
                "contents": [
                    {
                        "questionId": 663810138,
                        "question": "문의 테스트",
                        "productName": "GPT PRO",
                        "answered": False,
                    }
                ]
            }

        def answer_qna(self, question_id: str | int, answer_text: str):
            called["posted"] = True
            return {"questionId": str(question_id), "commentContent": answer_text}

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithUnanswered())
    monkeypatch.setattr(
        tools,
        "_generate_naver_safe_answer",
        lambda question, product_name=None: f"{product_name}:{question}:안전 템플릿 답변입니다.",
    )
    monkeypatch.setattr(
        tools,
        "run_support_flow",
        lambda **kwargs: {
            "answer": "확인 불가입니다.",
            "intent": "fallback",
            "confidence": 0.0,
            "needs_human": True,
            "why_fallback": "runtime_config_missing",
        },
    )

    app = create_app()
    client = TestClient(app)
    response = client.post("/v1/tools/naver/auto-answer-once", json={})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["posted"] is True
    assert payload["answer"] == "GPT PRO:문의 테스트:안전 템플릿 답변입니다."
    assert payload["why_fallback"] is None
    assert called["posted"] is True


def test_naver_auto_answer_once_blocks_review_rejected(monkeypatch) -> None:
    class _FakeNaverClientWithUnanswered(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            return {
                "contents": [
                    {
                        "questionId": 663810138,
                        "question": "문의 테스트",
                        "answered": False,
                    }
                ]
            }

        def answer_qna(self, question_id: str | int, answer_text: str):
            raise AssertionError("answer_qna should not be called when review is rejected")

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithUnanswered())
    monkeypatch.setattr(
        tools,
        "run_support_flow",
        lambda **kwargs: {
            "answer": "확인 불가입니다.",
            "intent": "fallback",
            "confidence": 0.0,
            "needs_human": True,
            "why_fallback": "review_rejected",
        },
    )

    app = create_app()
    client = TestClient(app)
    response = client.post("/v1/tools/naver/auto-answer-once", json={})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "blocked"
    assert payload["posted"] is False
    assert payload["reason"] == "unsafe_auto_answer"
    assert payload["why_fallback"] == "review_rejected"


def test_rule_based_naver_answer_varies_by_question_type() -> None:
    a1 = tools._rule_based_naver_answer("가짜 상품 아니죠? 품질이 궁금해요", "GPT PRO")
    a2 = tools._rule_based_naver_answer("배송은 언제 도착하나요?", "GPT PRO")
    a3 = tools._rule_based_naver_answer("사이즈가 어떻게 되나요?", "GPT PRO")

    assert a1 != a2
    assert a2 != a3
    assert "품질" in a1 or "정품" in a1
    assert "배송" in a2
    assert "사이즈" in a3


def test_naver_auto_answer_once_requires_token_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(
        tools,
        "get_settings",
        lambda: Settings(
            app_env="dev",
            service_name="api",
            naver_autoreply_token="secret-token",
            infra_test_token="infra-token",
        ),
    )
    app = create_app()
    client = TestClient(app)

    response = client.post("/v1/tools/naver/auto-answer-once", json={"dry_run": True})
    assert response.status_code == 401

    response_ok = client.post(
        "/v1/tools/naver/auto-answer-once",
        headers={"x-naver-autoreply-token": "secret-token"},
        json={"dry_run": True},
    )
    # downstream Naver mock is not patched, so auth gate 통과 여부만 확인
    assert response_ok.status_code != 401

    response_infra_ok = client.post(
        "/v1/tools/naver/auto-answer-once",
        headers={"x-naver-autoreply-token": "infra-token"},
        json={"dry_run": True},
    )
    assert response_infra_ok.status_code != 401


def test_naver_auto_answer_drain_stops_on_noop(monkeypatch) -> None:
    call_count = {"n": 0}

    class _FakeNaverClientWithSingleUnanswered(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return {
                    "contents": [
                        {
                            "questionId": 663812602,
                            "question": "지금 주문하면 언제 도착하나요?",
                            "productName": "GPT PRO",
                            "answered": False,
                        }
                    ]
                }
            return {
                "contents": [
                    {
                        "questionId": 663812602,
                        "question": "지금 주문하면 언제 도착하나요?",
                        "productName": "GPT PRO",
                        "answered": True,
                    }
                ]
            }

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithSingleUnanswered())
    monkeypatch.setattr(
        tools,
        "run_support_flow",
        lambda **kwargs: {
            "answer": "배송 문의 감사합니다.",
            "intent": "tracking",
            "confidence": 0.91,
            "needs_human": False,
            "why_fallback": None,
        },
    )

    app = create_app()
    client = TestClient(app)
    response = client.post(
        "/v1/tools/naver/auto-answer-drain",
        json={"max_iterations": 5, "dry_run": False},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"done", "ok"}
    assert body["posted"] >= 1
    assert body["processed"] >= 2


def test_naver_auto_answer_drain_requires_token_when_configured(monkeypatch) -> None:
    monkeypatch.setattr(
        tools,
        "get_settings",
        lambda: Settings(
            app_env="dev",
            service_name="api",
            naver_autoreply_token="secret-token",
        ),
    )
    app = create_app()
    client = TestClient(app)

    response = client.post("/v1/tools/naver/auto-answer-drain", json={"max_iterations": 1})
    assert response.status_code == 401


def test_naver_public_demo_feed_returns_latest_qnas(monkeypatch) -> None:
    class _FakeNaverClientWithContents(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            return {
                "contents": [
                    {
                        "questionId": 9001,
                        "question": "재고 있나요?",
                        "answered": True,
                        "answerContent": "네, 재고 있습니다.",
                    }
                ]
            }

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithContents())
    monkeypatch.setattr(tools, "_PUBLIC_DEMO_LAST_RUN_TS", time.time())
    app = create_app()
    client = TestClient(app)

    response = client.get("/v1/tools/naver/public-demo-feed")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["latest_qnas"][0]["question_id"] == "9001"
    assert body["latest_qnas"][0]["answer"] == "네, 재고 있습니다."


def test_naver_public_demo_feed_runs_auto_answer_and_records_event(monkeypatch) -> None:
    class _FakeNaverClientWithUnanswered(_FakeNaverClient):
        def list_qnas(self, **kwargs):
            return {
                "contents": [
                    {
                        "questionId": 9010,
                        "question": "오늘 출고되나요?",
                        "productName": "GPT PRO",
                        "answered": False,
                    }
                ]
            }

    monkeypatch.setattr(tools, "NaverCommerceClient", lambda: _FakeNaverClientWithUnanswered())
    monkeypatch.setattr(
        tools,
        "run_support_flow",
        lambda **kwargs: {
            "answer": "오늘 순차 출고 예정입니다.",
            "intent": "tracking",
            "confidence": 0.95,
            "needs_human": False,
            "why_fallback": None,
        },
    )
    monkeypatch.setattr(tools, "_PUBLIC_DEMO_LAST_RUN_TS", 0.0)
    monkeypatch.setattr(tools, "_PUBLIC_DEMO_MIN_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(tools, "_PUBLIC_DEMO_RECENT_EVENTS", deque(maxlen=30))

    app = create_app()
    client = TestClient(app)

    response = client.get("/v1/tools/naver/public-demo-feed")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["auto_result"]["status"] == "ok"
    assert body["auto_result"]["posted"] is True
    assert body["recent_events"][0]["question_id"] == "9010"
