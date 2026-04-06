# 测试 quan2go /responses 端点（流式）

set -e

echo "=========================================="
echo "测试 quan2go /responses 端点（流式）"
echo "=========================================="
echo ""

# 检查环境变量
if [ -z "$QUAN2GO_KEY" ]; then
    echo "❌ 错误：请设置 QUAN2GO_KEY 环境变量"
    exit 1
fi

echo "✓ 环境变量已设置"
echo ""

echo "📡 发送流式请求到 /openai/responses"
echo "   URL: https://capi.quan2go.com/openai/responses"
echo ""

curl -X POST https://capi.quan2go.com/openai/responses \
  -H "Authorization: Bearer $QUAN2GO_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "instructions": "You are a helpful assistant.",
    "input": [{"role": "user", "content": "Say hello"}],
    "stream": true
  }'

echo ""
echo ""
echo "✅ 测试完成"
