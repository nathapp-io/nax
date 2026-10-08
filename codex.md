# Codex Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `nax-monorepo`

**Language:** TypeScript

**Key dependencies:** typescript

**Commands:** test: `bun run test` | lint: `bun run check:all` | typecheck: `bun run typecheck`

---
# nax monorepo — repo-wide context

This repository is a Bun-workspace monorepo. Package-specific context lives in
`.nax/mono/packages/<pkg>/context.md` and is generated into `packages/<pkg>/CLAUDE.md`.

## Layout

| Path | Package | Notes |
|:-----|:--------|:------|
| `packages/nax` | `@nathapp/nax` | CLI orchestrator (Bun bundle, `dist/nax.js`) |
| `packages/nax-ai` | `@nathapp/nax-ai` | Provider-agnostic LLM client (Node target, ESM-only, vitest) |
| `packages/nax-agent` | `@nathapp/nax-agent` | Node library: session contract, loop, tools, permissions, sandbox; also bundled into nax (workspace private; npm uses staged manifest) |
| `packages/nax-agent-acp` | `@nathapp/nax-agent-acp` | ACP backend for nax-agent sessions (`./client`; `./server` = the `nax-agent` ACP server bin, S5); Node library, nax-agent peer, versioned in lockstep with nax-agent (workspace private; npm uses staged manifest) |
| `packages/repo-tooling` | `@nathapp/nax-repo-tooling` | Check scripts shared by the packages (private; never published) |
| `packages/test-kit` | `@nathapp/nax-test-kit` | Shared bun:test helpers (private; never published) |

Dependency direction: `nax-ai` → `nax-agent` → `nax`, and `nax-agent` → `nax-agent-acp` (peer). nax imports nax-agent-acp only through `@nathapp/nax-agent-acp/client` and bundles it like nax-agent (S4b-2); nax-agent-acp reaches nax-agent only through its public entry. `check:package-boundaries` (packages/nax) enforces both.

## Tooling

- All packages are TypeScript (ESM). The root `package.json` declares `typescript` so tooling detects the language at the workspace root.
- Bun 1.4.0 (pinned in CI). Workspaces with `linker = "isolated"` (root `bunfig.toml`).
- Root scripts run every package in dependency order: `bun run build | typecheck | lint | check:all | test`.
- Every package must define `check:all`; root `check:all` (the repo-level lint gate) silently skips a package without one.
- Package commands run from the package directory (`cd packages/nax`).
- Gates shared by more than one package live in `packages/repo-tooling/scripts/` and scan the package they are run from (`--package=<dir>` overrides). Gates only nax runs stay in `packages/nax/scripts/`.
- Never run bare `bun test` (no path) and never `bun run nax`.

## Releases

Tag-driven, one `release.yml`: `vX.Y.Z` publishes `@nathapp/nax`; `nax-ai-vX.Y.Z` publishes `@nathapp/nax-ai`; `nax-agent-vX.Y.Z` publishes `@nathapp/nax-agent` from `.publish/`; `nax-agent-acp-vX.Y.Z` publishes `@nathapp/nax-agent-acp` from `.publish/` after the same nax-agent version is on npm.
Releases are maintainer-initiated only.
Release order: nax-ai → nax-agent → nax-agent-acp → nax. Bumping nax-ai updates both consumers' exact pins in the same PR.
nax-agent's first 0.1.0 publish is manual (maintainer OTP/2FA), followed by trusted-publisher setup; its tag verifies the existing artifact and creates the GitHub prerelease. Later agent tags use OIDC with provenance. See `packages/nax-agent/RELEASING.md`. nax-agent and nax-agent-acp share one version; nax-agent's release helper bumps both. See `packages/nax-agent-acp/RELEASING.md`.
