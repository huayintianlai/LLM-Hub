# Changelog

## Rename to LLM-Failsafe

- Renamed project from LLM-Hub to LLM-Failsafe to better reflect core value: failover, fast routing, and multi-model blending.
- Rewrote README (English and Chinese) to highlight the three-pillar value proposition.

## 0.1.0 - Initial OSS Release

- Added a local OpenAI-compatible gateway for `/responses` and `/chat/completions`.
- Added multi-port app routing for Codex CLI and generic clients.
- Added passthrough and transform routing modes.
- Added upstream failover, circuit breaker state, cooldowns, and dynamic routing.
- Added request logging, token/cost accounting, dashboard APIs, and a web dashboard.
- Added SQLite and PostgreSQL storage support.
- Added Docker Compose, macOS launchd, lifecycle scripts, and test suites.
