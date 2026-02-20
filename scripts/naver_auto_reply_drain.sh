#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8000}"
TENANT_ID="${TENANT_ID:-tenant-demo}"
SESSION_ID_PREFIX="${SESSION_ID_PREFIX:-naver-auto-cron}"
MAX_ITERATIONS="${MAX_ITERATIONS:-20}"
PAGE="${PAGE:-1}"
SIZE="${SIZE:-50}"
DRY_RUN="${DRY_RUN:-false}"
NAVER_AUTOREPLY_TOKEN="${NAVER_AUTOREPLY_TOKEN:-}"
ALLOW_BLOCKED_EXIT="${ALLOW_BLOCKED_EXIT:-false}"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "python runtime is required." >&2
  exit 1
fi

tmp_body="$(mktemp)"
cleanup() {
  rm -f "$tmp_body"
}
trap cleanup EXIT

headers=(-H "content-type: application/json")
if [[ -n "$NAVER_AUTOREPLY_TOKEN" ]]; then
  headers+=(-H "x-naver-autoreply-token: ${NAVER_AUTOREPLY_TOKEN}")
fi

payload="$(cat <<JSON
{
  "tenant_id": "${TENANT_ID}",
  "session_id_prefix": "${SESSION_ID_PREFIX}",
  "max_iterations": ${MAX_ITERATIONS},
  "page": ${PAGE},
  "size": ${SIZE},
  "dry_run": ${DRY_RUN}
}
JSON
)"

curl -fsS \
  -X POST "${API_BASE_URL%/}/v1/tools/naver/auto-answer-drain" \
  "${headers[@]}" \
  --data "$payload" \
  > "$tmp_body"

"$PYTHON_BIN" - <<'PY' "$tmp_body" "$ALLOW_BLOCKED_EXIT"
import json
import sys
from pathlib import Path

body = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
allow_blocked = str(sys.argv[2]).strip().lower() == "true"
status = body.get("status")
processed = body.get("processed")
posted = body.get("posted")
blocked = body.get("blocked")
last_reason = body.get("last_reason")

print(
    json.dumps(
        {
            "status": status,
            "processed": processed,
            "posted": posted,
            "blocked": blocked,
            "last_reason": last_reason,
        },
        ensure_ascii=False,
    )
)

if status == "blocked" and not allow_blocked:
    raise SystemExit("auto-reply blocked; check results payload")
PY
