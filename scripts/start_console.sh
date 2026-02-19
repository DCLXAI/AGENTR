#!/usr/bin/env bash
set -euo pipefail

export SERVICE_NAME="console"

exec streamlit run console/streamlit_app.py \
  --server.address 0.0.0.0 \
  --server.port "${PORT:-8501}" \
  --server.headless true

