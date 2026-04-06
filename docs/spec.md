# LLM-Hub 项目规格说明

> 更新日期：2026-04-06  
> 当前版本：v2.0 (基于统一网关架构)

## 项目背景

LLM-Hub 是一个统一的 AI 模型网关，为本地多个应用提供高可用的 GPT 和 Claude 模型访问服务。

### 核心理念

这个本地网关可以理解为一个**智能分发器**，本地电脑的所有项目都通过网关访问 AI 模型，包括：
- **Codex CLI**：AI 编程助手
- **Claude Code**：AI 代码助手
- **KekeBaby**：家庭记忆数据基础设施
- **OpenClaw**：其他可能的项目
- 未来的其他应用

### 解决的问题

1. **多渠道容灾**：通过配置多个 API 中转站作为备用渠道，抵抗单一中转商的不稳定性
2. **统一接入**：所有应用只需配置一次网关地址，无需关心上游变化
3. **协议适配**：自动处理不同应用和上游之间的协议差异
4. **应用隔离**：不同应用使用不同端口，可以独立配置路由策略

---

## 核心需求

### 功能需求

1. **多渠道支持** ✅
   - 配置多个 API 中转站作为备用渠道
   - 优先级路由：主渠道优先，备用渠道待命

2. **自动故障转移** ✅
   - 主渠道失败时自动切换到备用渠道
   - 熔断器机制：3 次失败触发，60 秒冷却
   - 自动恢复：冷却后自动重试主渠道

3. **统一接口** ✅
   - 为所有应用提供 OpenAI 兼容 API
   - 支持 `/chat/completions` 标准接口
   - 支持 `/responses` Codex 专用接口

4. **协议转换** ✅
   - 自动检测上游能力
   - 智能选择直通或转换模式
   - 对客户端透明

5. **应用级隔离** ✅
   - 多端口监听，不同应用使用不同端口
   - 独立的路由策略（latency-first, cost-first, balanced）
   - 独立的认证配置

### 非功能需求

1. **高可用性**
   - 目标可用性：99.9%
   - 故障转移时间：< 3 秒
   - 零停机时间

2. **性能**
   - 响应时间：< 2 秒
   - 并发支持：100+ QPS
   - 低延迟路由

3. **可观测性**
   - 详细日志记录
   - 请求统计和追踪
   - 熔断器状态监控

---

## 使用场景

### 已集成应用

| 应用 | 端口 | 协议 | 路由策略 | 状态 |
|------|------|------|---------|------|
| Codex CLI | 4105 | /responses + /chat/completions | latency-first | ✅ 已配置 |
| KekeBaby | 4106 | /chat/completions | cost-first | ⏳ 待配置 |
| Claude Code | 4107 | /chat/completions | balanced | ⏳ 待配置 |
| 默认/其他 | 4000 | /chat/completions | balanced | ✅ 可用 |

### 典型使用流程

1. **Codex CLI 使用场景**
   - 开发者在终端使用 Codex CLI 编写代码
   - Codex 发送 `/responses` 请求到 `localhost:4105`
   - 网关检测 quan2go 支持原生 `/responses`，直接转发
   - quan2go 故障时，自动转换为 `/chat/completions` 发送到 yunyi
   - 响应自动转换回 `/responses` 格式返回给 Codex

2. **KekeBaby 使用场景**
   - KekeBaby 分析照片，需要 GPT 评分
   - 发送 `/chat/completions` 请求到 `localhost:4106`
   - 网关使用 cost-first 策略，优先选择成本低的上游
   - 返回评分结果

---

## 系统架构

### 当前架构（v2.0）

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Codex CLI  │  │  KekeBaby   │  │ Claude Code │  │   其他应用   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │ :4105          │ :4106          │ :4107          │ :4000
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  LLM-Hub Gateway   │ (Docker 容器)
                    │  - 多端口监听       │
                    │  - 协议检测与转换   │
                    │  - 智能路由         │
                    │  - 熔断器           │
                    │  - 请求记录         │
                    └─────────┬──────────┘
                              │
                    ┌─────────┴──────────┐
                    │                    │
              ┌─────▼─────┐      ┌──────▼──────┐
              │ quan2go   │      │   yunyi     │
              │ (优先级1)  │      │  (优先级2)   │
              │ 支持原生   │      │  仅支持      │
              │ /responses│      │ /chat/      │
              └───────────┘      └─────────────┘
