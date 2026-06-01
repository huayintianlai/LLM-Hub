# Ecosystem Position

LLM-Failsafe is a local compatibility and observability layer for AI coding tools that use OpenAI-compatible APIs. It is designed for developers who run more than one local agent or editor integration and need stable routing across providers with different protocol behavior.

## Problem Space

OpenAI-compatible clients and providers do not always agree on the same API surface. Differences often appear in:

- Responses API availability
- Chat Completions compatibility
- streaming and SSE event shape
- model names and aliases
- usage metadata presence
- transient error and rate-limit formats
- provider-specific failure modes

These differences are manageable for a single script, but they become hard to maintain when several local coding tools share the same credentials, budget, and failover requirements.

## LLM-Failsafe's Role

LLM-Failsafe keeps client configuration stable while making upstream behavior explicit and observable.

| Layer | Responsibility |
|---|---|
| Client-facing API | Expose stable local OpenAI-compatible endpoints for coding tools |
| Capability model | Declare provider protocol support, model aliases, cost metadata, and streaming behavior |
| Route planner | Select passthrough, transform, or failover paths based on protocol and health state |
| Reliability layer | Track passive health, circuit breaker state, cooldowns, and consecutive failures |
| Observability layer | Persist request metadata, token usage, cost estimates, latency, and upstream outcomes |

## Why It Is Not Just a Proxy

A simple proxy forwards traffic from one endpoint to another. LLM-Failsafe adds the operational surface needed by local AI tooling:

- protocol-aware routing for `/responses` and `/chat/completions`
- automatic Responses API to Chat Completions transformation when a backup route requires it
- per-client listener ports with independent routing strategies
- circuit breaker state for unreliable upstreams
- token and cost accounting across shared local tools
- dashboard summaries for app, provider, route mode, latency, and failure analysis
- provider-neutral configuration that keeps private credentials outside repository files

## Target Users

| User | Need |
|---|---|
| Codex CLI users | A local `/responses` endpoint with failover and usage tracking |
| AI coding tool users | One OpenAI-compatible base URL for editors, agents, and CLI tools |
| Maintainers testing providers | A repeatable way to document provider capability differences |
| Cost-conscious developers | Per-app token and cost visibility across local tools |
| Local-first teams | A small auditable gateway that can run without managed infrastructure |

## Project Principles

- Stay local-first and easy to audit.
- Keep provider-specific behavior in configuration and compatibility notes.
- Prefer regression tests for protocol conversion, routing, failover, persistence, and dashboard behavior.
- Treat upstream compatibility reports as first-class maintenance input.
- Avoid committing credentials, local databases, logs, or runtime state.
