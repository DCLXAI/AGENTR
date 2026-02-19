#!/usr/bin/env bash
set -euo pipefail

export SERVICE_NAME="api"

exec uvicorn app.api.main:app --host 0.0.0.0 --port "${PORT:-8000}"

