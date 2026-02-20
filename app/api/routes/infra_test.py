import ipaddress
from datetime import datetime, timezone
from typing import Literal

import requests
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


class EgressIPResponse(BaseModel):
    status: str
    egress_ip: str
    provider: str
    request_id: str
    checked_at: str


def _get_sentry_sdk():
    import sentry_sdk

    return sentry_sdk


def _validate_infra_test_token(x_infra_test_token: str | None) -> None:
    settings = get_settings()
    if not settings.infra_test_token:
        raise HTTPException(status_code=503, detail="INFRA_TEST_TOKEN is not configured.")
    if x_infra_test_token != settings.infra_test_token:
        raise HTTPException(status_code=401, detail="Invalid infra test token.")


def _resolve_egress_ip(timeout_seconds: float = 2.0) -> tuple[str, str]:
    providers = [
        ("ipify", "https://api64.ipify.org?format=json"),
        ("ifconfig.me", "https://ifconfig.me/ip"),
    ]
    errors: list[str] = []

    for provider, url in providers:
        try:
            response = requests.get(url, timeout=timeout_seconds)
            response.raise_for_status()
            if provider == "ipify":
                payload = response.json()
                value = str(payload.get("ip", "")).strip()
            else:
                value = response.text.strip()
            ipaddress.ip_address(value)
            return value, provider
        except Exception as exc:
            errors.append(f"{provider}:{exc}")

    joined = "; ".join(errors) if errors else "no provider attempted"
    raise RuntimeError(joined)


@router.post("/sentry-test", response_model=SentryTestResponse)
def sentry_test(
    payload: SentryTestRequest,
    request: Request,
    x_infra_test_token: str | None = Header(default=None, alias="x-infra-test-token"),
) -> SentryTestResponse:
    settings = get_settings()
    _validate_infra_test_token(x_infra_test_token)
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


@router.get("/egress-ip", response_model=EgressIPResponse)
def infra_egress_ip(
    request: Request,
    x_infra_test_token: str | None = Header(default=None, alias="x-infra-test-token"),
) -> EgressIPResponse:
    _validate_infra_test_token(x_infra_test_token)

    try:
        egress_ip, provider = _resolve_egress_ip(timeout_seconds=2.0)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"egress ip check failed: {exc}") from exc

    request_id = str(getattr(request.state, "request_id", ""))
    return EgressIPResponse(
        status="ok",
        egress_ip=egress_ip,
        provider=provider,
        request_id=request_id,
        checked_at=datetime.now(tz=timezone.utc).isoformat(),
    )
