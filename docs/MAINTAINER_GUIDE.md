# Maintainer Guide

This guide describes how LLM-Failsafe maintainers evaluate changes, compatibility reports, and releases. It is meant to keep the project predictable as more providers, clients, and deployment patterns are added.

## Maintenance Priorities

1. Preserve a stable local OpenAI-compatible contract for clients.
2. Keep provider-specific behavior explicit in configuration or compatibility notes.
3. Add regression tests for protocol conversion, routing, failover, persistence, and dashboard changes.
4. Protect local secrets and runtime state.
5. Keep operational behavior observable through logs, database records, and the dashboard.

## Reviewing Pull Requests

Use this checklist when reviewing changes:

- Does the change have a clear user-facing or maintainer-facing reason?
- Does it keep provider-specific behavior out of hard-coded generic paths?
- Does it update tests for protocol, routing, failover, storage, or dashboard behavior when relevant?
- Does it preserve local-first deployment and avoid hidden external services?
- Does it avoid committing secrets, logs, databases, generated runtime files, or private provider details?
- Does it update documentation when public behavior, configuration, or deployment changes?

## Handling Compatibility Reports

Compatibility reports should be triaged as data points about provider behavior, not as one-off bugs. A useful report includes:

- provider endpoint shape
- protocol used by the client
- whether streaming was enabled
- model name and local alias
- sanitized request payload
- sanitized response or error
- whether usage metadata was present
- expected behavior and actual behavior

### Triage Flow

1. Reproduce the behavior with a redacted local configuration.
2. Identify whether the mismatch is protocol support, model aliasing, streaming format, usage metadata, or error handling.
3. Add or update a unit/integration test that captures the behavior.
4. Prefer configuration and capability declarations over provider-specific branches.
5. Update `docs/COMPATIBILITY_MATRIX.md` when the behavior is generally useful to document.

## Adding Provider Capability Examples

When adding provider examples, keep them safe and provider-neutral:

- Use placeholder origins and environment variable names unless documenting a public local server.
- Never include real API keys or bearer tokens.
- Declare supported protocols explicitly.
- Include cost metadata only as an example unless values are maintained elsewhere.
- Add model aliases that demonstrate the pattern without implying official support.

## Dashboard and Usage Accounting Changes

Changes to dashboard or accounting should consider:

- request and response token sources
- fallback token estimation when upstream usage is missing
- route mode visibility
- per-app aggregation
- cost calculation consistency
- filtering behavior for app, upstream, status, and route mode
- redaction of error details

## Release Process

Before tagging a release:

1. Run `npm test`.
2. Build the Docker image with `docker compose build`.
3. Run a local gateway smoke test.
4. Review `docs/RELEASE_CHECKLIST.md`.
5. Update README, changelog, and compatibility notes if behavior changed.
6. Verify that no local secrets, logs, databases, or runtime state are included.

## Good First Contributions

Good first contributions usually include:

- provider-neutral configuration examples
- documentation improvements
- dashboard copy or accessibility improvements
- compatibility matrix updates
- small regression tests for protocol helpers
- safer error messages or redaction improvements

## High-Impact Contributions

High-impact contributions include:

- new protocol conversion test cases
- streaming SSE edge-case handling
- compatibility reports with sanitized request/response samples
- dashboard improvements for latency, failure rate, token usage, and cost trends
- persistence and migration improvements
- release and deployment automation that remains local-first
