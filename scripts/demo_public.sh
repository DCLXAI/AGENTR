#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-https://agentr-fz0i.onrender.com}"
TENANT_ID="${TENANT_ID:-tenant-demo}"
SESSION_ID_PREFIX="${SESSION_ID_PREFIX:-public-demo}"
OUT_DIR="${OUT_DIR:-artifacts/demo/$(date +%Y%m%d_%H%M%S)}"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "python runtime is required." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
export API_BASE_URL TENANT_ID SESSION_ID_PREFIX OUT_DIR

echo "[demo] API_BASE_URL=${API_BASE_URL}"
echo "[demo] OUT_DIR=${OUT_DIR}"

"${PYTHON_BIN}" - <<'PY'
import json
import os
import time
from pathlib import Path

import requests


base = os.environ["API_BASE_URL"].rstrip("/")
tenant_id = os.environ["TENANT_ID"]
session_prefix = os.environ["SESSION_ID_PREFIX"]
out_dir = Path(os.environ["OUT_DIR"])
out_dir.mkdir(parents=True, exist_ok=True)


def save_json(name: str, payload: dict) -> None:
    path = out_dir / f"{name}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def get_json(path: str, name: str) -> dict:
    url = f"{base}{path}"
    for attempt in range(1, 9):
        try:
            res = requests.get(url, timeout=20)
            body = res.json()
            save_json(name, {"status_code": res.status_code, "body": body})
            if res.ok:
                return body
        except Exception as exc:
            save_json(name, {"status_code": None, "body": {"error": str(exc), "attempt": attempt}})
        time.sleep(3)
    raise SystemExit(f"{path} failed after retries")


def post_chat(label: str, message: str) -> dict:
    payload = {
        "tenant_id": tenant_id,
        "session_id": f"{session_prefix}-{label}-{int(time.time())}",
        "user_message": message,
    }
    res = requests.post(f"{base}/v1/chat/query", json=payload, timeout=40)
    body = res.json()
    save_json(
        f"chat_{label}",
        {
            "request": payload,
            "status_code": res.status_code,
            "x_request_id": res.headers.get("x-request-id"),
            "response": body,
        },
    )
    if res.status_code != 200:
        raise SystemExit(f"chat_{label} failed: status={res.status_code}")
    return body


health = get_json("/health", "health")
ready = get_json("/ready", "ready")

if health.get("status") != "ok":
    raise SystemExit(f"health not ok: {health}")
if ready.get("status") == "fail":
    raise SystemExit(f"ready fail: {ready}")

case_policy = post_chat("policy", "반품은 수령 후 며칠 이내에 가능하나요?")
if case_policy.get("intent") != "policy":
    raise SystemExit(f"policy intent mismatch: {case_policy}")
if len(case_policy.get("sources") or []) < 1:
    raise SystemExit(f"policy source missing: {case_policy}")

case_tracking_missing = post_chat("tracking_missing", "운송장번호 없이 배송조회 해줘")
if case_tracking_missing.get("why_fallback") != "tracking_missing_number":
    raise SystemExit(f"tracking fallback mismatch: {case_tracking_missing}")

case_unsupported = post_chat("unsupported_action", "주문 취소해줘")

summary = {
    "health": health.get("status"),
    "ready": ready.get("status"),
    "policy_intent": case_policy.get("intent"),
    "policy_sources": len(case_policy.get("sources") or []),
    "tracking_missing_fallback": case_tracking_missing.get("why_fallback"),
    "unsupported_why_fallback": case_unsupported.get("why_fallback"),
}
save_json("summary", summary)

print("[demo] summary")
print(json.dumps(summary, ensure_ascii=False, indent=2))
print(f"[demo] artifacts saved under: {out_dir}")
PY

