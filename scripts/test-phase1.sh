#!/bin/bash

# Phase 1 Test Script
# Tests the simple-passthrough-proxy.mjs to verify it works correctly

set -e

if [ -f "docs/.env" ]; then
    set -a
    source docs/.env
    set +a
fi

echo "=========================================="
echo "Phase 1 Functional Test"
echo "=========================================="
echo ""

PASS=0
FAIL=0
PROXY_PID=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
test_pass() {
    echo -e "${GREEN}✅ $1${NC}"
    PASS=$((PASS + 1))
}

test_fail() {
    echo -e "${RED}❌ $1${NC}"
    FAIL=$((FAIL + 1))
}

test_info() {
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

# Cleanup function
cleanup() {
    if [ ! -z "$PROXY_PID" ]; then
        test_info "Stopping proxy server (PID: $PROXY_PID)..."
        kill $PROXY_PID 2>/dev/null || true
        wait $PROXY_PID 2>/dev/null || true
    fi
}

# Set trap for cleanup
trap cleanup EXIT

# 1. Check environment variable
echo "1. Checking environment..."
if [ -z "$GPT_KEY_B" ]; then
    test_fail "Environment variable GPT_KEY_B is not set"
    echo ""
    echo "Please set GPT_KEY_B:"
    echo "  export GPT_KEY_B=\"your-api-key\""
    exit 1
else
    test_pass "Environment variable GPT_KEY_B is set"
fi

echo ""

# 2. Start proxy server
echo "2. Starting proxy server..."
mkdir -p logs run
node simple-passthrough-proxy.mjs > /tmp/proxy-test.log 2>&1 &
PROXY_PID=$!
echo "$PROXY_PID" > run/phase1-proxy.pid

test_info "Proxy server started (PID: $PROXY_PID)"

# 3. Wait for server to be ready
echo ""
echo "3. Waiting for server to be ready..."
MAX_WAIT=10
WAITED=0

while [ $WAITED -lt $MAX_WAIT ]; do
    if lsof -i :4105 -sTCP:LISTEN -t >/dev/null 2>&1; then
        test_pass "Server is listening on port 4105"
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

if [ $WAITED -eq $MAX_WAIT ]; then
    test_fail "Server failed to start within ${MAX_WAIT} seconds"
    echo ""
    echo "Server log:"
    cat /tmp/proxy-test.log
    exit 1
fi

echo ""

# 4. Send test request
echo "4. Sending test request..."

# Create test request payload
TEST_PAYLOAD=$(cat <<'EOF'
{
  "model": "gpt-5.4",
  "instructions": "You are a terse assistant.",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Say 'Hello from Phase 1 test' and nothing else."
        }
      ]
    }
  ],
  "stream": true
}
EOF
)

# Send request and capture response
RESPONSE_FILE="/tmp/proxy-test-response.txt"
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$RESPONSE_FILE" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -H "Accept: text/event-stream" \
  -d "$TEST_PAYLOAD" \
  http://127.0.0.1:4105/responses)

echo ""

# 5. Verify response
echo "5. Verifying response..."

# Check HTTP status code
if [ "$HTTP_CODE" = "200" ]; then
    test_pass "HTTP status code is 200"
else
    test_fail "HTTP status code is $HTTP_CODE (expected 200)"
fi

if grep -qi "text/event-stream" "$RESPONSE_FILE" || grep -q "event:" "$RESPONSE_FILE"; then
    test_pass "Response behaves like SSE"
else
    test_fail "Response does not look like SSE"
fi

# Check for SSE events
if grep -q "event: response.created" "$RESPONSE_FILE"; then
    test_pass "Response contains 'event: response.created'"
else
    test_fail "Response does not contain 'event: response.created'"
fi

if grep -q "event: response.done" "$RESPONSE_FILE" || grep -q "event: response.completed" "$RESPONSE_FILE"; then
    test_pass "Response contains completion event"
else
    test_fail "Response does not contain completion event"
fi

# Check for streaming data
if grep -q "data:" "$RESPONSE_FILE"; then
    test_pass "Response contains streaming data"
else
    test_fail "Response does not contain streaming data"
fi

echo ""

# 6. Display sample response
echo "6. Sample response (first 20 lines):"
echo "---"
head -n 20 "$RESPONSE_FILE"
echo "---"

echo ""

# 7. Summary
echo "=========================================="
echo "Test Results"
echo "=========================================="
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Review the response format above"
    echo "  2. Test with Codex CLI: codex exec \"echo hello\""
    echo "  3. Proceed to Phase 2 implementation"
    exit 0
else
    echo -e "${RED}❌ $FAIL test(s) failed${NC}"
    echo ""
    echo "Server log:"
    cat /tmp/proxy-test.log
    exit 1
fi
