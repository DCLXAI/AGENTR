#!/usr/bin/env bash
set -euo pipefail

RUN_WINDOW_SECONDS="${RUN_WINDOW_SECONDS:-280}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-20}"
SESSION_ID_PREFIX_BASE="${SESSION_ID_PREFIX_BASE:-naver-auto-cron}"
ALLOW_BLOCKED_EXIT="${ALLOW_BLOCKED_EXIT:-true}"

if ! [[ "$RUN_WINDOW_SECONDS" =~ ^[0-9]+$ ]] || [[ "$RUN_WINDOW_SECONDS" -le 0 ]]; then
  echo "RUN_WINDOW_SECONDS must be a positive integer." >&2
  exit 1
fi
if ! [[ "$POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || [[ "$POLL_INTERVAL_SECONDS" -le 0 ]]; then
  echo "POLL_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
fi

deadline="$(( $(date +%s) + RUN_WINDOW_SECONDS ))"
iteration=0
total_posted=0
total_processed=0
total_blocked=0

while true; do
  now="$(date +%s)"
  if (( now >= deadline )); then
    break
  fi

  iteration="$((iteration + 1))"
  export SESSION_ID_PREFIX="${SESSION_ID_PREFIX_BASE}-${iteration}"
  export ALLOW_BLOCKED_EXIT

  tmp_out="$(mktemp)"
  if bash scripts/naver_auto_reply_drain.sh >"$tmp_out" 2>/tmp/naver_auto_reply_err.log; then
    if command -v python3 >/dev/null 2>&1; then
      stats="$(
        python3 - <<'PY' "$tmp_out"
import json
import sys
from pathlib import Path
body = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
posted = int(body.get("posted") or 0)
processed = int(body.get("processed") or 0)
blocked = int(body.get("blocked") or 0)
print(f"{posted} {processed} {blocked}")
PY
      )"
      posted="$(echo "$stats" | awk '{print $1}')"
      processed="$(echo "$stats" | awk '{print $2}')"
      blocked="$(echo "$stats" | awk '{print $3}')"
      total_posted="$((total_posted + posted))"
      total_processed="$((total_processed + processed))"
      total_blocked="$((total_blocked + blocked))"
    fi
    echo "iteration=${iteration} result=$(cat "$tmp_out")"
  else
    err_text="$(cat /tmp/naver_auto_reply_err.log 2>/dev/null || true)"
    echo "iteration=${iteration} status=error error=$(printf '%s' "$err_text" | tr '\n' ' ')" >&2
  fi
  rm -f "$tmp_out" /tmp/naver_auto_reply_err.log

  now="$(date +%s)"
  next_sleep="$POLL_INTERVAL_SECONDS"
  if (( now + next_sleep >= deadline )); then
    break
  fi
  sleep "$next_sleep"
done

echo "{\"status\":\"ok\",\"iterations\":${iteration},\"total_processed\":${total_processed},\"total_posted\":${total_posted},\"total_blocked\":${total_blocked}}"
