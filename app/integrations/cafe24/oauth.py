import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

import requests

from app.core.config import get_settings


class Cafe24TokenStore(Protocol):
    def get_cafe24_refresh_token(self, tenant_id: str) -> str | None: ...

    def save_cafe24_tokens(
        self,
        tenant_id: str,
        access_token: str,
        refresh_token: str,
        expires_at: datetime,
    ) -> None: ...


@dataclass
class Cafe24TokenResponse:
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str | None = None
    scope: str | None = None


def _basic_auth_header(client_id: str, client_secret: str) -> str:
    encoded = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("utf-8")
    return f"Basic {encoded}"


def refresh_cafe24_token(
    mall_id: str,
    client_id: str,
    client_secret: str,
    refresh_token: str,
    timeout: int = 20,
) -> Cafe24TokenResponse:
    url = f"https://{mall_id}.cafe24api.com/api/v2/oauth/token"
    headers = {
        "Authorization": _basic_auth_header(client_id, client_secret),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    response = requests.post(url, headers=headers, data=payload, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    return Cafe24TokenResponse(
        access_token=data["access_token"],
        refresh_token=data["refresh_token"],
        expires_in=int(data.get("expires_in", 7200)),
        token_type=data.get("token_type"),
        scope=data.get("scope"),
    )


def rotate_and_persist_cafe24_token(tenant_id: str, token_store: Cafe24TokenStore) -> Cafe24TokenResponse:
    settings = get_settings()
    if not settings.cafe24_mall_id or not settings.cafe24_client_id or not settings.cafe24_client_secret:
        raise ValueError("Cafe24 credentials are missing in environment settings.")

    current_refresh_token = token_store.get_cafe24_refresh_token(tenant_id)
    if not current_refresh_token:
        raise ValueError("No Cafe24 refresh token stored for tenant.")

    new_token = refresh_cafe24_token(
        mall_id=settings.cafe24_mall_id,
        client_id=settings.cafe24_client_id,
        client_secret=settings.cafe24_client_secret,
        refresh_token=current_refresh_token,
        timeout=settings.request_timeout_seconds,
    )

    expires_at = datetime.now(tz=timezone.utc) + timedelta(seconds=new_token.expires_in)
    token_store.save_cafe24_tokens(
        tenant_id=tenant_id,
        access_token=new_token.access_token,
        refresh_token=new_token.refresh_token,
        expires_at=expires_at,
    )
    return new_token

