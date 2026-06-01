#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  source .env
  set +a
elif [[ -f "docs/.env" ]]; then
  set -a
  source docs/.env
  set +a
fi

RUN_CODEX_ACCEPTANCE="${RUN_CODEX_ACCEPTANCE:-0}"

cleanup() {
  ./scripts/stop-gateway.sh >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> init db"
node tools/init-db.mjs

echo "==> migrate db"
node tools/migrate-db.mjs

echo "==> node test suite"
npm run test

echo "==> phase1 passthrough"
./scripts/test-phase1.sh

echo "==> start gateway"
./scripts/start-gateway.sh
sleep 2

echo "==> health check"
./scripts/health-check.sh

echo "==> dashboard summary"
curl -fsS http://127.0.0.1:8080/api/summary >/tmp/llmhub-acceptance-summary.json
cat /tmp/llmhub-acceptance-summary.json
echo

echo "==> passthrough smoke"
curl -fsS -X POST http://127.0.0.1:4105/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local" \
  -d '{"model":"gpt-5.4","instructions":"You are terse.","input":[{"role":"user","content":[{"type":"input_text","text":"Reply with ACCEPT_STREAM_OK only."}]}],"stream":true}' \
  >/tmp/llmhub-acceptance-stream.txt
grep -q 'response.created' /tmp/llmhub-acceptance-stream.txt
grep -q 'response.completed' /tmp/llmhub-acceptance-stream.txt
head -n 20 /tmp/llmhub-acceptance-stream.txt

echo "==> transform smoke"
curl -fsS -X POST http://127.0.0.1:4105/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local" \
  -d '{"model":"gpt-5.4","instructions":"You are terse.","input":[{"role":"user","content":[{"type":"input_text","text":"Reply with ACCEPT_JSON_OK only."}]}],"stream":false}' \
  >/tmp/llmhub-acceptance-transform.json
grep -q 'ACCEPT_JSON_OK' /tmp/llmhub-acceptance-transform.json
cat /tmp/llmhub-acceptance-transform.json
echo

if [[ "$RUN_CODEX_ACCEPTANCE" == "1" ]]; then
  echo "==> codex cli acceptance"
  ./scripts/stop-gateway.sh >/dev/null 2>&1 || true
  ./scripts/acceptance-codex.sh
else
  echo "==> codex cli acceptance skipped (set RUN_CODEX_ACCEPTANCE=1 to enable)"
fi

echo "==> acceptance suite finished"
