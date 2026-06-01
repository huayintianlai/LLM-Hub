# Deployment Guide

## Prerequisites

- Node.js 24+
- `npm ci`
- OpenAI-compatible upstream API keys
- Ports `4000`, `4105`, `4106`, `4107`, and `8080` available on the host

## Environment

1. Copy `.env.example` to `.env`.
2. Set `UPSTREAM_PRIMARY_API_KEY`, `UPSTREAM_BACKUP_API_KEY`, and optional notification values.
3. Edit `config/gateway.yaml` so each upstream `origin`, endpoint path, model list, and capability declaration matches your providers.
4. Keep `.env`, logs, databases, and run state out of git.

## Local Deployment

1. Run `npm ci`.
2. Run `./scripts/start-gateway.sh` to launch the gateway.
3. Use `./scripts/health-check.sh` to verify `http://127.0.0.1:4000/health`.
4. Open `http://localhost:8080` for the dashboard.
5. Stop the gateway with `./scripts/stop-gateway.sh`.

## Containerized Deployment

1. Copy `.env.example` to `.env` and fill in local values.
2. Build and start:

```bash
docker compose up -d --build
```

3. Check logs:

```bash
docker compose logs -f gateway
```

4. Tear down:

```bash
docker compose down
```

The Docker build context excludes local `.env`, databases, logs, and run state. Runtime configuration is injected through Compose `env_file` and mounted volumes.

## Codex CLI

Point Codex CLI at the dedicated Responses API listener:

```toml
[model_providers.llmfailsafe]
name = "llmfailsafe"
base_url = "http://127.0.0.1:4105"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local-test-token"
```

Use a real local bearer token for shared machines or long-running deployments.

## launchd (macOS)

1. Copy `launchd/com.llmfailsafe.gateway.plist` to `~/Library/LaunchAgents/`.
2. Adjust paths in the plist for your repository location.
3. Load with `launchctl load ~/Library/LaunchAgents/com.llmfailsafe.gateway.plist`.
4. Unload before edits with `launchctl unload ~/Library/LaunchAgents/com.llmfailsafe.gateway.plist`.

## Production Notes

- Keep upstream secrets only in `.env` or your secret manager.
- Confirm every provider capability in `config/gateway.yaml`; incorrect streaming declarations can break passthrough behavior.
- Rotate logs outside the repo, for example into `/var/log/llm-failsafe/`.
- Run `npm test` before upgrading a deployed gateway.
