#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f ".env" ]; then
  set -a
  source .env
  set +a
elif [ -f "docs/.env" ]; then
  set -a
  source docs/.env
  set +a
fi

export PASSTHROUGH_API_KEY="${PASSTHROUGH_API_KEY:-${UPSTREAM_PRIMARY_API_KEY:-${GPT_KEY_B:-}}}"

if [ -z "$PASSTHROUGH_API_KEY" ]; then
  echo "❌ PASSTHROUGH_API_KEY 未设置"
  exit 1
fi

cleanup() {
  ./scripts/stop-phase1.sh >/dev/null 2>&1 || true
}
trap cleanup EXIT

./scripts/start-phase1.sh >/tmp/acceptance-phase1-start.log

OUTPUT_FILE="logs/codex-acceptance-output.txt"
mkdir -p logs

if ! codex exec \
  --skip-git-repo-check \
  --color never \
  -c model_provider='"localpassthrough"' \
  -c model='"gpt-5.4"' \
  -c model_reasoning_effort='"high"' \
  -c 'model_providers.localpassthrough={name="localpassthrough",base_url="http://127.0.0.1:4105",wire_api="responses",requires_openai_auth=true,experimental_bearer_token="dev-token"}' \
  'Reply with exactly PHASE1_OK and nothing else.' | tee "$OUTPUT_FILE"; then
  if ! grep -q "Request received" logs/phase1-proxy.log 2>/dev/null; then
    echo "⚠️  Codex CLI 未实际打到本地代理。当前环境可能对嵌套 Codex -> localhost provider 有限制。"
  fi
  echo "❌ Codex CLI passthrough acceptance failed"
  exit 1
fi

if grep -q 'PHASE1_OK' "$OUTPUT_FILE"; then
  echo "✅ Codex CLI passthrough acceptance passed"
else
  echo "❌ Codex CLI passthrough acceptance failed"
  exit 1
fi
