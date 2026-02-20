import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate

from app.agents.langgraph.support_graph import run_support_flow
from app.core.config import get_settings
from app.core.fallback_codes import FallbackCode
from app.integrations.naver.client import NaverCommerceAPIError, NaverCommerceClient
from app.integrations.shipping.client import ShippingAPIError, ShippingClient
from app.services.llm_provider import invoke_with_fallback


router = APIRouter(prefix="/v1/tools", tags=["tools"])


class TrackDeliveryRequest(BaseModel):
    courier_code: str = Field(min_length=1)
    tracking_number: str = Field(min_length=10)


class TrackDeliveryResponse(BaseModel):
    status: str
    last_detail: str
    latency_ms: int


@router.post("/track-delivery", response_model=TrackDeliveryResponse)
def track_delivery(payload: TrackDeliveryRequest) -> TrackDeliveryResponse:
    client = ShippingClient()
    started = time.perf_counter()
    try:
        result = client.track_delivery(
            courier_code=payload.courier_code,
            tracking_number=payload.tracking_number,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ShippingAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    latency_ms = int((time.perf_counter() - started) * 1000)
    return TrackDeliveryResponse(
        status=result.status,
        last_detail=result.last_detail,
        latency_ms=latency_ms,
    )


class NaverTokenCheckResponse(BaseModel):
    status: str
    token_type: str
    expires_in: int
    issued_at: str


class NaverQnaListResponse(BaseModel):
    data: Any


class NaverInquiryAnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)


class NaverInquiryAnswerResponse(BaseModel):
    status: str
    data: Any


class NaverAutoAnswerRequest(BaseModel):
    tenant_id: str = Field(default="tenant-demo", min_length=1)
    session_id_prefix: str = Field(default="naver-auto", min_length=1)
    question_id: str | None = None
    page: int = Field(default=1, ge=1, le=50)
    size: int = Field(default=20, ge=1, le=100)
    from_date: str | None = None
    to_date: str | None = None
    dry_run: bool = False


class NaverAutoAnswerResponse(BaseModel):
    status: str
    question_id: str | None = None
    question: str | None = None
    answer: str | None = None
    intent: str | None = None
    confidence: float | None = None
    posted: bool = False
    reason: str | None = None
    why_fallback: str | None = None


def _extract_unanswered_qna(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    for item in items:
        if bool(item.get("answered")):
            continue
        question = str(item.get("question") or "").strip()
        question_id = str(item.get("questionId") or "").strip()
        if question and question_id:
            return item
    return None


def _find_qna_by_question_id(items: list[dict[str, Any]], question_id: str) -> dict[str, Any] | None:
    target_id = question_id.strip()
    if not target_id:
        return None
    for item in items:
        if str(item.get("questionId") or "").strip() == target_id:
            return item
    return None


def _validate_naver_autoreply_token(x_naver_autoreply_token: str | None) -> None:
    expected = get_settings().naver_autoreply_token.strip()
    if not expected:
        return
    provided = (x_naver_autoreply_token or "").strip()
    if provided != expected:
        raise HTTPException(status_code=401, detail="Invalid naver auto-reply token.")


def _rule_based_naver_answer(question: str, product_name: str | None = None) -> str:
    q = question.strip()
    product_prefix = f"[{product_name}] " if product_name else ""
    qn = q.replace(" ", "").lower()

    if any(k in qn for k in ("가짜", "짝퉁", "정품", "진품", "품질", "불량")):
        return (
            f"{product_prefix}문의 주신 품질 관련 내용은 정품/검수 기준에 따라 출고 전 확인하고 있습니다. "
            "수령 후 제품 이상이 확인되면 교환·환불 규정에 따라 빠르게 처리해드리겠습니다. "
            "추가로 궁금하신 점 있으신가요?"
        )
    if any(k in qn for k in ("배송", "출고", "도착", "언제와", "언제오")):
        return (
            f"{product_prefix}배송 문의 감사합니다. 결제 완료 기준으로 순차 출고되며, 출고 후에는 운송장으로 실시간 조회가 가능합니다. "
            "정확한 일정이 필요하시면 주문번호를 남겨주시면 바로 확인해드리겠습니다. "
            "추가로 궁금하신 점 있으신가요?"
        )
    if any(k in qn for k in ("사이즈", "치수", "크기", "핏", "길이")):
        return (
            f"{product_prefix}사이즈 문의 감사합니다. 상품별 실측 기준이 달라 상세페이지 사이즈 가이드를 함께 확인해주시는 것이 가장 정확합니다. "
            "착용 목적을 알려주시면 추천 사이즈도 도와드리겠습니다. "
            "추가로 궁금하신 점 있으신가요?"
        )
    if any(k in qn for k in ("사용", "호환", "적용", "설치", "가능", "되나요")):
        return (
            f"{product_prefix}문의 주신 사용 가능 여부는 사용 환경/조건에 따라 달라질 수 있어 확인 후 정확히 안내드리겠습니다. "
            "모델명이나 사용 목적을 알려주시면 바로 확인해드릴게요. "
            "추가로 궁금하신 점 있으신가요?"
        )
    if any(k in qn for k in ("재고", "재입고", "품절")):
        return (
            f"{product_prefix}재고 문의 감사합니다. 현재 재고는 실시간 변동될 수 있어 최신 상태 기준으로 확인 후 안내드리겠습니다. "
            "원하시는 옵션(색상/사이즈)을 알려주시면 바로 확인해드리겠습니다. "
            "추가로 궁금하신 점 있으신가요?"
        )

    question_preview = q if len(q) <= 32 else f"{q[:32]}..."
    return (
        f"{product_prefix}문의 주신 '{question_preview}' 내용 확인했습니다. "
        "요청하신 조건을 기준으로 정확한 정보를 확인해 안내드리겠습니다. "
        "추가로 궁금하신 점 있으신가요?"
    )


def _generate_naver_safe_answer(question: str, product_name: str | None = None) -> str:
    prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "너는 한국 이커머스 쇼핑몰 CS 상담원이다. "
                "상품문의에 답할 때는 친절하고 짧게 2~3문장으로 답한다. "
                "모르는 사실을 단정하지 말고 확인이 필요한 내용은 '확인 후 안내'라고 답한다. "
                "반드시 마지막에 '추가로 궁금하신 점 있으신가요?'를 붙인다.",
            ),
            ("human", "상품명: {product_name}\n고객 문의: {question}"),
        ]
    )
    settings = get_settings()

    def _invoke(llm, _provider):
        chain = prompt | llm
        out = chain.invoke({"question": question, "product_name": product_name or "미지정"})
        return str(getattr(out, "content", out)).strip()

    try:
        text = invoke_with_fallback(
            settings=settings,
            purpose="generation",
            invoker=_invoke,
        )
        cleaned = text.strip()
        if cleaned:
            return cleaned
    except Exception:
        pass

    return _rule_based_naver_answer(question=question, product_name=product_name)


