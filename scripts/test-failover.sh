#!/bin/bash

set -e

echo "=========================================="
echo "LLM-Hub 容灾测试"
echo "=========================================="
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 测试计数
TESTS_PASSED=0
TESTS_FAILED=0

echo "测试配置:"
echo "  - 优先级 1: quan2go (支持 /responses)"
echo "  - 优先级 2: yunyi (仅支持 /chat/completions)"
echo "  - 故障阈值: 3 次失败"
echo "  - 冷却时间: 60 秒"
echo ""

# 测试 1: 正常请求 - chat completions
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}测试 1: 正常请求 - /chat/completions${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for i in {1..5}; do
  echo -n "请求 $i/5: "
  response=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"gpt-5.4\",\"messages\":[{\"role\":\"user\",\"content\":\"Test $i\"}],\"stream\":false}")

  if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
    content=$(echo "$response" | jq -r '.choices[0].message.content')
    echo -e "${GREEN}✓ 成功${NC} - 响应: $content"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗ 失败${NC}"
    echo "  响应: $response"
    ((TESTS_FAILED++))
  fi
  sleep 1
done
echo ""

# 测试 2: 正常请求 - responses API
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}测试 2: 正常请求 - /responses (Codex 格式)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for i in {1..3}; do
  echo -n "请求 $i/3: "
  response=$(curl -s -X POST http://localhost:4105/responses \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer 3G6QUVPC-BKVB-1Z34-UY8E-R1TK6QHZ6N0F" \
    -d "{\"model\":\"gpt-5.3-codex\",\"instructions\":\"Say: Test $i\",\"stream\":false}")

  if echo "$response" | jq -e '.output[0].content[0].text' > /dev/null 2>&1; then
    content=$(echo "$response" | jq -r '.output[0].content[0].text')
    echo -e "${GREEN}✓ 成功${NC} - 响应: $content"
    ((TESTS_PASSED++))
  else
    echo -e "${RED}✗ 失败${NC}"
    echo "  响应: $(echo $response | head -c 200)"
    ((TESTS_FAILED++))
  fi
  sleep 1
done
echo ""

# 测试 3: 检查上游状态
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}测试 3: 检查上游状态${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "查看最近的上游日志:"
docker exec llm-hub-gateway tail -50 /app/logs/gateway.log 2>/dev/null | \
  grep -E "upstream|circuit|failover" | tail -10 || echo "  (无上游相关日志)"
echo ""

# 测试 4: 并发请求测试
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}测试 4: 并发请求测试 (10 个并发)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

success_count=0
fail_count=0

for i in {1..10}; do
  (
    response=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"gpt-5.4\",\"messages\":[{\"role\":\"user\",\"content\":\"Concurrent $i\"}],\"stream\":false}")

    if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
      echo "✓ 请求 $i 成功"
    else
      echo "✗ 请求 $i 失败"
    fi
  ) &
done

wait
echo ""

# 测试 5: 不同端口测试
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}测试 5: 不同应用端口测试${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 测试 KekeBaby 端口 (4106)
echo -n "KekeBaby 端口 (4106): "
response=$(curl -s -X POST http://localhost:4106/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"test"}],"stream":false}')

if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
  echo -e "${GREEN}✓ 正常${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ 失败${NC}"
  ((TESTS_FAILED++))
fi

# 测试 Claude Code 端口 (4107)
echo -n "Claude Code 端口 (4107): "
response=$(curl -s -X POST http://localhost:4107/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"test"}],"stream":false}')

if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
  echo -e "${GREEN}✓ 正常${NC}"
  ((TESTS_PASSED++))
else
  echo -e "${RED}✗ 失败${NC}"
  ((TESTS_FAILED++))
fi

echo ""

# 总结
echo "=========================================="
echo "测试总结"
echo "=========================================="
echo -e "通过: ${GREEN}$TESTS_PASSED${NC}"
echo -e "失败: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ 所有测试通过！${NC}"
  exit 0
else
  echo -e "${YELLOW}⚠ 部分测试失败，请检查日志${NC}"
  echo ""
  echo "查看详细日志:"
  echo "  docker logs llm-hub-gateway -f"
  exit 1
fi
