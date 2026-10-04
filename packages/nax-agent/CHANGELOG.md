# Changelog

All notable changes to `@nathapp/nax-agent` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is `0.x`, a minor
release may change the public API.

## [Unreleased]

Per-session credential sources (`memory`, `exec`) and adapter-owned clients for embedders; `AuthStamp.source` may be `memory`. nax behaviour unchanged.

The `OwnedPathsPolicy` host port lands on the public entry with `EMPTY_OWNED_PATHS_POLICY` and `OwnedBashCandidate`: which paths the host owns the writes to, and how its refusals read. Owned-path rules are now injected by the host — nax supplies its own policy, so nax behaviour is unchanged, and an embedder that injects nothing gets the empty policy. Signatures on `.` change to carry it: `resolveWithin` gains a required third parameter (`ownedPaths`); `SandboxPolicyInput` gains `ownedPaths` (required) and `projectStateDir` (optional), and `buildSandboxPolicy` follows; three `ProtectedPathsPolicy` fields (`projectStateDir`, `credentialDir`, `trustStoreFile`) become optional, and the sandbox skips the absent ones. `Read`, `Glob` and `Grep` now refuse a symlink-resolved host credential directory or trust-store file when the workdir contains it, regardless of grant.

## [0.1.0] - 2026-10-03

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
