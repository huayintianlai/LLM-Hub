#!/bin/bash
set -euo pipefail

PID_FILE="$(pwd)/run/gateway.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No gateway PID file found; nothing to stop."
  exit 0
fi

PID=$(cat "$PID_FILE")

if ! kill -0 "$PID" >/dev/null 2>&1; then
  echo "Gateway process $PID is not running; removing stale PID file."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping gateway (PID $PID)..."
kill "$PID"

for _ in {1..5}; do
  if ! kill -0 "$PID" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if kill -0 "$PID" >/dev/null 2>&1; then
  echo "Gateway did not stop after SIGTERM; sending SIGKILL."
  kill -KILL "$PID"
fi

rm -f "$PID_FILE"
echo "Gateway stopped."
