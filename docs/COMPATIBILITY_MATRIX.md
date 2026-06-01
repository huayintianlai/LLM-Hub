# Compatibility Matrix

This matrix documents the compatibility surface that LLM-Hub is designed to support. It is intentionally provider-neutral: entries describe protocol behavior and client integration patterns rather than endorsing a specific commercial provider.

## Client Compatibility

| Client | Protocol | Recommended Endpoint | Status | Notes |
|---|---|---|---|---|
| Codex CLI | `/responses` | `http://127.0.0.1:4105` | Supported | Dedicated listener with bearer-token auth and Responses API routing |
| Claude Code | `/chat/completions` | `http://127.0.0.1:4000/v1` | Compatible | Uses the generic OpenAI-compatible endpoint or a custom listener |
| OpenClaw Hermes agent | `/chat/completions` | `http://127.0.0.1:4106/v1` | Compatible | Can use a dedicated cost-first listener for agent workloads |
| Cursor | `/chat/completions` | `http://127.0.0.1:4000/v1` | Compatible | Configure as an OpenAI-compatible provider |
| Continue | `/chat/completions` | `http://127.0.0.1:4000/v1` | Compatible | Configure as an OpenAI-compatible provider |
| Aider | `/chat/completions` | `http://127.0.0.1:4000/v1` | Compatible | Use an OpenAI-compatible base URL |
| Custom local agent | `/responses` or `/chat/completions` | Custom listener port | Supported by configuration | Add a listener and choose a routing strategy |

## Protocol Support

| Incoming Request | Upstream Capability | Route Mode | Behavior |
|---|---|---|---|
| `/responses` | Supports Responses API | Passthrough | Forward the request to the upstream Responses endpoint |
| `/responses` | Chat Completions only | Transform | Convert request to Chat Completions and rebuild a Responses-compatible output |
| `/chat/completions` | Supports Chat Completions | Passthrough | Forward the request to the upstream Chat Completions endpoint |
| `/chat/completions` | Responses API only | Not supported | No safe generic conversion path is assumed |

## Provider Capability Shapes

| Provider Shape | Responses API | Chat Completions | Streaming | Usage Metadata | Expected LLM-Hub Behavior |
|---|---|---|---|---|---|
| Full OpenAI-compatible provider | Yes | Yes | Provider-specific | Usually present | Prefer passthrough, track usage, fallback on failures |
| Responses-native provider | Yes | Optional | Provider-specific | Varies | Use Responses passthrough for Codex CLI traffic |
| Chat-only provider | No | Yes | Provider-specific | Varies | Use Chat passthrough for chat clients and transform route for Responses failover |
| Claude-compatible through OpenAI API | No | Yes | Provider-specific | Varies | Treat as Chat Completions route with explicit model aliases |
| Local model server | Usually no | Often yes | Varies | Often missing | Estimate usage when upstream omits usage metadata |

## Routing Strategies

| Strategy | Goal | Typical Client |
|---|---|---|
| `latency-first` | Prefer faster healthy upstreams | Codex CLI, interactive coding assistants |
| `cost-first` | Prefer lower-cost healthy upstreams | Batch agents, background tasks |
| `balanced` | Balance priority, health, and routing metadata | Generic local clients |

## Observability Coverage

| Signal | Captured |
|---|---|
| App name and listener port | Yes |
| Request protocol | Yes |
| Route mode | Yes |
| Upstream ID | Yes |
| Model | Yes |
| Prompt, completion, and total tokens | Yes |
| Estimated cost | Yes |
| Latency | Yes |
| Success or failure | Yes |
| Error details | Redacted operational metadata |
| Circuit breaker state | Yes |

## Adding a New Client

1. Confirm whether the client uses `/responses`, `/chat/completions`, or both.
2. Add a listener in `config/gateway.yaml` if the client needs its own port or routing strategy.
3. Map local model aliases to upstream model names.
4. Run `npm test` and a manual request through the chosen endpoint.
5. Update this matrix if the client has a documented setup path.
