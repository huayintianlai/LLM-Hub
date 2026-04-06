# LLM-Hub Gateway

[English](#english) | [中文](#中文)

---

## English

LLM-Hub is a local unified gateway that routes `/responses` and `/chat/completions` traffic from Codex CLI and other OpenAI-compatible clients to multiple upstream providers with intelligent routing, circuit breaker state, and observability hooks.

### Key Highlights
- Multi-port listeners (4105/4106/4107/4000) identify applications without changing client configuration.
- The gateway can passthrough native `/responses` requests or transform them into `/chat/completions` when an upstream lacks `/responses`.
- Integrated logging, SQLite/PostgreSQL recording, and a small dashboard surface routing, usage, and upstream health.
- Pre-built scripts automate lifecycle actions plus container and launchd assets for production.

### Getting Started
1. Copy `docs/.env.example` → `docs/.env` and provide API credentials.
2. Review `config/gateway.yaml` for listeners and upstream definitions.
3. Run `./scripts/start-gateway.sh`, monitor `logs/gateway.log`, and verify with `./scripts/health-check.sh`.
4. Run `./scripts/acceptance-suite.sh` for the full automated validation pass.
5. Stop with `./scripts/stop-gateway.sh` and rotate logs via `./scripts/rotate-logs.sh`.

### Containers & Services
- `Dockerfile` packages the gateway for deployment; build with `docker build -t llm-hub-gateway .`.
- `docker-compose.yml` exposes ports 4000, 4105-4107, and 8080 while mounting config and env files.
- `launchd/com.llmhub.gateway.plist` demonstrates how to start the gateway via macOS bootstrap.

### Documentation
- See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for deployment instructions.
- See [docs/OPERATIONS.md](docs/OPERATIONS.md) for routine operations and troubleshooting.

---

## 中文

LLM-Hub 是一个本地统一网关，可将来自 Codex CLI 和其他 OpenAI 兼容客户端的 `/responses` 和 `/chat/completions` 流量路由到多个上游提供商，具有智能路由、熔断器状态和可观测性钩子。

### 核心特性
- 多端口监听器（4105/4106/4107/4000）无需更改客户端配置即可识别应用程序。
- 网关可以直通原生 `/responses` 请求，或在上游缺少 `/responses` 时将其转换为 `/chat/completions`。
- 集成日志记录、SQLite/PostgreSQL 记录和小型仪表板，展示路由、使用情况和上游健康状态。
- 预构建脚本自动化生命周期操作，以及用于生产环境的容器和 launchd 资源。

### 快速开始
1. 复制 `docs/.env.example` → `docs/.env` 并提供 API 凭证。
2. 查看 `config/gateway.yaml` 了解监听器和上游定义。
3. 运行 `./scripts/start-gateway.sh`，监控 `logs/gateway.log`，并使用 `./scripts/health-check.sh` 验证。
4. 运行 `./scripts/acceptance-suite.sh` 进行完整的自动化验证。
5. 使用 `./scripts/stop-gateway.sh` 停止，并通过 `./scripts/rotate-logs.sh` 轮转日志。

### 容器与服务
- `Dockerfile` 打包网关用于部署；使用 `docker build -t llm-hub-gateway .` 构建。
- `docker-compose.yml` 暴露端口 4000、4105-4107 和 8080，同时挂载配置和环境文件。
- `launchd/com.llmhub.gateway.plist` 演示如何通过 macOS bootstrap 启动网关。

### 文档
- 查看 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 了解部署说明。
- 查看 [docs/OPERATIONS.md](docs/OPERATIONS.md) 了解日常操作和故障排除。
