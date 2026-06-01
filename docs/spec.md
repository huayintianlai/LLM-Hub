# LLM-Failsafe Technical Spec

LLM-Failsafe is a local OpenAI-compatible gateway that routes AI client traffic to one or more upstream providers while preserving client-facing compatibility.

## Goals

- Provide one stable local endpoint for Codex CLI and other OpenAI-compatible clients.
- Support both `/responses` and `/chat/completions`.
- Prefer passthrough routing when an upstream supports the client protocol natively.
- Use transform routing when a compatible backup requires protocol conversion.
- Track request health, token usage, cost estimates, latency, and upstream failover state.

## Public Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Basic gateway health check |
| `GET /status` | Runtime listener and upstream metadata |
| `POST /responses` | Responses API-compatible entrypoint |
| `POST /v1/responses` | Responses API-compatible entrypoint |
| `POST /chat/completions` | Chat Completions-compatible entrypoint |
| `POST /v1/chat/completions` | Chat Completions-compatible entrypoint |

Dashboard APIs are exposed by the dashboard listener and serve summary, request, trend, app, and upstream state data for the web UI.

## Configuration

The gateway reads `config/gateway.yaml`. Important sections:

- `gateway`: host, timeout, and listener ports
- `upstreams`: provider origins, paths, API key environment variables, model aliases, capabilities, priority, timeout, and cost metadata
- `failover`: routing mode, circuit breaker thresholds, cooldowns, and app-specific routing strategy
- `database`: SQLite or PostgreSQL storage configuration
- `monitoring`: dashboard and optional notification settings

The default configuration uses placeholder providers. Replace origins, paths, model names, and API key environment variables with providers you are authorized to use.

## Routing

1. Detect the client protocol from the request path.
2. Resolve the requested model through upstream-supported models and aliases.
3. Filter upstreams by capability and circuit breaker state.
4. Build a route plan using the listener's routing strategy.
5. Try each route until a request succeeds or all compatible routes fail.
6. Record request outcome, usage, cost, latency, and failure metadata.

## Failover

The circuit breaker opens after repeated upstream failures, waits through a cooldown, then allows recovery probes. Dynamic routing can promote lower-latency or healthier routes when configured.

## Token and Cost Accounting

When upstream responses include usage metadata, LLM-Failsafe records it directly. When usage is missing or incomplete, the gateway estimates token counts with the local token counter and calculates cost from upstream cost metadata.

## Deployment

Supported deployment paths:

- local Node.js scripts
- Docker Compose
- macOS launchd

See [DEPLOYMENT.md](DEPLOYMENT.md) and [OPERATIONS.md](OPERATIONS.md).
