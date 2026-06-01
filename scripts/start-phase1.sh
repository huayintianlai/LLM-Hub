#!/bin/bash

# Phase 1 Start Script
# Starts the LLM-Hub gateway (replaces simple-passthrough-proxy.mjs)

set -e

if [ -f ".env" ]; then
  set -a
  source .env
  set +a
elif [ -f "docs/.env" ]; then
  set -a
  source docs/.env
  set +a
fi

echo "=========================================="
echo "Starting LLM-Hub Gateway (Phase 1)"
echo "=========================================="
echo ""

# Check environment variable
PASSTHROUGH_API_KEY="${PASSTHROUGH_API_KEY:-${UPSTREAM_PRIMARY_API_KEY:-${GPT_KEY_B:-}}}"
export PASSTHROUGH_API_KEY

if [ -z "$PASSTHROUGH_API_KEY" ]; then
    echo "❌ Error: Environment variable PASSTHROUGH_API_KEY is not set"
    echo ""
    echo "Please set PASSTHROUGH_API_KEY:"
    echo "  export PASSTHROUGH_API_KEY=\"your-api-key\""
    exit 1
fi

echo "✅ Environment variable PASSTHROUGH_API_KEY is set"

# Check if required ports are already in use
for port in 4000 4105 4106 4107 8080; do
  if lsof -i :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "❌ Error: Port $port is already in use"
    echo ""
    echo "To find the process using port $port:"
    echo "  lsof -i :$port"
    echo ""
    echo "To stop the existing gateway:"
    echo "  ./scripts/stop-phase1.sh"
    exit 1
  fi
done

echo "✅ All required ports are available"
echo ""

# Start the gateway
echo "Starting LLM-Hub gateway..."
mkdir -p logs run
:
> logs/phase1-proxy.log
node gateway.mjs >> logs/phase1-proxy.log 2>&1 &
PID=$!
echo "$PID" > run/phase1-proxy.pid

# Wait a moment for the server to start
sleep 2

# Check if the process is still running
if ! kill -0 $PID 2>/dev/null; then
    echo "❌ Error: Gateway failed to start"
    echo "Check logs/phase1-proxy.log for details"
    exit 1
fi

# Check if the server is listening on port 4105
if ! lsof -i :4105 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "❌ Error: Gateway is not listening on port 4105"
    kill $PID 2>/dev/null || true
    exit 1
fi

echo ""
echo "=========================================="
echo "✅ LLM-Hub Gateway Started Successfully"
echo "=========================================="
echo ""
echo "Codex CLI Port: http://127.0.0.1:4105"
echo "Default Port: http://127.0.0.1:4000"
echo "Dashboard: http://127.0.0.1:8080"
echo "Process ID: $PID"
echo ""
echo "To test the gateway:"
echo "  ./scripts/test-phase1.sh"
echo ""
echo "To stop the gateway:"
echo "  ./scripts/stop-phase1.sh"
echo ""
echo "To view logs:"
echo "  tail -f logs/phase1-proxy.log"
echo ""
