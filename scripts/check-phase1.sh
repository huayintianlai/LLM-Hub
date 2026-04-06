#!/bin/bash

# Phase 1 自动检查脚本
# 用于验证 Phase 1 的所有交付物是否符合要求

set -e

echo "=========================================="
echo "Phase 1 自动检查"
echo "=========================================="
echo ""

PASS=0
FAIL=0

# 辅助函数
check_pass() {
    echo "✅ $1"
    PASS=$((PASS + 1))
}

check_fail() {
    echo "❌ $1"
    FAIL=$((FAIL + 1))
}

# 1. 检查文件是否存在
echo "1. 检查交付物..."
if [ -f "simple-passthrough-proxy.mjs" ]; then
    check_pass "simple-passthrough-proxy.mjs 存在"
else
    check_fail "simple-passthrough-proxy.mjs 不存在"
fi

if [ -f "scripts/test-phase1.sh" ]; then
    check_pass "scripts/test-phase1.sh 存在"
else
    check_fail "scripts/test-phase1.sh 不存在"
fi

if [ -f "scripts/start-phase1.sh" ]; then
    check_pass "scripts/start-phase1.sh 存在"
else
    check_fail "scripts/start-phase1.sh 不存在"
fi

if [ -f "scripts/stop-phase1.sh" ]; then
    check_pass "scripts/stop-phase1.sh 存在"
else
    check_fail "scripts/stop-phase1.sh 不存在"
fi

echo ""

# 2. 检查代码质量
echo "2. 检查代码质量..."

if [ -f "simple-passthrough-proxy.mjs" ]; then
    # 检查是否有硬编码的 API Key
    if grep -q "sk-" simple-passthrough-proxy.mjs; then
        check_fail "发现硬编码的 API Key"
    else
        check_pass "没有硬编码的 API Key"
    fi

    # 检查是否使用了环境变量
    if grep -q "process.env.GPT_KEY_B" simple-passthrough-proxy.mjs; then
        check_pass "使用了环境变量 GPT_KEY_B"
    else
        check_fail "没有使用环境变量 GPT_KEY_B"
    fi

    # 检查是否有错误处理
    if grep -q "on('error'" simple-passthrough-proxy.mjs; then
        check_pass "有错误处理"
    else
        check_fail "缺少错误处理"
    fi

    # 检查是否使用了 pipe
    if grep -q "pipe" simple-passthrough-proxy.mjs; then
        check_pass "使用了 pipe 转发响应"
    else
        check_fail "没有使用 pipe 转发响应"
    fi
fi

echo ""

# 3. 检查脚本可执行性
echo "3. 检查脚本权限..."

for script in scripts/test-phase1.sh scripts/start-phase1.sh scripts/stop-phase1.sh; do
    if [ -f "$script" ]; then
        if [ -x "$script" ]; then
            check_pass "$script 可执行"
        else
            check_fail "$script 不可执行（需要 chmod +x）"
        fi
    fi
done

echo ""

# 4. 总结
echo "=========================================="
echo "检查结果"
echo "=========================================="
echo "通过: $PASS"
echo "失败: $FAIL"
echo ""

if [ $FAIL -eq 0 ]; then
    echo "✅ 所有检查通过！可以进行功能测试。"
    exit 0
else
    echo "❌ 有 $FAIL 项检查失败，请修复后重新检查。"
    exit 1
fi