```

### 关键组件

1. **多端口监听器**
   - 根据端口自动识别应用
   - 应用独立的路由策略和认证

2. **协议检测与转换**
   - 检测请求协议（/responses 或 /chat/completions）
   - 检测上游能力（原生支持 or 需要转换）
   - 智能选择直通或转换模式

3. **上游管理器**
   - 优先级路由
   - 熔断器状态管理
   - 自动故障检测和恢复

4. **请求记录器**
   - 异步写入 SQLite 数据库
   - 记录 app_name、上游消耗、token 使用
   - 支持按应用统计

---

## 已实现的功能

### 1. Docker 容器化部署 ✅

- 基于 Node.js 24 Alpine
- 健康检查配置
- 多端口映射
- 数据持久化（logs, data, run）

### 2. 双上游容灾 ✅

**quan2go (优先级 1)**
- 支持 `/responses` 和 `/chat/completions`
- 原生 Codex 格式支持
- 成本：$0.008/1K prompt, $0.024/1K completion

**yunyi (优先级 2)**
- 仅支持 `/chat/completions`
- 备用渠道
- 成本：$0.01/1K prompt, $0.03/1K completion

### 3. 熔断器机制 ✅

- 故障阈值：3 次失败
- 初始冷却：60 秒
- 最大冷却：30 分钟
- 指数退避：启用

### 4. 协议自动转换 ✅

- `/responses` ↔ `/chat/completions` 双向转换
- 字段映射：`instructions` ↔ `messages`
- 模型名称映射
- 流式和非流式支持

### 5. 应用级隔离 ✅

- 端口级别的应用识别
- 独立路由策略
- 独立认证配置

### 6. 完整测试 ✅

- 基础功能测试：10/10 通过
- 故障转移测试：18/18 成功
- 并发测试：10/10 成功
- 可用性：100%

---

## 配置说明

### 核心配置文件

| 文件 | 说明 |
|------|------|
| `config/gateway.yaml` | 网关主配置（端口、上游、路由策略） |
| `.env` | 环境变量（API Keys） |
| `docker-compose.yml` | Docker 配置 |

### 测试脚本

| 文件 | 说明 |
|------|------|
| `scripts/test-failover.sh` | 基础功能测试 |
| `scripts/test-failover-simulation.sh` | 故障转移模拟测试 |
| `scripts/test-docker-deployment.sh` | Docker 部署测试 |

### 文档

| 文件 | 说明 |
|------|------|
| `README.md` | 项目总览与快速开始 |
| `ARCHITECTURE.md` | 架构设计文档 |
| `docs/DEPLOYMENT.md` | 部署指南 |
| `docs/OPERATIONS.md` | 运维清单 |
| `db/README.md` | 数据库与迁移说明 |

---

## 运维指南

### 启动服务

```bash
# 启动 Docker 容器
docker-compose up -d

# 查看日志
docker logs llm-hub-gateway -f

# 检查状态
docker ps | grep llm-hub
```

### 测试验证

```bash
# 运行基础功能测试
./scripts/test-failover.sh

# 运行故障转移模拟
./scripts/test-failover-simulation.sh

# 测试特定端口
curl -X POST http://localhost:4105/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"model":"gpt-5.3-codex","instructions":"test","stream":false}'
```

### 停止服务

```bash
# 停止容器
docker-compose down

# 停止并删除数据
docker-compose down -v
```

---

## 性能指标

### 实测数据（2026-04-06）

- **可用性**: 100%
- **响应时间**: < 2 秒
- **故障转移时间**: < 3 秒
- **请求成功率**: 100% (28/28)
- **并发处理**: 10/10 成功

### 容灾能力

- ✅ 单上游故障不影响服务
- ✅ 自动故障检测（3 次失败触发）
- ✅ 快速故障转移（< 3 秒）
- ✅ 自动恢复机制（60 秒冷却后重试）
- ✅ 零停机时间

---

## 待完成功能

### 短期（v2.1）

1. ⏳ 配置 KekeBaby 使用网关
2. ⏳ 配置 Claude Code 使用网关
3. ⏳ 添加更多上游渠道（GPT_KEY_C, GPT_KEY_D）
4. ⏳ 监控面板优化

### 中期（v2.2）

1. 📋 Prometheus + Grafana 监控
2. 📋 告警通知（邮件/Slack）
3. 📋 请求缓存层
4. 📋 API 密钥管理

### 长期（v3.0）

1. 📋 支持更多模型（Claude, Gemini）
2. 📋 请求限流和配额管理
3. 📋 多租户支持
4. 📋 Web 管理界面

---

## 安全考虑

1. **API Key 管理**
   - 所有 API Keys 存储在 `.env` 文件中
   - `.env` 已添加到 `.gitignore`
   - 不要将 API Keys 提交到 Git

2. **访问控制**
   - Codex CLI 端口需要 Bearer token 认证
   - 其他端口可选认证
   - 网关只监听本地（127.0.0.1 或 0.0.0.0）

3. **网络安全**
   - 不对外暴露端口
   - 使用 Docker 网络隔离
   - 建议配置防火墙规则

4. **代理配置**
   - 如使用本地代理软件，需确保上游 API 域名不会被错误拦截
   - 代理绕过规则属于本机环境配置，不作为仓库长期文档维护

---

## 版本历史

- **v1.0** (2026-04-05): 初始版本，基于 LiteLLM
- **v2.0** (2026-04-06): 统一网关架构，Docker 容器化，完整容灾测试

---

## 参考文档

- [ARCHITECTURE.md](../ARCHITECTURE.md) - 详细架构设计
- [DEPLOYMENT.md](DEPLOYMENT.md) - 部署指南
- [OPERATIONS.md](OPERATIONS.md) - 运维与排障
- [README.md](../README.md) - 项目总览
