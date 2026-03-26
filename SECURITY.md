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

- **Environment variable filtering** — nax filters sensitive env vars before passing them to agent subprocesses
- **File system access** — agents operate within the project directory
- **Configuration injection** — nax config files are parsed with strict Zod schemas
- **Agent permissions** — the `dangerouslySkipPermissions` flag controls whether agents can auto-approve tool use
