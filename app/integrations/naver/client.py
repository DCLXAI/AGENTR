import base64
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import requests

from app.core.config import get_settings


class NaverCommerceAPIError(RuntimeError):
    pass


@dataclass
class NaverCommerceToken:
    access_token: str
    token_type: str
    expires_in: int


class NaverCommerceClient:
    _RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

    def __init__(self) -> None:
        self.settings = get_settings()

    def _credentials(self) -> tuple[str, str]:
        client_id = self.settings.naver_commerce_client_id.strip()
        client_secret = self.settings.naver_commerce_client_secret.strip()
        if not client_id or not client_secret:
            raise ValueError(
                "Naver Commerce credentials are missing. "
                "Set NAVER_COMMERCE_CLIENT_ID and NAVER_COMMERCE_CLIENT_SECRET."
            )
        return client_id, client_secret

    def _base_url(self) -> str:
        return (self.settings.naver_commerce_base_url or "https://api.commerce.naver.com").rstrip("/")

    @staticmethod
    def _timestamp_ms() -> str:
        return str(int(time.time() * 1000))

    @staticmethod
    def _build_client_secret_sign(client_id: str, client_secret: str, timestamp_ms: str) -> str:
        payload = f"{client_id}_{timestamp_ms}".encode("utf-8")
        secret = client_secret.encode("utf-8")
        try:
            hashed = bcrypt.hashpw(payload, secret)
            return base64.b64encode(hashed).decode("utf-8")
        except ValueError as exc:
            raise ValueError(
                "NAVER_COMMERCE_CLIENT_SECRET format is invalid. "
                "Expected bcrypt salt/hash format from Naver Commerce API."
            ) from exc

    @staticmethod
    def _error_message(payload: dict[str, Any], fallback: str) -> str:
        message = str(payload.get("message") or payload.get("error_description") or fallback).strip()
        invalid_inputs = payload.get("invalidInputs")
        if isinstance(invalid_inputs, list) and invalid_inputs:
            return f"{message} invalidInputs={invalid_inputs}"
        return message

    @staticmethod
    def _to_kst_iso8601(value: datetime) -> str:
        kst = timezone(timedelta(hours=9))
        return value.astimezone(kst).replace(microsecond=0).isoformat()

    def issue_access_token(self) -> NaverCommerceToken:
        client_id, client_secret = self._credentials()
        timestamp_ms = self._timestamp_ms()
        client_secret_sign = self._build_client_secret_sign(
            client_id=client_id,
            client_secret=client_secret,
            timestamp_ms=timestamp_ms,
        )

        response = requests.post(
            f"{self._base_url()}/external/v1/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "timestamp": timestamp_ms,
                "client_secret_sign": client_secret_sign,
                "type": "SELF",
            },
            timeout=self.settings.request_timeout_seconds,
        )

        try:
            payload = response.json()
        except ValueError as exc:
            raise NaverCommerceAPIError("Naver token API returned non-JSON response.") from exc

        if response.status_code >= 400:
            raise NaverCommerceAPIError(self._error_message(payload, "Naver token request failed."))

        access_token = str(payload.get("access_token", "")).strip()
        if not access_token:
            raise NaverCommerceAPIError("Naver token response does not include access_token.")

        token_type = str(payload.get("token_type", "Bearer")).strip() or "Bearer"
        expires_in = int(payload.get("expires_in") or 0)
        return NaverCommerceToken(
            access_token=access_token,
            token_type=token_type,
            expires_in=expires_in,
        )

    def _authorized_request(
        self,
        *,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        token = self.issue_access_token()
        url = f"{self._base_url()}/{path.lstrip('/')}"
        last_error = "unknown"

        for attempt in range(1, self.settings.max_retry_attempts + 1):
            try:
                response = requests.request(
                    method=method.upper(),
                    url=url,
                    headers={"Authorization": f"{token.token_type} {token.access_token}"},
                    params=params,
                    json=json,
                    timeout=self.settings.request_timeout_seconds,
                )
            except requests.RequestException as exc:
                last_error = str(exc)
                if attempt >= self.settings.max_retry_attempts:
                    break
                time.sleep(0.5 * (2 ** (attempt - 1)))
                continue

            if response.status_code in self._RETRYABLE_STATUS_CODES:
                last_error = f"transient status={response.status_code}"
                if attempt >= self.settings.max_retry_attempts:
                    break
                time.sleep(0.5 * (2 ** (attempt - 1)))
                continue

            if response.status_code == 204 or not response.content:
                return {}

            try:
                payload = response.json()
            except ValueError as exc:
                raise NaverCommerceAPIError("Naver Commerce API returned non-JSON response.") from exc

            if response.status_code >= 400:
                raise NaverCommerceAPIError(self._error_message(payload, "Naver API request failed."))
            return payload

        raise NaverCommerceAPIError(f"Naver API request failed after retries: {last_error}")

    def list_qnas(
        self,
        *,
        page: int = 1,
        size: int = 20,
        from_date: str | None = None,
        to_date: str | None = None,
    ) -> Any:
        # Naver QnA API requires fromDate/toDate in datetime format.
        if not from_date or not to_date:
            now = datetime.now(tz=timezone.utc)
            default_from = now - timedelta(days=30)
            from_date = from_date or self._to_kst_iso8601(default_from)
            to_date = to_date or self._to_kst_iso8601(now)

        return self._authorized_request(
            method="GET",
            path="/external/v1/contents/qnas",
            params={
                "page": page,
                "size": size,
                "fromDate": from_date,
                "toDate": to_date,
            },
        )

    def answer_inquiry(self, inquiry_no: str, answer_text: str) -> Any:
        normalized_inquiry_no = inquiry_no.strip()
        if not normalized_inquiry_no:
            raise ValueError("inquiry_no is required.")
        answer_text = answer_text.strip()
        if not answer_text:
            raise ValueError("answer text is required.")

        return self._authorized_request(
            method="POST",
            path=f"/external/v1/pay-merchant/inquiries/{normalized_inquiry_no}/answer",
            json={"answerContent": answer_text},
        )

    def answer_qna(self, question_id: str | int, answer_text: str) -> Any:
        normalized_question_id = str(question_id).strip()
        if not normalized_question_id:
            raise ValueError("question_id is required.")
        answer_text = answer_text.strip()
        if not answer_text:
            raise ValueError("answer text is required.")

        return self._authorized_request(
            method="PUT",
            path=f"/external/v1/contents/qnas/{normalized_question_id}",
            json={"commentContent": answer_text},
        )
