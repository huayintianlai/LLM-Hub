#!/bin/bash

# Test OpenAI-compatible upstream API keys.

echo "=========================================="
echo "测试 OpenAI-compatible 上游"
echo "=========================================="
echo ""

if [ -f ".env" ]; then
    source .env
fi

UPSTREAM_TEST_CHAT_URL="${UPSTREAM_TEST_CHAT_URL:-https://backup.example.com/v1/chat/completions}"
UPSTREAM_TEST_MODEL="${UPSTREAM_TEST_MODEL:-general-model}"

# 测试函数
test_key() {
    local key_name=$1
    local key_value=$2

    echo "测试 $key_name..."

    if [[ -z "$key_value" ]] || [[ "$key_value" == replace-with-* ]] || [[ "$key_value" == "sk-"* ]]; then
        echo "  ⏭️  跳过（占位符）"
        echo ""
        return
    fi

    # 测试简单的 chat/completions 端点
    response=$(curl -s -w "\n%{http_code}" -X POST "$UPSTREAM_TEST_CHAT_URL" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $key_value" \
        -d "{\"model\":\"$UPSTREAM_TEST_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}" \
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

# Test common compatibility aliases and generic upstream keys.
test_key "UPSTREAM_PRIMARY_API_KEY" "${UPSTREAM_PRIMARY_API_KEY:-}"
test_key "UPSTREAM_BACKUP_API_KEY" "${UPSTREAM_BACKUP_API_KEY:-}"
test_key "GPT_KEY_A" "$GPT_KEY_A"
test_key "GPT_KEY_B" "$GPT_KEY_B"
test_key "GPT_KEY_C" "$GPT_KEY_C"
test_key "GPT_KEY_D" "$GPT_KEY_D"

echo "=========================================="
echo "测试完成"
echo "=========================================="
echo ""
echo "测试 URL: $UPSTREAM_TEST_CHAT_URL"
echo "测试模型: $UPSTREAM_TEST_MODEL"
