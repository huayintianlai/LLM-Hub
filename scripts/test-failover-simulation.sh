#!/bin/bash

set -e

echo "=========================================="
echo "LLM-Hub 故障转移测试"
echo "=========================================="
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${YELLOW}⚠️  此测试将模拟上游故障，验证自动故障转移${NC}"
echo ""
echo "测试场景:"
echo "  1. 正常请求 - 验证主上游工作"
echo "  2. 模拟主上游故障 - 使用错误的 API key"
echo "  3. 验证自动切换到备用上游"
echo "  4. 恢复主上游 - 验证自动恢复"
echo ""

# 备份原始配置
echo "备份当前配置..."
docker exec llm-hub-gateway cp /app/.env /app/.env.backup
echo -e "${GREEN}✓ 配置已备份${NC}"
echo ""

# 测试 1: 正常请求
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}阶段 1: 正常请求（主上游）${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for i in {1..3}; do
  echo -n "请求 $i/3: "
  response=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"test"}],"stream":false}')

  if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 成功${NC}"
  else
    echo -e "${RED}✗ 失败${NC}"
  fi
  sleep 1
done
echo ""

# 测试 2: 模拟主上游故障
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}阶段 2: 模拟主上游故障${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "修改 quan2go API key 为无效值..."
docker exec llm-hub-gateway sed -i 's/GPT_KEY_B=.*/GPT_KEY_B=invalid-key-for-testing/' /app/.env
echo -e "${YELLOW}⚠️  quan2go 已设置为无效 key${NC}"
echo ""

echo "重启网关以应用更改..."
docker-compose restart > /dev/null 2>&1
sleep 5
echo -e "${GREEN}✓ 网关已重启${NC}"
echo ""

# 测试 3: 触发故障转移
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}阶段 3: 触发故障转移（应切换到 yunyi）${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "发送请求触发故障检测（需要 3 次失败）..."
for i in {1..5}; do
  echo -n "请求 $i/5: "
  response=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"failover test"}],"stream":false}')

  if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
    content=$(echo "$response" | jq -r '.choices[0].message.content' | head -c 50)
    echo -e "${GREEN}✓ 成功${NC} - $content"
  else
    error=$(echo "$response" | jq -r '.error // "unknown error"' | head -c 100)
    echo -e "${YELLOW}⚠️  失败${NC} - $error"
  fi
  sleep 2
done
echo ""

echo "检查熔断器状态..."
docker exec llm-hub-gateway tail -30 /app/logs/gateway.log | grep -E "circuit|upstream|failover" | tail -10
echo ""

# 测试 4: 恢复主上游
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}阶段 4: 恢复主上游${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "恢复原始配置..."
docker exec llm-hub-gateway cp /app/.env.backup /app/.env
docker exec llm-hub-gateway rm /app/.env.backup
echo -e "${GREEN}✓ 配置已恢复${NC}"
echo ""

echo "重启网关..."
docker-compose restart > /dev/null 2>&1
sleep 5
echo -e "${GREEN}✓ 网关已重启${NC}"
echo ""

echo "验证恢复后的请求..."
for i in {1..3}; do
  echo -n "请求 $i/3: "
  response=$(curl -s -X POST http://localhost:4000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"recovery test"}],"stream":false}')

  if echo "$response" | jq -e '.choices[0].message.content' > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 成功${NC}"
  else
    echo -e "${RED}✗ 失败${NC}"
  fi
  sleep 1
done
echo ""

# 总结
echo "=========================================="
echo "故障转移测试完成"
echo "=========================================="
echo ""
echo -e "${GREEN}✓ 测试完成${NC}"
echo ""
echo "关键观察点:"
echo "  1. 主上游故障后，请求是否仍然成功？"
echo "  2. 日志中是否出现 'circuit breaker' 警告？"
echo "  3. 恢复后是否正常工作？"
echo ""
echo "查看完整日志:"
echo "  docker logs llm-hub-gateway -f"
