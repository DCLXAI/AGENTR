from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.agents.langgraph.support_graph import run_support_flow
from app.repositories.supabase_repo import get_supabase_repo


router = APIRouter(prefix="/v1/chat", tags=["chat"])


class ChatQueryRequest(BaseModel):
    tenant_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    user_message: str = Field(min_length=1)


class SourceItem(BaseModel):
    source_id: str
    title: str
    snippet: str


class ToolTraceItem(BaseModel):
    tool: str
    status: str
    latency_ms: int


class TrackingProgress(BaseModel):
    stage: int | None = None
    label: str | None = None
    raw_status: str | None = None


class ChatQueryResponse(BaseModel):
    answer: str
    intent: str
    confidence: float
    sources: list[SourceItem]
    tool_trace: list[ToolTraceItem]
    needs_human: bool
    why_fallback: str | None = None
    tracking_progress: TrackingProgress | None = None


@router.post("/query", response_model=ChatQueryResponse)
def query(payload: ChatQueryRequest) -> ChatQueryResponse:
    try:
        state = run_support_flow(
            tenant_id=payload.tenant_id,
            session_id=payload.session_id,
            user_message=payload.user_message,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Internal processing error.") from exc

    response = ChatQueryResponse(
        answer=state.get("answer", ""),
        intent=state.get("intent", "fallback"),
        confidence=float(state.get("confidence", 0.0)),
        sources=[SourceItem.model_validate(item) for item in state.get("sources", [])],
        tool_trace=[ToolTraceItem.model_validate(item) for item in state.get("tool_trace", [])],
        needs_human=bool(state.get("needs_human", False)),
        why_fallback=state.get("why_fallback"),
        tracking_progress=TrackingProgress.model_validate(state.get("tracking_progress"))
        if state.get("tracking_progress") is not None
        else None,
    )

    repo = get_supabase_repo()
    repo.log_chat_interaction(
        tenant_id=payload.tenant_id,
        session_id=payload.session_id,
        user_message=payload.user_message,
        response_payload=response.model_dump(),
        why_fallback=response.why_fallback,
    )
    for trace in response.tool_trace:
        repo.log_tool_call(
            tenant_id=payload.tenant_id,
            session_id=payload.session_id,
            tool=trace.tool,
            status=trace.status,
            latency_ms=trace.latency_ms,
            why_fallback=response.why_fallback,
        )
    return response
