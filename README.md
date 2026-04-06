# LLM-Hub Gateway

LLM-Hub is a local unified gateway that routes `/responses` and `/chat/completions` traffic from Codex CLI and other OpenAI-compatible clients to multiple upstream providers with intelligent routing, circuit breaker state, and observability hooks.

## Key Highlights
- Multi-port listeners (4105/4106/4107/4000) identify applications without changing client configuration.
- The gateway can passthrough native `/responses` requests or transform them into `/chat/completions` when an upstream lacks `/responses`.
- Integrated logging, SQLite/PostgreSQL recording, and a small dashboard surface routing, usage, and upstream health.
- Pre-built scripts automate lifecycle actions plus container and launchd assets for production.

## Getting Started
1. Copy `docs/.env.example` → `docs/.env` and provide API credentials.
2. Review `config/gateway.yaml` for listeners and upstream definitions.
3. Run `./scripts/start-gateway.sh`, monitor `logs/gateway.log`, and verify with `./scripts/health-check.sh`.
4. Run `./scripts/acceptance-suite.sh` for the full automated validation pass.
5. Stop with `./scripts/stop-gateway.sh` and rotate logs via `./scripts/rotate-logs.sh`.

## Containers & Services
- `Dockerfile` packages the gateway for deployment; build with `docker build -t llm-hub-gateway .`.
- `docker-compose.yml` exposes ports 4000, 4105-4107, and 8080 while mounting config and env files.
- `launchd/com.llmhub.gateway.plist` demonstrates how to start the gateway via macOS bootstrap.

## Documentation
- See [docs/DEPLOYMENT.md](/Users/KenSir/Documents/coding/AIWorkSpace/LLM-Hub/docs/DEPLOYMENT.md) for deployment instructions.
- See [docs/OPERATIONS.md](/Users/KenSir/Documents/coding/AIWorkSpace/LLM-Hub/docs/OPERATIONS.md) for routine operations and troubleshooting.
