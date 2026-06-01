# Roadmap

LLM-Hub is early but already useful for local AI tooling. The project is maintained around a clear ecosystem need: OpenAI-compatible clients and providers do not always agree on Responses API support, streaming semantics, model naming, usage metadata, or failure behavior. Near-term work focuses on making that compatibility layer easier to adopt, safer to configure, and easier to validate across providers.

## Maintenance Principles

- Keep the default configuration provider-neutral.
- Treat upstream compatibility reports as first-class project input.
- Prefer regression tests for protocol conversion, routing, failover, and persistence changes.
- Keep deployment paths local-first and easy to audit.
- Avoid committing provider credentials, local runtime state, or private operational data.

## Near Term

- Add more documented upstream capability examples for common OpenAI-compatible providers.
- Add a SQLite to PostgreSQL migration utility.
- Expand Codex CLI compatibility tests for Responses API streaming edge cases.
- Improve dashboard views for per-model latency, failure rate, token usage, and cost trends.
- Add redaction helpers for sharing provider compatibility reports safely.
- Add a compatibility matrix for provider capabilities and known edge cases.

## Later

- Add configuration validation with actionable startup errors.
- Add optional Prometheus metrics export.
- Add packaged release artifacts for common local deployment patterns.
- Add more examples for running LLM-Hub behind a local reverse proxy.
