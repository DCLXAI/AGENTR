import time
from functools import lru_cache
from typing import Literal, TypedDict

from app.agents.crewai.review_crew import review_response
from app.core.config import get_settings
from app.core.fallback_codes import FallbackCode
from app.integrations.shipping.client import ShippingAPIError, ShippingClient
from app.rag.retriever import get_rag_service
from app.services.classifier import get_intent_classifier


IntentType = Literal["tracking", "policy", "fallback"]


class SupportGraphState(TypedDict, total=False):
    tenant_id: str
    session_id: str
    user_message: str
    intent: IntentType
    confidence: float
    entities: dict
    answer: str
    sources: list[dict]
    tool_trace: list[dict]
    needs_human: bool
    why_fallback: str | None
    route: str
    tracking_status_raw: str | None
    tracking_progress: dict | None


def _append_trace(state: SupportGraphState, trace: dict) -> None:
    traces = state.get("tool_trace", [])
    traces.append(trace)
    state["tool_trace"] = traces


TRACKING_STAGE_LABELS = {
    1: "결제완료",
    2: "배송중",
    3: "배송완료",
}

TRACKING_STAGE_KEYWORDS = {
    1: ("결제완료", "주문접수", "상품준비중", "출고준비"),
    2: ("배송중", "집화완료", "이동중", "간선상차", "배송출발"),
    3: ("배송완료", "배달완료", "수령완료"),
}

UNSUPPORTED_ACTION_KEYWORDS = (
    "취소해줘",
    "취소 처리",
    "환불해줘",
    "교환해줘",
    "주문 변경",
    "주소 바꿔줘",
    "접수해줘",
    "처리해줘",
)


def _normalize(value: str) -> str:
    return value.strip().lower().replace(" ", "")


def map_tracking_progress(raw_status: str | None) -> dict | None:
    if raw_status is None:
        return None
    status = raw_status.strip()
    if not status:
        return None

    normalized_status = _normalize(status)
    for stage, keywords in TRACKING_STAGE_KEYWORDS.items():
        for keyword in keywords:
            if _normalize(keyword) in normalized_status:
                return {
                    "stage": stage,
                    "label": TRACKING_STAGE_LABELS[stage],
                    "raw_status": raw_status,
                }
    return {
        "stage": None,
        "label": None,
        "raw_status": raw_status,
    }


def _is_unsupported_action_request(question: str) -> bool:
    q = _normalize(question)
    return any(_normalize(keyword) in q for keyword in UNSUPPORTED_ACTION_KEYWORDS)


def classify_node(state: SupportGraphState) -> SupportGraphState:
    settings = get_settings()
    try:
        classifier = get_intent_classifier()
        result = classifier.classify(state["user_message"])
        state["intent"] = result.intent
        state["confidence"] = result.confidence
        state["entities"] = result.entities.model_dump()

        if result.confidence < settings.classification_confidence_threshold:
            state["route"] = "clarify"
        elif result.intent == "tracking":
            state["route"] = "tracking"
        else:
            state["route"] = "rag"
    except Exception:
        state["intent"] = "fallback"
        state["confidence"] = 0.0
        state["entities"] = {}
        state["route"] = "runtime_config"
        state["why_fallback"] = FallbackCode.RUNTIME_CONFIG_MISSING.value
    return state


def route_node(state: SupportGraphState) -> str:
    return state.get("route", "rag")


def clarify_node(state: SupportGraphState) -> SupportGraphState:
    settings = get_settings()
    state["needs_human"] = False
    state["sources"] = []
    state["why_fallback"] = FallbackCode.CLARIFY_LOW_CONFIDENCE.value
    state["tracking_progress"] = None
    state["answer"] = (
        "질문 의도를 정확히 파악하지 못했습니다. "
        "운송장번호 또는 상품/정책 키워드를 조금 더 구체적으로 알려주세요. "
        f"{settings.default_answer_closing}"
    )
    return state


def runtime_config_node(state: SupportGraphState) -> SupportGraphState:
    settings = get_settings()
    state["needs_human"] = True
    state["sources"] = []
    state["tracking_progress"] = None
    state["why_fallback"] = FallbackCode.RUNTIME_CONFIG_MISSING.value
    state["answer"] = (
        "확인 불가입니다. 현재 시스템 설정이 완료되지 않아 자동 응답을 제공할 수 없습니다. "
        "관리자가 API 키 및 연결 상태를 점검한 뒤 다시 안내드리겠습니다. "
        f"{settings.default_answer_closing}"
    )
    return state


