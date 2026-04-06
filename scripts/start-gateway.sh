#!/bin/bash
set -euo pipefail

# Load environment variables from docs/.env, if present
ENV_FILE="$(pwd)/docs/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport
  source "$ENV_FILE"
  set +o allexport
fi

LOG_DIR="$(pwd)/logs"
RUN_DIR="$(pwd)/run"
LOG_FILE="$LOG_DIR/gateway.log"
PID_FILE="$RUN_DIR/gateway.pid"

mkdir -p "$LOG_DIR" "$RUN_DIR"

if [[ -f "$PID_FILE" ]]; then
  if kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    echo "Gateway already running (PID $(cat "$PID_FILE"))." >&2
    exit 0
  fi
fi

for port in 4000 4105 4106 4107 8080; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use; stop the occupying process before starting the gateway." >&2
    exit 1
  fi
done

echo "Starting LLM-Hub gateway..."
nohup node gateway.mjs >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "Gateway started with PID $(cat "$PID_FILE"), logging to $LOG_FILE"
