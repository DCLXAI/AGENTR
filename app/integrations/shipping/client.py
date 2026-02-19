import time
from dataclasses import dataclass
from typing import Any

import requests

from app.core.config import get_settings


@dataclass
class ShippingLookupResult:
    status: str
    last_detail: str
    raw: dict[str, Any]


class ShippingAPIError(RuntimeError):
    pass


class ShippingClient:
    _RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
    _COURIER_ALIAS_TO_CODE = {
        "cj": "04",
        "cj대한통운": "04",
        "대한통운": "04",
        "한진": "05",
        "hanjin": "05",
        "로젠": "06",
        "logen": "06",
        "롯데": "08",
        "롯데택배": "08",
        "lotte": "08",
        "우체국": "01",
        "epost": "01",
    }

    def __init__(self) -> None:
        self.settings = get_settings()
        self._company_cache: list[dict[str, str]] | None = None

    def _shipping_api_key(self) -> str:
        key = (self.settings.sweettracker_api_key or self.settings.deliveryapi_key).strip()
        if not key:
            raise ValueError("Shipping API key is missing. Set SWEETTRACKER_API_KEY or DELIVERYAPI_KEY.")
        return key

    def _tracking_url(self) -> str:
        base_url = (self.settings.sweettracker_base_url or self.settings.deliveryapi_base_url).strip()
        if not base_url:
            raise ValueError("Shipping API base URL is missing.")
        return f"{base_url.rstrip('/')}/api/v1/trackingInfo"

    @staticmethod
    def _normalize(value: str) -> str:
        return value.strip().lower().replace(" ", "").replace("-", "")

    def _list_companies(self) -> list[dict[str, str]]:
        if self._company_cache is not None:
            return self._company_cache

        url = f"{(self.settings.sweettracker_base_url or self.settings.deliveryapi_base_url).rstrip('/')}/api/v1/companylist"
        response = requests.get(
            url,
            params={"t_key": self._shipping_api_key()},
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()

        raw_list: list[dict[str, Any]] = []
        if isinstance(data, dict):
            for key in ("Company", "companies", "data", "results"):
                maybe = data.get(key)
                if isinstance(maybe, list):
                    raw_list = [item for item in maybe if isinstance(item, dict)]
                    break
        elif isinstance(data, list):
            raw_list = [item for item in data if isinstance(item, dict)]

        companies: list[dict[str, str]] = []
        for item in raw_list:
            code = str(item.get("Code") or item.get("code") or item.get("id") or "").strip()
            name = str(item.get("Name") or item.get("name") or item.get("companyName") or "").strip()
            if code and name:
                companies.append({"code": code, "name": name})

        self._company_cache = companies
        return companies

    def _resolve_courier_code(self, courier_code: str) -> str:
        code = courier_code.strip()
        if not code:
            raise ValueError("Courier code is required.")
        if code.isdigit():
            return code

        normalized = self._normalize(code)
        mapped = self._COURIER_ALIAS_TO_CODE.get(normalized)
        if mapped:
            return mapped

        try:
            companies = self._list_companies()
        except Exception:
            return code

        for company in companies:
            company_code = company["code"]
            company_name = company["name"]
            normalized_name = self._normalize(company_name)
            if normalized == normalized_name or normalized in normalized_name:
                return company_code
        return code

    def _tracking_params(self, courier_code: str, tracking_number: str) -> dict[str, str]:
        return {
            "t_key": self._shipping_api_key(),
            "t_code": self._resolve_courier_code(courier_code),
            "t_invoice": tracking_number.strip(),
        }

    def _request_tracking(self, params: dict[str, str]) -> requests.Response:
        url = self._tracking_url()
        response = requests.get(
            url,
            params=params,
            timeout=self.settings.request_timeout_seconds,
        )
        if response.status_code in {404, 405}:
            response = requests.post(
                url,
                json=params,
                timeout=self.settings.request_timeout_seconds,
            )
        return response

    @staticmethod
    def _first_non_empty(*values: Any) -> str:
        for value in values:
            text = str(value or "").strip()
            if text:
                return text
        return ""

    def _extract_last_event(self, data: dict[str, Any]) -> dict[str, Any] | None:
        for key in ("trackingDetails", "tracking_details", "details"):
            events = data.get(key)
            if isinstance(events, list):
                event_candidates = [item for item in events if isinstance(item, dict)]
                if event_candidates:
                    return event_candidates[-1]

        for key in ("lastDetail", "lastStateDetail"):
            event = data.get(key)
            if isinstance(event, dict):
                return event
        return None

    def _extract_status_and_detail(self, data: dict[str, Any]) -> tuple[str, str]:
        last_event = self._extract_last_event(data) or {}

        status = self._first_non_empty(
            last_event.get("kind"),
            last_event.get("status"),
            data.get("status"),
            data.get("state"),
            data.get("stateName"),
            data.get("level"),
            "unknown",
        )

        last_detail = self._first_non_empty(
            " / ".join(
                [
                    part
                    for part in [
                        self._first_non_empty(last_event.get("timeString"), last_event.get("time")),
                        self._first_non_empty(last_event.get("where"), last_event.get("location")),
                        self._first_non_empty(last_event.get("kind"), last_event.get("status")),
                    ]
                    if part
                ]
            ),
            str(data.get("msg", "")).strip(),
            str(data.get("message", "")).strip(),
            "",
        )
        return status, last_detail

    @staticmethod
    def _extract_api_error(data: dict[str, Any]) -> str:
        result = str(data.get("result", "")).strip().lower()
        if result in {"n", "false", "0"}:
            return str(data.get("msg") or data.get("message") or "Shipping API result indicates failure.").strip()
        code = str(data.get("code", "")).strip()
        if code and code not in {"0", "200"}:
            return str(data.get("msg") or data.get("message") or f"Shipping API error code={code}").strip()
        return ""

    def track_delivery(self, courier_code: str, tracking_number: str) -> ShippingLookupResult:
        tracking_number = tracking_number.strip()
        if not tracking_number:
            raise ValueError("Tracking number is required.")
        params = self._tracking_params(courier_code=courier_code, tracking_number=tracking_number)
        last_error: str = "unknown"

        for attempt in range(1, self.settings.max_retry_attempts + 1):
            try:
                response = self._request_tracking(params=params)
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

            if response.status_code == 401:
                raise ShippingAPIError(
                    "Unauthorized shipping API request (401). Verify SWEETTRACKER_API_KEY/DELIVERYAPI_KEY."
                )
            if response.status_code >= 400:
                raise ShippingAPIError(f"Shipping API request failed with status={response.status_code}.")

            try:
                data = response.json()
            except ValueError as exc:
                raise ShippingAPIError("Shipping API returned non-JSON response.") from exc
            if not isinstance(data, dict):
                raise ShippingAPIError("Shipping API returned invalid payload format.")

            api_error = self._extract_api_error(data)
            if api_error:
                raise ShippingAPIError(api_error)

            status, last_detail = self._extract_status_and_detail(data)
            return ShippingLookupResult(status=status, last_detail=last_detail, raw=data)

        raise ShippingAPIError(f"Shipping lookup failed after retries: {last_error}")