def tracking_node(state: SupportGraphState) -> SupportGraphState:
    settings = get_settings()
    entities = state.get("entities", {})
    tracking_number = (entities.get("tracking_number") or "").strip()
    courier_code = (entities.get("courier_code") or settings.default_courier_code).strip()
    state["sources"] = []
    state["tracking_progress"] = None

    if not tracking_number:
        state["answer"] = (
            "배송 조회를 위해 운송장번호가 필요합니다. 운송장번호(10~14자리)를 알려주세요. "
            f"{settings.default_answer_closing}"
        )
        state["needs_human"] = False
        state["why_fallback"] = FallbackCode.TRACKING_MISSING_NUMBER.value
        return state

    client = ShippingClient()
    started = time.perf_counter()
    try:
        result = client.track_delivery(courier_code=courier_code, tracking_number=tracking_number)
        latency_ms = int((time.perf_counter() - started) * 1000)
        _append_trace(
            state,
            {
                "tool": "delivery_tracking",
                "status": "ok",
                "latency_ms": latency_ms,
            },
        )
        state["tracking_status_raw"] = result.status
        state["tracking_progress"] = map_tracking_progress(result.status)
        state["answer"] = (
            f"현재 배송 상태는 '{result.status}'입니다. 최근 이력: {result.last_detail or '상세 이력 없음'}. "
            f"{settings.default_answer_closing}"
        )
        state["needs_human"] = False
        state["why_fallback"] = None
    except (ValueError, ShippingAPIError) as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        _append_trace(
            state,
            {
                "tool": "delivery_tracking",
                "status": "error",
                "latency_ms": latency_ms,
            },
        )
        state["answer"] = (
            "배송 시스템 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요. "
            "급하시면 고객센터로 연결해 드리겠습니다. "
            f"{settings.default_answer_closing}"
        )
        state["needs_human"] = True
        state["why_fallback"] = FallbackCode.TRACKING_API_ERROR.value
        state["error"] = str(exc)
    return state


def rag_node(state: SupportGraphState) -> SupportGraphState:
    settings = get_settings()
    intent: IntentType = state.get("intent", "fallback")
    if intent == "fallback" and _is_unsupported_action_request(state["user_message"]):
        state["answer"] = (
            "현재 MVP에서는 조회형 요청(배송/정책/상품 안내)만 자동 처리할 수 있습니다. "
            "주문 취소/변경/접수는 고객센터를 통해 도와드리겠습니다. "
            f"{settings.default_answer_closing}"
        )
        state["sources"] = []
        state["needs_human"] = True
        state["why_fallback"] = FallbackCode.UNSUPPORTED_ACTION.value
        return state

    try:
        rag_service = get_rag_service()
        upgrade = bool(state.get("confidence", 0.0) < 0.85 and intent == "policy")
        rag_answer = rag_service.answer(
            question=state["user_message"],
            intent=intent,
            upgrade_generation=upgrade,
        )
        state["answer"] = rag_answer.answer
        state["sources"] = [
            {
                "source_id": src["source_id"],
                "title": src["title"],
                "snippet": src["snippet"],
            }
            for src in rag_answer.sources
        ]
        state["needs_human"] = rag_answer.needs_human
        if rag_answer.needs_human:
            if intent == "policy":
                state["why_fallback"] = FallbackCode.POLICY_NO_SOURCE.value
            else:
                state["why_fallback"] = FallbackCode.RAG_NO_SOURCE.value
        else:
            state["why_fallback"] = None
    except Exception:
        state["answer"] = (
            "확인 불가입니다. 현재 지식 검색 시스템 설정이 완료되지 않았습니다. "
            "관리자가 점검 후 안내드리겠습니다. "
            f"{settings.default_answer_closing}"
        )
        state["sources"] = []
        state["needs_human"] = True
        state["why_fallback"] = FallbackCode.RUNTIME_CONFIG_MISSING.value
    return state


def review_node(state: SupportGraphState) -> SupportGraphState:
    review = review_response(
        question=state["user_message"],
        answer=state["answer"],
        intent=state.get("intent", "fallback"),
        sources=state.get("sources", []),
    )
    if not review.get("approved", True):
        settings = get_settings()
        state["answer"] = (
            "확인 불가입니다. 현재 답변을 자동 검수 기준으로 확정할 수 없습니다. "
            "담당자가 확인 후 안내드리겠습니다. "
            f"{settings.default_answer_closing}"
        )
        state["needs_human"] = True
        state["why_fallback"] = FallbackCode.REVIEW_REJECTED.value
    return state


def finalize_node(state: SupportGraphState) -> SupportGraphState:
    settings = get_settings()
    answer = (state.get("answer") or "").strip()
    if answer and not answer.endswith(settings.default_answer_closing):
        answer = f"{answer} {settings.default_answer_closing}"
    state["answer"] = answer
    state["tool_trace"] = state.get("tool_trace", [])
    state["sources"] = state.get("sources", [])
    state["needs_human"] = bool(state.get("needs_human", False))
    state["tracking_progress"] = state.get("tracking_progress")
    state["why_fallback"] = state.get("why_fallback")
    return state


def _build_graph():
    from langgraph.graph import END, StateGraph

    graph = StateGraph(SupportGraphState)
    graph.add_node("classify", classify_node)
    graph.add_node("clarify", clarify_node)
    graph.add_node("runtime_config", runtime_config_node)
    graph.add_node("tracking", tracking_node)
    graph.add_node("rag", rag_node)
    graph.add_node("review", review_node)
    graph.add_node("finalize", finalize_node)

    graph.set_entry_point("classify")
    graph.add_conditional_edges(
        "classify",
        route_node,
        {
            "clarify": "clarify",
            "tracking": "tracking",
            "rag": "rag",
            "runtime_config": "runtime_config",
        },
    )

    graph.add_edge("clarify", "review")
    graph.add_edge("runtime_config", "review")
    graph.add_edge("tracking", "review")
    graph.add_edge("rag", "review")
    graph.add_edge("review", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


@lru_cache(maxsize=1)
def get_support_graph():
    return _build_graph()


def run_support_flow(*, tenant_id: str, session_id: str, user_message: str) -> SupportGraphState:
    app = get_support_graph()
    initial_state: SupportGraphState = {
        "tenant_id": tenant_id,
        "session_id": session_id,
        "user_message": user_message,
        "tool_trace": [],
    }
    return app.invoke(initial_state)