@router.post("/naver/token-check", response_model=NaverTokenCheckResponse)
def naver_token_check() -> NaverTokenCheckResponse:
    client = NaverCommerceClient()
    try:
        token = client.issue_access_token()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NaverCommerceAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NaverTokenCheckResponse(
        status="ok",
        token_type=token.token_type,
        expires_in=token.expires_in,
        issued_at=datetime.now(tz=timezone.utc).isoformat(),
    )


@router.get("/naver/qnas", response_model=NaverQnaListResponse)
def naver_list_qnas(
    page: int = 1,
    size: int = 20,
    from_date: str | None = None,
    to_date: str | None = None,
) -> NaverQnaListResponse:
    client = NaverCommerceClient()
    try:
        payload = client.list_qnas(
            page=page,
            size=size,
            from_date=from_date,
            to_date=to_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NaverCommerceAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return NaverQnaListResponse(data=payload)


@router.post("/naver/inquiries/{inquiry_no}/answer", response_model=NaverInquiryAnswerResponse)
def naver_answer_inquiry(inquiry_no: str, payload: NaverInquiryAnswerRequest) -> NaverInquiryAnswerResponse:
    client = NaverCommerceClient()
    try:
        response_payload = client.answer_inquiry(inquiry_no=inquiry_no, answer_text=payload.answer)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NaverCommerceAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NaverInquiryAnswerResponse(status="ok", data=response_payload)


@router.post("/naver/qnas/{question_id}/answer", response_model=NaverInquiryAnswerResponse)
def naver_answer_qna(question_id: str, payload: NaverInquiryAnswerRequest) -> NaverInquiryAnswerResponse:
    client = NaverCommerceClient()
    try:
        response_payload = client.answer_qna(question_id=question_id, answer_text=payload.answer)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NaverCommerceAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NaverInquiryAnswerResponse(status="ok", data=response_payload)


@router.post("/naver/auto-answer-once", response_model=NaverAutoAnswerResponse)
def naver_auto_answer_once(
    payload: NaverAutoAnswerRequest,
    x_naver_autoreply_token: str | None = Header(default=None, alias="x-naver-autoreply-token"),
) -> NaverAutoAnswerResponse:
    _validate_naver_autoreply_token(x_naver_autoreply_token)
    client = NaverCommerceClient()
    try:
        qna_payload = client.list_qnas(
            page=payload.page,
            size=payload.size,
            from_date=payload.from_date,
            to_date=payload.to_date,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NaverCommerceAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    items = qna_payload.get("contents") if isinstance(qna_payload, dict) else None
    if not isinstance(items, list):
        return NaverAutoAnswerResponse(
            status="noop",
            posted=False,
            reason="qna_payload_invalid",
        )
    dict_items = [item for item in items if isinstance(item, dict)]
    target: dict[str, Any] | None = None

    if payload.question_id:
        target = _find_qna_by_question_id(dict_items, payload.question_id)
        if not target:
            return NaverAutoAnswerResponse(
                status="noop",
                posted=False,
                reason="question_id_not_found",
            )
    else:
        target = _extract_unanswered_qna(dict_items)
    if not target:
        return NaverAutoAnswerResponse(
            status="noop",
            posted=False,
            reason="no_unanswered_qna",
        )

    question = str(target.get("question", "")).strip()
    question_id = str(target.get("questionId", "")).strip()
    product_name = str(target.get("productName") or "").strip() or None

    flow_state = run_support_flow(
        tenant_id=payload.tenant_id,
        session_id=f"{payload.session_id_prefix}-{int(time.time())}",
        user_message=question,
    )
    generated_answer = str(flow_state.get("answer", "")).strip()
    why_fallback = flow_state.get("why_fallback")
    needs_human = bool(flow_state.get("needs_human", False))

    if payload.dry_run:
        return NaverAutoAnswerResponse(
            status="ok",
            question_id=question_id,
            question=question,
            answer=generated_answer,
            intent=flow_state.get("intent"),
            confidence=float(flow_state.get("confidence", 0.0)),
            posted=False,
            reason="dry_run",
            why_fallback=why_fallback,
        )

    if not generated_answer:
        return NaverAutoAnswerResponse(
            status="blocked",
            question_id=question_id,
            question=question,
            posted=False,
            reason="empty_answer",
            why_fallback=why_fallback,
        )

    if needs_human or why_fallback in {
        FallbackCode.RUNTIME_CONFIG_MISSING.value,
        FallbackCode.CLARIFY_LOW_CONFIDENCE.value,
        FallbackCode.REVIEW_REJECTED.value,
    }:
        if why_fallback in {
            FallbackCode.RUNTIME_CONFIG_MISSING.value,
            FallbackCode.CLARIFY_LOW_CONFIDENCE.value,
        }:
            generated_answer = _generate_naver_safe_answer(question=question, product_name=product_name)
            needs_human = False
            why_fallback = None
        else:
            return NaverAutoAnswerResponse(
                status="blocked",
                question_id=question_id,
                question=question,
                answer=generated_answer,
                intent=flow_state.get("intent"),
                confidence=float(flow_state.get("confidence", 0.0)),
                posted=False,
                reason="unsafe_auto_answer",
                why_fallback=why_fallback,
            )

    if needs_human:
        return NaverAutoAnswerResponse(
            status="blocked",
            question_id=question_id,
            question=question,
            answer=generated_answer,
            intent=flow_state.get("intent"),
            confidence=float(flow_state.get("confidence", 0.0)),
            posted=False,
            reason="unsafe_auto_answer",
            why_fallback=why_fallback,
        )

    try:
        client.answer_qna(question_id=question_id, answer_text=generated_answer)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except NaverCommerceAPIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NaverAutoAnswerResponse(
        status="ok",
        question_id=question_id,
        question=question,
        answer=generated_answer,
        intent=flow_state.get("intent"),
        confidence=float(flow_state.get("confidence", 0.0)),
        posted=True,
        why_fallback=why_fallback,
    )


class NaverAutoAnswerDrainRequest(BaseModel):
    tenant_id: str = Field(default="tenant-demo", min_length=1)
    session_id_prefix: str = Field(default="naver-auto-drain", min_length=1)
    max_iterations: int = Field(default=20, ge=1, le=200)
    page: int = Field(default=1, ge=1, le=50)
    size: int = Field(default=50, ge=1, le=100)
    from_date: str | None = None
    to_date: str | None = None
    dry_run: bool = False


class NaverAutoAnswerDrainResponse(BaseModel):
    status: str
    processed: int
    posted: int
    blocked: int
    last_reason: str | None = None
    results: list[NaverAutoAnswerResponse]


@router.post("/naver/auto-answer-drain", response_model=NaverAutoAnswerDrainResponse)
def naver_auto_answer_drain(
    payload: NaverAutoAnswerDrainRequest,
    x_naver_autoreply_token: str | None = Header(default=None, alias="x-naver-autoreply-token"),
) -> NaverAutoAnswerDrainResponse:
    _validate_naver_autoreply_token(x_naver_autoreply_token)

    results: list[NaverAutoAnswerResponse] = []
    posted = 0
    blocked = 0
    last_reason: str | None = None

    for idx in range(payload.max_iterations):
        result = naver_auto_answer_once(
            payload=NaverAutoAnswerRequest(
                tenant_id=payload.tenant_id,
                session_id_prefix=f"{payload.session_id_prefix}-{idx + 1}",
                page=payload.page,
                size=payload.size,
                from_date=payload.from_date,
                to_date=payload.to_date,
                dry_run=payload.dry_run,
            ),
            x_naver_autoreply_token=x_naver_autoreply_token,
        )
        results.append(result)

        if result.posted:
            posted += 1
            continue

        if result.status == "blocked":
            blocked += 1
            last_reason = result.reason
            break

        if result.status == "noop":
            last_reason = result.reason
            break

        if result.reason:
            last_reason = result.reason

    status = "ok"
    if blocked > 0:
        status = "blocked"
    elif last_reason == "no_unanswered_qna":
        status = "done"

    return NaverAutoAnswerDrainResponse(
        status=status,
        processed=len(results),
        posted=posted,
        blocked=blocked,
        last_reason=last_reason,
        results=results,
    )
