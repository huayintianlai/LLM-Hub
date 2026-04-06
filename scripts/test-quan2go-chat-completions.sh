#!/bin/bash

# 测试 quan2go 是否支持 /chat/completions 端点
#
# 使用方法：
# 1. 设置环境变量：export QUAN2GO_KEY="your_api_key"
# 2. 运行脚本：./test-quan2go-chat-completions.sh

set -e

echo "=========================================="
echo "测试 quan2go /chat/completions 端点"
echo "=========================================="
echo ""

# 检查环境变量
if [ -z "$QUAN2GO_KEY" ]; then
    echo "❌ 错误：请设置 QUAN2GO_KEY 环境变量"
    echo "   export QUAN2GO_KEY=\"your_api_key\""
    exit 1
fi

echo "✓ 环境变量已设置"
echo ""

# 测试 /chat/completions 端点
echo "📡 测试 1: 发送请求到 /v1/chat/completions"
echo "   URL: https://capi.quan2go.com/v1/chat/completions"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST https://capi.quan2go.com/v1/chat/completions \
  -H "Authorization: Bearer $QUAN2GO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": false,
    "max_tokens": 10
  }')

# 分离响应体和状态码
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)
HTTP_BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP 状态码: $HTTP_CODE"
echo ""
echo "响应内容:"
echo "$HTTP_BODY" | jq '.' 2>/dev/null || echo "$HTTP_BODY"
echo ""

# 判断结果
if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ 成功：quan2go 支持 /chat/completions 端点"
    echo ""
    echo "结论："
    echo "  - quan2go 支持 /chat/completions 格式"
    echo "  - 问题可能在 LiteLLM 的转换逻辑"
    echo "  - 需要进一步测试 LiteLLM 发送的具体请求格式"
elif [ "$HTTP_CODE" = "404" ]; then
    echo "❌ 失败：quan2go 不支持 /chat/completions 端点（404 Not Found）"
    echo ""
    echo "结论："
    echo "  - quan2go 只支持 /responses 端点"
    echo "  - 必须使用协议适配层（codex_proxy）"
    echo "  - LiteLLM 无法直接与 quan2go 配合使用"
elif [ "$HTTP_CODE" = "400" ]; then
    echo "⚠️  警告：请求格式错误（400 Bad Request）"
    echo ""
    echo "可能原因："
    echo "  - quan2go 支持 /chat/completions 但格式要求不同"
    echo "  - 需要检查具体的错误信息"
else
    echo "⚠️  未知错误：HTTP $HTTP_CODE"
    echo ""
    echo "需要进一步分析响应内容"
fi

echo ""
echo "=========================================="
echo "测试 2: 发送请求到 /openai/responses"
echo "=========================================="
echo ""

RESPONSE2=$(curl -s -w "\n%{http_code}" -X POST https://capi.quan2go.com/openai/responses \
  -H "Authorization: Bearer $QUAN2GO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "instructions": "You are a helpful assistant.",
    "input": [{"role": "user", "content": "Say hello"}],
    "stream": false
  }')

HTTP_CODE2=$(echo "$RESPONSE2" | tail -n 1)
HTTP_BODY2=$(echo "$RESPONSE2" | sed '$d')

echo "HTTP 状态码: $HTTP_CODE2"
echo ""
echo "响应内容:"
echo "$HTTP_BODY2" | jq '.' 2>/dev/null || echo "$HTTP_BODY2"
echo ""

if [ "$HTTP_CODE2" = "200" ]; then
    echo "✅ 成功：quan2go 支持 /responses 端点（已知）"
else
    echo "❌ 失败：quan2go /responses 端点返回 HTTP $HTTP_CODE2"
fi

echo ""
echo "=========================================="
echo "总结"
echo "=========================================="
echo ""

if [ "$HTTP_CODE" = "200" ] && [ "$HTTP_CODE2" = "200" ]; then
    echo "✅ quan2go 同时支持 /chat/completions 和 /responses"
    echo ""
    echo "下一步："
    echo "  1. 检查 LiteLLM 发送给 quan2go 的具体请求格式"
    echo "  2. 对比直连和通过 LiteLLM 的请求差异"
    echo "  3. 可能需要调整 LiteLLM 的配置"
elif [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE2" = "200" ]; then
    echo "❌ quan2go 只支持 /responses，不支持 /chat/completions"
    echo ""
    echo "解决方案："
    echo "  1. 使用协议适配层（codex_proxy）"
    echo "  2. 或者直接配置 quan2go 为 Codex provider（不经过 LiteLLM）"
    echo "  3. 或者构建自定义网关，支持 /responses 到上游的直通"
else
    echo "⚠️  测试结果异常，需要进一步分析"
fi

echo ""
