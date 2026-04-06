#!/bin/bash

set -e

echo "=========================================="
echo "LLM-Hub Docker Deployment Test"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Helper function
test_endpoint() {
  local name=$1
  local port=$2
  local path=$3
  local data=$4
  local headers=$5

  echo -n "Testing $name... "

  if response=$(docker exec llm-hub-gateway node -e "
    const http = require('http');
    const req = http.request({
      hostname: '127.0.0.1',
      port: $port,
      path: '$path',
      method: 'POST',
      headers: $headers
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('OK');
          process.exit(0);
        } else {
          console.log('FAIL: Status ' + res.statusCode);
          process.exit(1);
        }
      });
    });
    req.on('error', e => { console.log('ERROR: ' + e.message); process.exit(1); });
    req.write('$data');
    req.end();
  " 2>&1); then
    echo -e "${GREEN}✓ PASSED${NC}"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗ FAILED${NC}"
    echo "  Response: $response"
    ((TESTS_FAILED++))
  fi
}

# Check if container is running
echo "1. Checking container status..."
if docker ps | grep -q llm-hub-gateway; then
  echo -e "${GREEN}✓ Container is running${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ Container is not running${NC}"
  ((TESTS_FAILED++))
  exit 1
fi
echo ""

# Check ports
echo "2. Checking exposed ports..."
for port in 4000 4105 4106 4107 8080; do
  if docker port llm-hub-gateway $port >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Port $port is exposed${NC}"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗ Port $port is not exposed${NC}"
    ((TESTS_FAILED++))
  fi
done
echo ""

# Test default port (4000)
echo "3. Testing default port (4000)..."
test_endpoint "Chat completions" 4000 "/v1/chat/completions" \
  '{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  "{'Content-Type':'application/json'}"
echo ""

# Test KekeBaby port (4106)
echo "4. Testing KekeBaby port (4106)..."
test_endpoint "KekeBaby endpoint" 4106 "/v1/chat/completions" \
  '{"model":"gpt-5.4","messages":[{"role":"user","content":"test"}],"stream":false}' \
  "{'Content-Type':'application/json'}"
echo ""

# Test Codex port (4105) with /responses
echo "5. Testing Codex port (4105) with /responses..."
test_endpoint "Codex /responses" 4105 "/responses" \
  '{"model":"gpt-5.3-codex","instructions":"hi","stream":true}' \
  "{'Content-Type':'application/json','Authorization':'Bearer test'}"
echo ""

# Test Claude Code port (4107)
echo "6. Testing Claude Code port (4107)..."
test_endpoint "Claude Code endpoint" 4107 "/v1/chat/completions" \
  '{"model":"gpt-5.4","messages":[{"role":"user","content":"test"}],"stream":false}' \
  "{'Content-Type':'application/json'}"
echo ""

# Check logs
echo "7. Checking container logs..."
if docker logs llm-hub-gateway 2>&1 | grep -q "listener started"; then
  echo -e "${GREEN}✓ Gateway started successfully${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ Gateway startup logs not found${NC}"
  ((TESTS_FAILED++))
fi
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed.${NC}"
  exit 1
fi
