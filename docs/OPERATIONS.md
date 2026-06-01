# Operations Checklist

## Health Monitoring
- Run `./scripts/health-check.sh` (defaults to `http://127.0.0.1:4000/health`) to verify the gateway and listeners respond.
- Monitor `/api/status` for listener and upstream metadata: `curl http://127.0.0.1:4000/status`.
- Confirm dashboards (`http://127.0.0.1:8080`) reflect recent requests and upstream state.

## Log Management
- Gateway logs stream to `logs/gateway.log`. Rotate them nightly with `./scripts/rotate-logs.sh`.
- After rotation, restart the gateway to guarantee tailers re-open the file.
- Keep long-term archives outside the repo (e.g., `/var/log/llm-failsafe/`).

## Process Control
- Use `./scripts/start-gateway.sh` and `./scripts/stop-gateway.sh` for lifecycle management.
- Verify PID files live in `run/gateway.pid` and remove stale files before restarting.
- On macOS, leverage the launchd template to auto-start the gateway at boot.

## Troubleshooting
- If the gateway fails to start, inspect `logs/gateway.log` for stack traces or missing env vars.
- Check `.env` for expired API keys; rotate them and restart the service.
- Use `curl http://127.0.0.1:4000/status` to see which upstream is currently in cooldown.
- For container deployments, `docker compose logs gateway` and `docker compose exec gateway ./scripts/health-check.sh` provide quick diagnostics.

## Automation Ideas
- Wire `scripts/health-check.sh` into cron or an external monitor and alert when it fails.
- Hook `scripts/rotate-logs.sh` into `logrotate` or a scheduled job that also pushes logs to long-term storage.
- Build monitoring using the `/api/summary` response to feed Prometheus/Grafana.
