#!/bin/bash
set -euo pipefail

ENDPOINT="${1:-http://127.0.0.1:4000/health}"

response=$(curl -sfS "$ENDPOINT")
echo "Gateway health check succeeded: $ENDPOINT"
echo "$response"
