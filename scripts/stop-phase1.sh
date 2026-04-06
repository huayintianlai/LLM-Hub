#!/bin/bash

# Phase 1 Stop Script
# Stops the simple-passthrough-proxy.mjs server

echo "=========================================="
echo "Stopping Phase 1 Proxy Server"
echo "=========================================="
echo ""

if [ -f "run/phase1-proxy.pid" ]; then
    STORED_PID=$(cat run/phase1-proxy.pid 2>/dev/null || true)
else
    STORED_PID=""
fi

# Find the process
PIDS=$(printf "%s\n%s" "$STORED_PID" "$(pgrep -f "simple-passthrough-proxy.mjs" || true)" | awk 'NF' | sort -u)

if [ -z "$PIDS" ]; then
    echo "ℹ️  No proxy server process found"
    exit 0
fi

echo "Found proxy server process(es): $PIDS"
echo ""

# Try graceful shutdown first (SIGTERM)
echo "Attempting graceful shutdown (SIGTERM)..."
for PID in $PIDS; do
    kill -TERM $PID 2>/dev/null || true
done

# Wait up to 5 seconds for graceful shutdown
WAITED=0
MAX_WAIT=5

while [ $WAITED -lt $MAX_WAIT ]; do
    REMAINING=$(pgrep -f "simple-passthrough-proxy.mjs" || true)
    if [ -z "$REMAINING" ]; then
        echo "✅ Proxy server stopped gracefully"
        exit 0
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

# If still running, force kill (SIGKILL)
REMAINING=$(pgrep -f "simple-passthrough-proxy.mjs" || true)
if [ ! -z "$REMAINING" ]; then
    echo "⚠️  Graceful shutdown failed, forcing shutdown (SIGKILL)..."
    for PID in $REMAINING; do
        kill -KILL $PID 2>/dev/null || true
    done
    sleep 1
fi

# Final check
STILL_RUNNING=$(pgrep -f "simple-passthrough-proxy.mjs" || true)
if [ -z "$STILL_RUNNING" ]; then
    echo "✅ Proxy server stopped (forced)"
    exit 0
else
    echo "❌ Failed to stop proxy server"
    echo "Remaining processes: $STILL_RUNNING"
    exit 1
fi
