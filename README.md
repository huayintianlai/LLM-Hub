# LLM-Hub Gateway

[English](#english) | [中文](#中文)

---

## English

LLM-Hub is a local unified gateway that routes `/responses` and `/chat/completions` traffic from Codex CLI and other OpenAI-compatible clients to multiple upstream providers with intelligent routing, circuit breaker state, and observability hooks.

### Key Features

#### 🚀 Multi-Application Support
- **Multi-port listeners** (4105/4106/4107/4000) identify applications without changing client configuration
- **Codex CLI** (port 4105): Native `/responses` API support with Bearer token authentication
- **KekeBaby** (port 4106): Photo story scoring with GPT models
- **Claude Code** (port 4107): AI coding assistant integration
- **Generic apps** (port 4000): Standard OpenAI-compatible endpoint

#### 🔄 Intelligent Routing & Failover
- **Automatic failover**: Switches to backup channels when primary fails
- **Circuit breaker**: Prevents cascading failures with cooldown periods
- **Protocol transformation**: Converts `/responses` to `/chat/completions` when needed
- **Load balancing**: Distributes requests across multiple upstream providers

#### 📊 Monitoring & Analytics
- **Web Dashboard** (port 8080): Real-time monitoring interface
  - Total requests and success rate
  - Average latency and cost tracking
  - Recent request history
  - Upstream health status
- **Usage statistics**: Token consumption and cost analysis
- **Request logging**: SQLite/PostgreSQL database recording
- **Health checks**: Automated endpoint validation

#### 🛠️ Production Ready
- **Docker support**: Pre-configured `Dockerfile` and `docker-compose.yml`
- **Lifecycle scripts**: Automated start, stop, health check, and log rotation
- **macOS launchd**: System service integration for automatic startup
- **Environment isolation**: Secure API key management via `.env` files

### Getting Started

#### Quick Start
1. Copy `docs/.env.example` → `docs/.env` and provide API credentials
2. Review `config/gateway.yaml` for listeners and upstream definitions
3. Run `./scripts/start-gateway.sh` to start the gateway
4. Open `http://localhost:8080` to access the web dashboard
5. Monitor logs with `tail -f logs/gateway.log`
6. Verify with `./scripts/health-check.sh`

#### Docker Deployment
```bash
# Build and start
docker-compose up -d

# View logs
docker logs llm-hub-gateway -f

# Access dashboard
open http://localhost:8080
```

#### Testing
```bash
# Run full test suite
./scripts/acceptance-suite.sh

# Test specific endpoints
./scripts/test-phase1.sh
./scripts/test-gpt-channels.sh
```

### Web Dashboard

Access the monitoring dashboard at `http://localhost:8080` to view:
- **Summary metrics**: Total requests, success rate, average latency, total cost
- **Recent requests**: Last 5 requests with app name, status, tokens, and latency
- **Upstream status**: Circuit breaker state, cooldown status, failure count
- **Gateway config**: Current configuration in JSON format

The dashboard auto-refreshes every 15 seconds and provides a real-time view of your gateway's health and performance.

### Supported Models
- `gpt-5.4` / `gpt` → GPT-5.4
- `gpt-5.3-codex` / `codex` → GPT-5.3 Codex
- Custom model mappings via `config/gateway.yaml`

### Architecture
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Codex CLI  │  │  KekeBaby   │  │ Claude Code │
│  (port 4105)│  │  (port 4106)│  │  (port 4107)│
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
                ┌───────▼────────┐
                │  LLM-Hub       │  ← Web Dashboard (8080)
                │  Gateway       │  ← Health API
                │  (port 4000)   │  ← Metrics & Logs
                └───────┬────────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
      ┌─────────┐ ┌─────────┐ ┌─────────┐
      │Upstream │ │Upstream │ │Upstream │
      │   A     │ │   B     │ │   C     │
      └─────────┘ └─────────┘ └─────────┘
```

### Documentation
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - Deployment instructions
- [docs/OPERATIONS.md](docs/OPERATIONS.md) - Operations and troubleshooting
- [docs/spec.md](docs/spec.md) - Technical specifications
- [ARCHITECTURE.md](ARCHITECTURE.md) - Architecture overview

---

## 中文

LLM-Hub 是一个本地统一网关，可将来自 Codex CLI 和其他 OpenAI 兼容客户端的 `/responses` 和 `/chat/completions` 流量路由到多个上游提供商，具有智能路由、熔断器状态和可观测性钩子。

### 核心特性

#### 🚀 多应用支持
- **多端口监听器**（4105/4106/4107/4000）无需更改客户端配置即可识别应用程序
- **Codex CLI**（端口 4105）：原生 `/responses` API 支持，带 Bearer token 认证
- **KekeBaby**（端口 4106）：使用 GPT 模型进行照片故事评分
- **Claude Code**（端口 4107）：AI 编程助手集成
- **通用应用**（端口 4000）：标准 OpenAI 兼容端点

#### 🔄 智能路由与故障转移
- **自动故障转移**：主渠道失败时自动切换到备用渠道
- **熔断器机制**：通过冷却期防止级联故障
- **协议转换**：需要时将 `/responses` 转换为 `/chat/completions`
- **负载均衡**：在多个上游提供商之间分配请求

#### 📊 监控与分析
- **Web 仪表板**（端口 8080）：实时监控界面
  - 总请求数和成功率
  - 平均延迟和成本跟踪
  - 最近请求历史
  - 上游健康状态
- **用量统计**：Token 消耗和成本分析
- **请求日志**：SQLite/PostgreSQL 数据库记录
- **健康检查**：自动化端点验证

#### 🛠️ 生产就绪
- **Docker 支持**：预配置的 `Dockerfile` 和 `docker-compose.yml`
- **生命周期脚本**：自动化启动、停止、健康检查和日志轮转
- **macOS launchd**：系统服务集成，支持自动启动
- **环境隔离**：通过 `.env` 文件安全管理 API 密钥

### 快速开始

#### 快速启动
1. 复制 `docs/.env.example` → `docs/.env` 并提供 API 凭证
2. 查看 `config/gateway.yaml` 了解监听器和上游定义
3. 运行 `./scripts/start-gateway.sh` 启动网关
4. 打开 `http://localhost:8080` 访问 Web 仪表板
5. 使用 `tail -f logs/gateway.log` 监控日志
6. 使用 `./scripts/health-check.sh` 验证运行状态

#### Docker 部署
```bash
# 构建并启动
docker-compose up -d

# 查看日志
docker logs llm-hub-gateway -f

# 访问仪表板
open http://localhost:8080
```

#### 测试
```bash
# 运行完整测试套件
./scripts/acceptance-suite.sh

# 测试特定端点
./scripts/test-phase1.sh
./scripts/test-gpt-channels.sh
```

### Web 仪表板

访问 `http://localhost:8080` 监控仪表板，查看：
- **汇总指标**：总请求数、成功率、平均延迟、总成本
- **最近请求**：最近 5 个请求的应用名称、状态、Token 数和延迟
- **上游状态**：熔断器状态、冷却状态、失败计数
- **网关配置**：JSON 格式的当前配置

仪表板每 15 秒自动刷新，提供网关健康状况和性能的实时视图。

### 支持的模型
- `gpt-5.4` / `gpt` → GPT-5.4
- `gpt-5.3-codex` / `codex` → GPT-5.3 Codex
- 通过 `config/gateway.yaml` 自定义模型映射

### 架构图
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Codex CLI  │  │  KekeBaby   │  │ Claude Code │
│  (端口 4105)│  │  (端口 4106)│  │  (端口 4107)│
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        │
                ┌───────▼────────┐
                │  LLM-Hub       │  ← Web 仪表板 (8080)
                │  Gateway       │  ← 健康检查 API
                │  (端口 4000)   │  ← 指标与日志
                └───────┬────────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
      ┌─────────┐ ┌─────────┐ ┌─────────┐
      │上游服务 │ │上游服务 │ │上游服务 │
      │   A     │ │   B     │ │   C     │
      └─────────┘ └─────────┘ └─────────┘
```

### 文档
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) - 部署说明
- [docs/OPERATIONS.md](docs/OPERATIONS.md) - 日常操作和故障排除
- [docs/spec.md](docs/spec.md) - 技术规格
- [ARCHITECTURE.md](ARCHITECTURE.md) - 架构总览
