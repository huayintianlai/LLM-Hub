# Release Checklist

Use this checklist before tagging a public release.

## Preflight

- `npm test` passes.
- Docker image builds with `docker compose build`.
- Secret scan finds no real API keys, bearer tokens, local databases, logs, or runtime state.
- README, deployment docs, and changelog match the release.
- GitHub issue templates and PR template are present.
- Roadmap and architecture notes still describe the current maintenance direction.

## GitHub Release

- Create a version tag, for example `v0.1.0`.
- Write release notes with: highlights, compatibility improvements, upgrade notes, test status, and known limitations.
- Attach dashboard screenshots or a short demo when available.
- Confirm repository description and topics are set.

Recommended topics:

`llm-gateway`, `openai-compatible`, `codex-cli`, `responses-api`, `failover`, `observability`, `nodejs`, `docker`

## After Release

- Share the release link and README where relevant.
- Include one concrete use case and one screenshot when announcing the release.
