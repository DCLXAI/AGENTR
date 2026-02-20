import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.repositories.supabase_repo import get_supabase_repo


router = APIRouter(prefix="/v1/leads", tags=["leads"])

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class LeadSignupRequest(BaseModel):
    email: str = Field(min_length=5, max_length=320)
    source: str = Field(default="homepage", min_length=1, max_length=120)
    plan: str | None = Field(default=None, max_length=64)
    metadata: dict[str, Any] | None = None


class LeadSignupResponse(BaseModel):
    status: str
    message: str


@router.post("/signup", response_model=LeadSignupResponse)
def lead_signup(payload: LeadSignupRequest) -> LeadSignupResponse:
    email = payload.email.strip().lower()
    if not EMAIL_PATTERN.fullmatch(email):
        raise HTTPException(status_code=400, detail="유효한 이메일 주소를 입력해 주세요.")

    source = payload.source.strip() or "homepage"
    metadata = dict(payload.metadata or {})
    if payload.plan:
        metadata["plan"] = payload.plan
    metadata["received_at"] = datetime.now(tz=timezone.utc).isoformat()

    repo = get_supabase_repo()
    saved = repo.save_lead_signup(email=email, source=source, metadata=metadata)

    if saved:
        return LeadSignupResponse(status="ok", message="신청이 접수되었습니다. 빠르게 연락드리겠습니다.")

    return LeadSignupResponse(
        status="queued",
        message="신청이 접수되었습니다. 시스템 반영 후 순차적으로 연락드리겠습니다.",
    )
