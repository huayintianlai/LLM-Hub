# Deployment Guide

## Prerequisites
- Node.js 24+ (tested with `node --version`)
- `npm ci` (will install dependencies defined in `package.json`)
- Access to the `docs/.env` file for API keys and secrets
- Ports `4000`, `4105`, `4106`, `4107`, and `8080` available on the host

## Environment
1. Copy `docs/.env.example` to `docs/.env` and fill in the required API keys.
2. Confirm `config/gateway.yaml` points at the correct upstream origins (usually `quan2go` and `yunyi`).

## Local Deployment
1. Run `./scripts/start-gateway.sh` to launch the gateway. Logs stream to `logs/gateway.log`.
2. Use `./scripts/health-check.sh` to verify `http://127.0.0.1:4000/health` responds.
3. Stop the gateway with `./scripts/stop-gateway.sh`.
4. Rotate logs on demand with `./scripts/rotate-logs.sh` or hook into cron.

## Containerized Deployment
1. Build the image: `docker build -t llm-hub-gateway .`
2. Start via Compose: `docker compose up -d`.
3. Compose mounts `config/` and `docs/.env` read-only and exposes the gateway ports (4000, 4105-4107, 8080).
4. Check logs with `docker compose logs -f gateway` and tear down with `docker compose down`.

## launchd (macOS)
1. Copy `launchd/com.llmhub.gateway.plist` to `~/Library/LaunchAgents/`.
2. Adjust the `ProgramArguments` path if the repository lives somewhere else.
3. Load with `launchctl load ~/Library/LaunchAgents/com.llmhub.gateway.plist`.
4. Unload with `launchctl unload ...` before updating the plist.

## Production Notes
- Keep `logs/` and `run/` directories writable by the service user.
- The gateway uses `config/gateway.yaml` for listener and upstream details: editing it requires a gateway restart.
- For zero-downtime upgrades, stop the service (`stop-gateway.sh`), pull new code, reinstall dependencies, then start again.
