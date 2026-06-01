# Contributing to LLM-Failsafe

Thanks for helping improve LLM-Failsafe. The project aims to stay local-first, provider-neutral, and safe to run with private upstream credentials.

The most valuable contributions are compatibility reports, regression tests, provider-neutral configuration examples, dashboard/observability improvements, and fixes that make local deployments safer.

## Local Setup

```bash
cp .env.example .env
npm ci
npm test
```

Edit `.env` for local secrets and `config/gateway.yaml` for provider-specific upstreams. Do not commit real API keys, bearer tokens, databases, logs, or runtime state.

## Development Workflow

1. Open an issue for larger behavior changes or upstream compatibility reports.
2. Keep changes focused and provider-neutral when possible.
3. Add or update tests for routing, protocol conversion, failover, persistence, or dashboard behavior.
4. Run `npm test` before opening a pull request.

## Pull Request Checklist

- The change has a clear user-facing reason.
- Tests pass with `npm test`.
- Documentation is updated when configuration, deployment, or public behavior changes.
- No secrets, local databases, logs, or generated runtime files are included.
- Provider-specific examples use placeholders unless they are intentionally documented compatibility notes.

## Reporting Upstream Compatibility

Please include:

- provider endpoint shape
- supported protocol: `/responses`, `/chat/completions`, or both
- streaming behavior
- model aliases involved
- expected behavior and actual response/error
- a redacted request/response sample if available

Compatibility reports are especially useful because they help LLM-Failsafe document the practical differences between OpenAI-compatible providers without hard-coding one provider's behavior as the default.
