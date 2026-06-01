# Security Policy

## Supported Versions

The `main` branch and the latest tagged release are maintained for security fixes.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities involving credential exposure, auth bypass, request leakage, or unsafe logging.

Report privately by emailing the maintainer or opening a GitHub security advisory when available. Include:

- affected commit or version
- impact and reproduction steps
- whether credentials, logs, request bodies, or local databases may be exposed

## Secret Handling

- Keep real API keys in `.env` or a secret manager.
- Do not commit local `.env`, databases, logs, run state, or provider credentials.
- Use placeholder provider names and placeholder keys in examples.
- Redact request bodies and authorization headers before sharing logs.

## Runtime Notes

LLM-Hub is designed as a local gateway. If you expose it on a network, protect listener ports with host firewall rules, reverse-proxy authentication, or trusted network boundaries.
