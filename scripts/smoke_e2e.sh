#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${API_BASE_URL:-}" ]]; then
  echo "API_BASE_URL is required." >&2
  exit 1
fi

TENANT_ID="${TENANT_ID:-tenant-demo}"
SESSION_ID_PREFIX="${SESSION_ID_PREFIX:-smoke}"
POLICY_TEST_MESSAGE="${POLICY_TEST_MESSAGE:-반품은 수령 후 며칠 이내에 가능하나요?}"
TRACKING_MISSING_TEST_MESSAGE="${TRACKING_MISSING_TEST_MESSAGE:-운송장번호 없이 배송조회 해줘}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "[smoke] API_BASE_URL=${API_BASE_URL}"
CURL_TIMEOUT_ARGS=(--connect-timeout 5 --max-time 20)

curl_with_retry() {
  local url="$1"
  local output="$2"
  local attempts="${3:-10}"
  local delay="${4:-3}"

  local i
  for i in $(seq 1 "$attempts"); do
    if curl -fsS "${CURL_TIMEOUT_ARGS[@]}" "$url" > "$output"; then
      return 0
    fi
    sleep "$delay"
  done
  echo "[smoke] request failed after retries: $url" >&2
  return 1
}

curl_with_retry "${API_BASE_URL%/}/health" "${tmp_dir}/health.json"
python - "${tmp_dir}/health.json" <<'PY'
import json
import sys
payload = json.loads(open(sys.argv[1], encoding="utf-8").read())
if payload.get("status") != "ok":
    raise SystemExit(f"/health failed: {payload}")
print("[smoke] /health ok")
PY

curl_with_retry "${API_BASE_URL%/}/ready" "${tmp_dir}/ready.json"
python - "${tmp_dir}/ready.json" <<'PY'
import json
import sys
payload = json.loads(open(sys.argv[1], encoding="utf-8").read())
if payload.get("status") != "ok":
    raise SystemExit(f"/ready failed: {payload}")
print("[smoke] /ready ok")
PY

post_chat() {
  local message="$1"
  local out_prefix="$2"
  local session_id="$3"

  local payload
  payload="$(python - "$TENANT_ID" "$session_id" "$message" <<'PY'
import json
import sys
tenant_id = sys.argv[1]
session_id = sys.argv[2]
user_message = sys.argv[3]
print(json.dumps({
    "tenant_id": tenant_id,
    "session_id": session_id,
    "user_message": user_message,
}, ensure_ascii=False))
PY
)"

  local i
  for i in $(seq 1 6); do
    if curl -fsS "${CURL_TIMEOUT_ARGS[@]}" \
      -D "${tmp_dir}/${out_prefix}.headers" \
      -o "${tmp_dir}/${out_prefix}.json" \
      -X POST "${API_BASE_URL%/}/v1/chat/query" \
      -H "content-type: application/json" \
      -H "accept: application/json" \
      --data "$payload"; then
      break
    fi
    sleep 2
  done

  if [[ "$i" -eq 6 ]]; then
    echo "[smoke] chat request failed after retries: ${out_prefix}" >&2
    exit 1
  fi

  if ! grep -iq '^x-request-id:' "${tmp_dir}/${out_prefix}.headers"; then
    echo "[smoke] missing X-Request-ID header for ${out_prefix}" >&2
    cat "${tmp_dir}/${out_prefix}.headers" >&2
    exit 1
  fi
}

post_chat \
  "$POLICY_TEST_MESSAGE" \
  "policy" \
  "${SESSION_ID_PREFIX}-policy-$(date +%s)"

python - "${tmp_dir}/policy.json" <<'PY'
import json
import sys
payload = json.loads(open(sys.argv[1], encoding="utf-8").read())
if payload.get("intent") != "policy":
    raise SystemExit(f"policy intent mismatch: {payload}")
sources = payload.get("sources") or []
if len(sources) < 1:
    raise SystemExit(f"policy source missing: {payload}")
if payload.get("why_fallback") not in (None, ""):
    raise SystemExit(f"policy fallback must be null: {payload}")
print("[smoke] /v1/chat/query policy path ok")
PY

post_chat \
  "$TRACKING_MISSING_TEST_MESSAGE" \
  "tracking_missing" \
  "${SESSION_ID_PREFIX}-tracking-$(date +%s)"

python - "${tmp_dir}/tracking_missing.json" <<'PY'
import json
import sys
payload = json.loads(open(sys.argv[1], encoding="utf-8").read())
if payload.get("intent") != "tracking":
    raise SystemExit(f"tracking intent mismatch: {payload}")
if payload.get("why_fallback") != "tracking_missing_number":
    raise SystemExit(f"tracking fallback code mismatch: {payload}")
print("[smoke] /v1/chat/query tracking missing-number path ok")
PY

echo "[smoke] all checks passed"
