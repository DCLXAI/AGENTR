from typing import Any

from app.agents.langgraph import support_graph
from app.core.config import get_settings
from app.core.fallback_codes import FallbackCode
from app.rag.retriever import RAGAnswer
from app.repositories.supabase_repo import SupabaseRepository


def test_clarify_node_sets_fallback_code() -> None:
    state: dict[str, Any] = {"user_message": "잘 모르겠어요"}
    out = support_graph.clarify_node(state)  # type: ignore[arg-type]
    assert out["why_fallback"] == FallbackCode.CLARIFY_LOW_CONFIDENCE.value


def test_tracking_node_missing_number_sets_fallback_code() -> None:
    state: dict[str, Any] = {"entities": {}}
    out = support_graph.tracking_node(state)  # type: ignore[arg-type]
    assert out["why_fallback"] == FallbackCode.TRACKING_MISSING_NUMBER.value


def test_rag_node_policy_no_source_sets_fallback_code(monkeypatch) -> None:
    class FakeRAGService:
        def answer(self, question: str, intent: str, upgrade_generation: bool = False) -> RAGAnswer:
            return RAGAnswer(answer="확인 불가", sources=[], needs_human=True)

    monkeypatch.setattr(support_graph, "get_rag_service", lambda: FakeRAGService())
    state: dict[str, Any] = {
        "user_message": "환불 정책 알려줘",
        "intent": "policy",
        "confidence": 0.9,
    }
    out = support_graph.rag_node(state)  # type: ignore[arg-type]
    assert out["why_fallback"] == FallbackCode.POLICY_NO_SOURCE.value


def test_supabase_repo_log_includes_why_fallback() -> None:
    class StubTable:
        def __init__(self, name: str, bucket: dict[str, list[dict[str, Any]]]):
            self.name = name
            self.bucket = bucket

        def insert(self, payload: dict[str, Any]):
            self.bucket.setdefault(self.name, []).append(payload)
            return self

        def execute(self):
            return self

    class StubClient:
        def __init__(self):
            self.bucket: dict[str, list[dict[str, Any]]] = {}

        def table(self, name: str) -> StubTable:
            return StubTable(name, self.bucket)

    repo = SupabaseRepository(get_settings())
    stub = StubClient()
    repo._client = stub
    repo.log_chat_interaction(
        tenant_id="t1",
        session_id="s1",
        user_message="질문",
        response_payload={"answer": "확인 불가"},
        why_fallback=FallbackCode.POLICY_NO_SOURCE.value,
    )
    payload = stub.bucket["conversation_logs"][0]
    assert payload["why_fallback"] == FallbackCode.POLICY_NO_SOURCE.value

