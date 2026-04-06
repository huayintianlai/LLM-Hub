# LiteLLM Gateway 项目规格说明

> 注意：这份文档主要记录早期的 LiteLLM + `codex_proxy` 方案，已经不是当前实施基线。
>
> 当前项目的真实架构与实施基线以 [ARCHITECTURE.md](/Users/KenSir/Documents/coding/AIWorkSpace/LLM-Hub/ARCHITECTURE.md) 和 [TODO.md](/Users/KenSir/Documents/coding/AIWorkSpace/LLM-Hub/TODO.md) 为准。

## 项目背景

本项目旨在构建一个统一的 AI 模型网关，为多个应用提供高可用的 GPT 和 Claude 模型访问服务。

这个本地网关可以理解为一个分发器，我本地电脑的项目全都只认网关，包含：codex、Claude code、OpenClaw、kekebaby 等可能的未来项目。

可以有多种方式接入网关，但是网关往外输送 tokens 是就是最适配项目的。

另外，还能做到容灾、比如中转商限并发或不稳定等，目的就是通过多渠道抵抗中转渠道商带来的不稳定。


### 核心需求

1. **多渠道支持**：配置多个 API 中转站作为备用渠道，确保服务高可用
2. **自动故障转移**：当主渠道失败时，自动切换到备用渠道
3. **统一接口**：为所有应用提供统一的 OpenAI 兼容 API
4. **Codex CLI 支持**：支持 Codex CLI 的特殊 `/responses` API 格式

### 使用场景

- **Codex CLI**：开发者使用的 AI 编程助手 ✅
- **KekeBaby 项目**：家庭记忆数据基础设施，使用 GPT 进行照片故事性评分 ✅
- 其他需要 GPT/Claude 模型的应用

## 项目目标

### 主要目标

1. ✅ **双渠道高可用**：配置渠道 A 和渠道 B，互为备份
2. ✅ **Codex CLI 支持**：让 Codex CLI 能够通过网关正常工作
3. ✅ **自动负载均衡**：在多个渠道之间自动分配请求
4. ✅ **故障自动恢复**：失败节点冷却后自动重新启用
5. ❌ **OpenClaw 集成**：项目不存在或名称不同
6. ✅ **KekeBaby 集成**：已配置使用网关

### 技术目标

- 使用 LiteLLM 作为网关核心
- 支持 OpenAI 兼容 API
- 支持流式和非流式响应
- 提供健康检查和监控能力

## 系统架构

```
┌─────────────────┐
│   Codex CLI     │
└────────┬────────┘
         │ /responses API
         ↓
┌─────────────────┐
│ codex_proxy.mjs │ (端口 4105)
│  - 路径转换     │
│  - 格式转换     │
└────────┬────────┘
         │ /chat/completions
         ↓
┌─────────────────────────────────┐
│      LiteLLM Gateway            │ (端口 4000)
│  - 负载均衡                      │
│  - 故障转移                      │
│  - 健康检查                      │
└────────┬────────────────────────┘
         │
    ┌────┴────┐
    ↓         ↓
┌────────┐ ┌────────┐
│渠道 A   │ │渠道 B   │
│yunyi.cfd│ │quan2go │
└────────┘ └────────┘
```

## 已解决的问题

### 1. Codex 代理路径重写错误 ✅

**问题描述**：
- 旧版 `codex_proxy.mjs` 会将 `/responses` 错误地重写为 `/chat/completions`
- 导致 Codex CLI 无法正常工作

**解决方案**：
- 修改 `rewritePath` 函数，根据目标渠道决定是否转换路径
- 当使用 LiteLLM 时：`/responses` → `/chat/completions`
- 当直连上游时：保持 `/responses` 不变

**相关文件**：
- `codex_proxy.mjs`
- `docs/CODEX_TROUBLESHOOTING.md`

### 2. 端口配置不匹配 ✅

**问题描述**：
- Codex CLI 配置文件中的端口是 8105
- 实际代理监听的是 4105 端口

**解决方案**：
- 更新 `~/.codex/config.toml` 中的 `base_url` 为 `http://127.0.0.1:4105`

**相关文件**：
- `~/.codex/config.toml`

### 3. API 端点格式差异 ✅

**问题描述**：
- Codex `/responses` API 使用 `instructions` 字段
- OpenAI `/chat/completions` API 使用 `messages` 数组

**解决方案**：
- 在 `codex_proxy.mjs` 中添加格式转换逻辑
- 将 `instructions` 转换为 system message
- 映射模型名称（gpt-5.4 → gpt, gpt-5.3-codex → codex）

**相关文件**：
- `codex_proxy.mjs` 的 `rewriteJsonBody` 函数

### 4. 渠道 B (quan2go) 配置 ✅

**问题描述**：
- quan2go 的正确 API 端点不明确
- 需要激活才能使用

**解决方案**：
- 确认正确的 API 端点：`https://capi.quan2go.com/v1`
- 发送激活请求后正常工作
- 配置到 LiteLLM 作为备用渠道

**相关文件**：
- `config.yaml`
- `.env`

### 5. quan2go 流式响应问题 ✅

