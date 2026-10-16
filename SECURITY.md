# Security Policy

## Supported Versions

| Version | Supported          |
|:--------|:-------------------|
| latest  | :white_check_mark: |
| < latest | :x:               |

We only support the latest released version. Please upgrade before reporting issues.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please use [GitHub Private Vulnerability Reporting](https://github.com/nathapp-io/nax/security/advisories/new) to submit a report. This keeps the disclosure private until a fix is released.

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive an acknowledgment within 48 hours. We aim to release a fix within 7 days for critical issues.

## Scope

nax orchestrates AI coding agents that execute code on your machine. Security-relevant areas include:

- **Environment variables** — ACP agents launched through `@nathapp/nax-agent-acp` get an allowlisted environment (`inheritEnv` hands them the whole environment instead), and values of secret-named variables are scrubbed from streamed agent text
- **File system access** — the native agent's tools work inside the session's workdir and respect protected paths and its OS sandbox; ACP agent processes run unsandboxed on the host
- **Configuration injection** — nax config files are parsed and validated with Zod schemas
- **Agent permissions** — the permission mode (`approve-all`, `approve-reads` or `scoped`) controls whether agents can auto-approve tool use
