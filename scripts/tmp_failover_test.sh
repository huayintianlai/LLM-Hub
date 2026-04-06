#!/usr/bin/env bash
set -euo pipefail

source .env

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]]; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
  fi
  docker rm -f litellm-codex-failover-test >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker rm -f litellm-codex-failover-test >/dev/null 2>&1 || true

docker run -d --rm \
  --name litellm-codex-failover-test \
  -p 127.0.0.1:4010:4010 \
  -v "$PWD/config.failover-test.yaml:/app/config.yaml:ro" \
  -e LITELLM_MASTER_KEY \
  -e GPT_KEY_A \
  -e GPT_KEY_B \
  ghcr.io/berriai/litellm:main-stable \
  --config /app/config.yaml \
  --port 4010 \
  --num_workers 1 >/tmp/litellm_failover_container_id

for _ in $(seq 1 25); do
  if curl -fsS -H "Authorization: Bearer $LITELLM_MASTER_KEY" http://127.0.0.1:4010/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo '--- direct litellm codex ---'
DIRECT_BODY=$(mktemp)
curl -sN -D - \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4010/v1/chat/completions \
  --data-binary @- <<'JSON' | tee "$DIRECT_BODY" | head -n 35
{"model":"codex","messages":[{"role":"user","content":"Reply exactly OK and nothing else."}],"stream":true}
JSON

echo '--- via temp proxy ---'
CODEX_PROXY_PORT=4110 CODEX_PROXY_TARGET=http://127.0.0.1:4010 USE_LITELLM=true node codex_proxy.mjs >/tmp/codex_failover_proxy.log 2>&1 &
PROXY_PID=$!
sleep 2
PROXY_BODY=$(mktemp)
curl -sN -D - \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4110/responses \
  --data-binary @- <<'JSON' | tee "$PROXY_BODY" | head -n 45
{"model":"gpt-5.4","input":"Reply exactly OK and nothing else.","stream":true}
JSON

echo '--- direct header extract ---'
grep -iE 'x-litellm-model-id|x-litellm-model-api-base|HTTP/' "$DIRECT_BODY" || true

echo '--- proxy header extract ---'
grep -iE 'x-litellm-model-id|x-litellm-model-api-base|x-codex-proxy-target|HTTP/' "$PROXY_BODY" || true