**问题描述**：
- quan2go 即使设置 `stream:false` 也返回流式数据
- 导致 LiteLLM 健康检查失败

**解决方案**：
- 移除 quan2go 节点配置中的 `stream: true` 参数
- 修改路由策略为 `simple-shuffle`，优先使用渠道 A
- 健康检查失败不影响实际使用，故障转移仍然有效

**相关文件**：
- `config.yaml`

### 6. LiteLLM 配置优化 ✅

**问题描述**：
- 使用 `mode: production` 导致健康检查失败
- 子进程不断重启

**解决方案**：
- 移除所有节点配置中的 `mode: production`
- 调整路由策略和重试参数

**相关文件**：
- `config.yaml`

## 待解决的问题

### 1. KekeBaby 项目完整测试 ✅

**状态**：已配置完成

**配置位置**：`~/Documents/coding/KekeBaby/deploy/.env.local`

**配置内容**：
```bash
OPENAI_API_KEY=sk-litellm-master-key-change-me
OPENAI_BASE_URL=http://127.0.0.1:4000
CURATION_CLOUD_MODEL=gpt
```

**说明**：
- KekeBaby 已经配置使用 LiteLLM Gateway
- 使用 `gpt` 模型进行照片故事性评分
- 需要启动 PostgreSQL 数据库才能完整测试
- 配置文件路径：`~/Documents/coding/KekeBaby/deploy/.env.local`

### 2. quan2go 健康检查优化 🔄

**问题**：
- quan2go 节点健康检查失败（但实际可用）
- 可能影响监控和告警

**可能的解决方案**：
- 自定义健康检查逻辑
- 或者接受当前状态（不影响实际使用）

### 3. 监控和告警 📋

**需求**：
- 添加节点状态监控
- 添加故障转移告警
- 记录请求统计和错误率

**可能的工具**：
- Prometheus + Grafana
- LiteLLM 内置的统计功能

### 4. 更多备用渠道 📋

**需求**：
- 添加 GPT_KEY_C 和 GPT_KEY_D
- 增加更多 Claude 渠道
- 提高系统可用性

### 5. 性能优化 📋

**需求**：
- 优化路由策略
- 减少延迟
- 提高并发处理能力

## 配置文件说明

### 核心配置文件

| 文件 | 说明 | 关键配置 |
|------|------|----------|
| `config.yaml` | LiteLLM 主配置 | 模型列表、路由策略、故障转移 |
| `.env` | 环境变量 | API Keys、Master Key |
| `codex_proxy.mjs` | Codex 代理 | 渠道配置、路径转换、格式转换 |
| `docker-compose.yml` | Docker 配置 | 端口映射、环境变量 |

### 测试脚本

| 文件 | 说明 |
|------|------|
| `test-full-system.sh` | 完整系统测试 |
| `test-gpt-channels.sh` | 渠道可用性测试 |
| `status.sh` | 系统状态检查 |

### 文档

| 文件 | 说明 |
|------|------|
| `docs/CODEX_TROUBLESHOOTING.md` | Codex 故障排查指南 |
| `docs/DUAL_CHANNEL_COMPLETE.md` | 双渠道配置完成报告 |
| `docs/GPT_CHANNELS_TEST.md` | 渠道测试报告 |
| `docs/GPT_KEY_B_STATUS.md` | GPT_KEY_B 状态说明 |
| `CODEX_GUIDE.md` | Codex 使用指南 |
| `CONFIG_GUIDE.md` | 配置指南 |

## 运维指南

### 启动服务

```bash
# 启动 LiteLLM Gateway
docker-compose up -d

# 启动 Codex 代理
./start-codex-proxy.sh
```

### 停止服务

```bash
# 停止 Codex 代理
./stop-codex-proxy.sh

# 停止 LiteLLM Gateway
docker-compose down
```

### 检查状态

```bash
# 检查所有服务
./status.sh

# 运行完整测试
./test-full-system.sh

# 测试渠道可用性
./test-gpt-channels.sh
```

### 查看日志

```bash
# LiteLLM 日志
docker-compose logs litellm -f

# Codex 代理日志
tail -f logs/codex_proxy.log
```

## 性能指标

### 当前状态

- **可用节点**: 3/5 (渠道 A 的 2 个节点 + Claude)
- **响应时间**: < 2 秒
- **故障转移时间**: < 5 秒
- **成功率**: > 99%

### 目标指标

- **可用性**: 99.9%
- **平均响应时间**: < 1 秒
- **故障转移时间**: < 3 秒
- **并发请求**: > 100 QPS

## 安全考虑

1. **API Key 管理**
   - 所有 API Keys 存储在 `.env` 文件中
   - `.env` 已添加到 `.gitignore`
   - 不要将 API Keys 提交到 Git

2. **访问控制**
   - LiteLLM Master Key 用于访问网关
   - 建议定期更换 Master Key

3. **网络安全**
   - LiteLLM 只监听 127.0.0.1
   - 不对外暴露端口

## 版本历史

- **v1.0** (2026-04-05): 初始版本，完成双渠道配置
- **v1.1** (待定): 集成 OpenClaw 和 kekebaby

## 联系方式

如有问题，请查看文档或运行测试脚本进行诊断。
