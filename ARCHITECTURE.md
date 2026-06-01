# LLM-Failsafe Architecture

LLM-Failsafe is a local OpenAI-compatible gateway for AI coding tools and other local clients. It provides stable local listener ports, protocol-aware routing, upstream failover, request logging, and dashboard APIs.

## Design Intent

The gateway is an integration layer between fast-moving AI clients and uneven provider implementations. Its job is to keep local client configuration simple while making provider behavior explicit, testable, and observable. That is why provider capabilities live in configuration instead of being hard-coded throughout the client setup.

## Core Flow

```text
Codex CLI / local apps
        |
        v
Multi-port listeners
        |
        v
Protocol detection: /responses or /chat/completions
        |
        v
Route planning: passthrough when native support exists, transform when needed
        |
        v
OpenAI-compatible upstream providers
        |
        v
Response streaming, usage accounting, request persistence, dashboard summaries
```

## Listener Model

The gateway runs multiple local listeners so different clients can use different routing policies without changing request payloads.

| Port | Default app | Purpose |
| --- | --- | --- |
| `4105` | `codex-cli` | Responses API traffic for Codex CLI |
| `4106` | `app-a` | Example cost-first client route |
| `4107` | `app-b` | Example balanced client route |
| `4000` | `default` | Generic OpenAI-compatible endpoint |
| `8080` | dashboard | Web dashboard and dashboard APIs |

## Routing Modes

- **Passthrough**: used when the selected upstream natively supports the requested protocol. The gateway forwards the request and response stream without protocol conversion.
- **Transform**: used when the client sends Responses API traffic but the selected backup upstream only supports Chat Completions. The gateway converts the request and rebuilds a compatible response shape.
- **Dynamic failover**: failed upstream attempts update circuit breaker state and routing scores; healthy backups can be promoted when the primary route is unavailable or slow.

## Compatibility Surface

The most important maintenance surface is upstream compatibility. Providers can differ in:

- whether `/responses` exists
- whether streaming is required or optional
- how SSE events are shaped
- whether usage metadata is present
- how model aliases map to concrete model names
- how transient errors and rate limits are represented

LLM-Failsafe keeps those differences behind capability declarations so clients can keep using a stable local OpenAI-compatible endpoint.

## Upstream Capability Model

Each upstream declares:

- endpoint origin and full paths
- API key environment variable
- supported model names and local aliases
- Responses API support
- Chat Completions support
- streaming requirements and event format
- routing priority and cost metadata

These declarations let LLM-Failsafe plan safe routes before making network calls.

## Observability

LLM-Failsafe records request metadata asynchronously so request handling is not blocked by database writes. Stored data includes app name, port, protocol, route mode, upstream, latency, status, token usage, cost estimates, and error details.

The dashboard reads summary APIs for:

- request totals and success rate
- recent requests
- token and cost trends
- per-app usage
- upstream state and circuit breaker health

## Storage

SQLite is the default local storage engine. PostgreSQL support is available for deployments that need shared or longer-lived operational data.

## Security Boundary

LLM-Failsafe is designed for local deployment. Real API keys belong in `.env` or a secret manager, not in repository files. If listener ports are exposed beyond localhost, protect them with a firewall, reverse proxy authentication, or a trusted network boundary.
