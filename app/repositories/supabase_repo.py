import base64
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

try:
    from supabase import create_client
except Exception:  # pragma: no cover - import compatibility fallback
    create_client = None

from app.core.config import Settings, get_settings


class SupabaseRepository:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: Any | None = None
        self._cipher: Fernet | None = None
        self._init_optional_clients()

    def _init_optional_clients(self) -> None:
        if create_client and self.settings.supabase_url and self.settings.supabase_service_role_key:
            self._client = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)

        if self.settings.token_encryption_key:
            raw = self.settings.token_encryption_key.encode("utf-8")
            # Accept either pre-encoded Fernet key or plain passphrase-like value.
            if len(raw) == 44 and raw.endswith(b"="):
                key = raw
            else:
                key = base64.urlsafe_b64encode(raw.ljust(32, b"0")[:32])
            self._cipher = Fernet(key)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def _encrypt(self, value: str) -> str:
        if not self._cipher:
            raise ValueError("TOKEN_ENCRYPTION_KEY is required to store refresh tokens.")
        return self._cipher.encrypt(value.encode("utf-8")).decode("utf-8")

    def _decrypt(self, value: str) -> str:
        if not self._cipher:
            raise ValueError("TOKEN_ENCRYPTION_KEY is required to read refresh tokens.")
        try:
            return self._cipher.decrypt(value.encode("utf-8")).decode("utf-8")
        except InvalidToken as exc:
            raise ValueError("Failed to decrypt refresh token.") from exc

    def log_chat_interaction(
        self,
        tenant_id: str,
        session_id: str,
        user_message: str,
        response_payload: dict[str, Any],
        why_fallback: str | None = None,
    ) -> None:
        if not self._client:
            return
        self._client.table("conversation_logs").insert(
            {
                "tenant_id": tenant_id,
                "session_id": session_id,
                "user_message": user_message,
                "response_payload": response_payload,
                "why_fallback": why_fallback,
                "created_at": datetime.now(tz=timezone.utc).isoformat(),
            }
        ).execute()

    def log_tool_call(
        self,
        tenant_id: str,
        session_id: str,
        tool: str,
        status: str,
        latency_ms: int,
        detail: dict[str, Any] | None = None,
        why_fallback: str | None = None,
    ) -> None:
        if not self._client:
            return
        self._client.table("tool_call_logs").insert(
            {
                "tenant_id": tenant_id,
                "session_id": session_id,
                "tool": tool,
                "status": status,
                "latency_ms": latency_ms,
                "detail": detail or {},
                "why_fallback": why_fallback,
                "created_at": datetime.now(tz=timezone.utc).isoformat(),
            }
        ).execute()

    def log_rag_ingest_job(
        self,
        *,
        tenant_id: str,
        version_tag: str,
        source_paths: list[str],
        upserted_chunks: int,
        status: str = "done",
        why_fallback: str | None = None,
    ) -> None:
        if not self._client:
            return
        self._client.table("rag_ingest_jobs").insert(
            {
                "tenant_id": tenant_id,
                "version_tag": version_tag,
                "source_paths": source_paths,
                "upserted_chunks": upserted_chunks,
                "status": status,
                "why_fallback": why_fallback,
                "created_at": datetime.now(tz=timezone.utc).isoformat(),
            }
        ).execute()

    def save_lead_signup(self, *, email: str, source: str, metadata: dict[str, Any] | None = None) -> bool:
        if not self._client:
            return False
        payload = {
            "email": email,
            "source": source,
            "metadata": metadata or {},
            "created_at": datetime.now(tz=timezone.utc).isoformat(),
        }
        try:
            self._client.table("lead_signups").insert(payload).execute()
            return True
        except Exception:
            return False

    def get_cafe24_refresh_token(self, tenant_id: str) -> str | None:
        if not self._client:
            return None
        response = (
            self._client.table("oauth_tokens")
            .select("refresh_token_encrypted")
            .eq("tenant_id", tenant_id)
            .eq("provider", "cafe24")
            .limit(1)
            .execute()
        )
        rows = response.data or []
        if not rows:
            return None
        encrypted = rows[0].get("refresh_token_encrypted")
        if not encrypted:
            return None
        return self._decrypt(str(encrypted))

    def save_cafe24_tokens(
        self,
        tenant_id: str,
        access_token: str,
        refresh_token: str,
        expires_at: datetime,
    ) -> None:
        if not self._client:
            return
        encrypted_refresh = self._encrypt(refresh_token)
        payload = {
            "tenant_id": tenant_id,
            "provider": "cafe24",
            "access_token": access_token,
            "refresh_token_encrypted": encrypted_refresh,
            "expires_at": expires_at.isoformat(),
            "updated_at": datetime.now(tz=timezone.utc).isoformat(),
        }
        self._client.table("oauth_tokens").upsert(payload, on_conflict="tenant_id,provider").execute()


@lru_cache(maxsize=1)
def get_supabase_repo() -> SupabaseRepository:
    return SupabaseRepository(get_settings())
