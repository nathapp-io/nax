# Changelog

All notable changes to `@nathapp/nax-agent` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is `0.x`, a minor
release may change the public API.

## [0.1.0] - Unreleased

First published version. Extracted from nax, where it was the native agent.

### Added

- The session contract, the native session adapter and `nativeComplete`, the tool set, permission
  resolution, the OS sandbox, command-safety and the cost core, behind `@nathapp/nax-agent`.
- Process-wide slots: `setAgentLogger`, `configureCredentials`, and `setAgentRuntime` with a Node
  default (`nodeRuntime`).
- Host ports: `runDeclaredCommand`, `ProtectedPathsPolicy`, `commandInterceptor`.
- `@nathapp/nax-agent/internal`, nax-only and outside semver.
- `api/nax-agent.api.txt`: the built public API, checked in CI.

### Notes

- Requires Node.js >= 22.19.0. No Bun APIs ship in the package.
- `.` exports no `_`-prefixed name; test seams and reset hooks are on `./internal` only.
