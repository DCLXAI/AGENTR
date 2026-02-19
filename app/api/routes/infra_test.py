from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from app.core.config import get_settings


router = APIRouter(prefix="/v1/infra", tags=["infra-test"])


class SentryTestRequest(BaseModel):
    message: str = "shop-ai sentry test event"
    level: Literal["info", "error"] = "error"


class SentryTestResponse(BaseModel):
    status: str
    event_id: str
    request_id: str
    sent_at: str


def _get_sentry_sdk():
    import sentry_sdk

    return sentry_sdk


@router.post("/sentry-test", response_model=SentryTestResponse)
def sentry_test(
    payload: SentryTestRequest,
    request: Request,
    x_infra_test_token: str | None = Header(default=None, alias="x-infra-test-token"),
) -> SentryTestResponse:
    settings = get_settings()
    if not settings.infra_test_token:
        raise HTTPException(status_code=503, detail="INFRA_TEST_TOKEN is not configured.")
    if x_infra_test_token != settings.infra_test_token:
        raise HTTPException(status_code=401, detail="Invalid infra test token.")
    if not settings.sentry_dsn:
        raise HTTPException(status_code=503, detail="SENTRY_DSN is not configured.")

    try:
        sentry_sdk = _get_sentry_sdk()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"sentry sdk import failed: {exc}") from exc

    if payload.level == "error":
        event_id = sentry_sdk.capture_exception(RuntimeError(payload.message))
    else:
        event_id = sentry_sdk.capture_message(payload.message, level=payload.level)
    sentry_sdk.flush(timeout=2.0)

    request_id = str(getattr(request.state, "request_id", ""))
    return SentryTestResponse(
        status="ok",
        event_id=str(event_id or ""),
        request_id=request_id,
        sent_at=datetime.now(tz=timezone.utc).isoformat(),
    )
