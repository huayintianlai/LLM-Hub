#!/bin/bash

# 测试 GPT 渠道是否可用

echo "=========================================="
echo "测试 GPT 渠道"
echo "=========================================="
echo ""

# 加载环境变量
source .env

# 测试函数
test_key() {
    local key_name=$1
    local key_value=$2

    echo "测试 $key_name..."

    if [[ "$key_value" == "sk-"* ]]; then
        echo "  ⏭️  跳过（占位符）"
        echo ""
        return
    fi

    # 测试简单的 chat/completions 端点
    response=$(curl -s -w "\n%{http_code}" -X POST https://yunyi.cfd/codex/v1/chat/completions \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $key_value" \
        -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"hi"}],"stream":false}' \
        2>&1)

    http_code=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" == "200" ]]; then
        echo "  ✅ 可用 (HTTP $http_code)"
    elif [[ "$body" == *"Invalid API key"* ]]; then
        echo "  ❌ 失效 (Invalid API key)"
    elif [[ "$http_code" == "401" ]]; then
        echo "  ❌ 失效 (HTTP 401 Unauthorized)"
    elif [[ "$http_code" == "422" ]] || [[ "$body" == *"请提供请求的上下文"* ]]; then
        echo "  ✅ 可用 (HTTP $http_code - API 响应正常，只是请求格式需要调整)"
    else
        echo "  ⚠️  未知状态 (HTTP $http_code)"
        echo "  响应: $(echo "$body" | head -c 100)"
    fi
    echo ""
}

# 测试所有 GPT keys
test_key "GPT_KEY_A" "$GPT_KEY_A"
test_key "GPT_KEY_B" "$GPT_KEY_B"
test_key "GPT_KEY_C" "$GPT_KEY_C"
test_key "GPT_KEY_D" "$GPT_KEY_D"

echo "=========================================="
echo "测试完成"
echo "=========================================="
echo ""
echo "当前 codex_proxy.mjs 使用: GPT_KEY_A"
echo "如需切换渠道，修改 codex_proxy.mjs 第 22 行"
