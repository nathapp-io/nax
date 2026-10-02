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
| `packages/nax-agent` | `@nathapp/nax-agent` | Native coding agent: session contract, loop, tools, permissions, sandbox (private; bundled into nax) |
| `packages/repo-tooling` | `@nathapp/nax-repo-tooling` | Check scripts shared by the packages (private; never published) |
| `packages/test-kit` | `@nathapp/nax-test-kit` | Shared bun:test helpers (private; never published) |

Dependency direction: `nax-ai` → `nax-agent` → `nax` (a package never imports one to its right).

## Tooling

- All packages are TypeScript (ESM). The root `package.json` declares `typescript` so tooling detects the language at the workspace root.
- Bun 1.4.0 (pinned in CI). Workspaces with `linker = "isolated"` (root `bunfig.toml`).
- Root scripts run every package in dependency order: `bun run build | typecheck | lint | check:all | test`.
- Every package must define `check:all`; root `check:all` (the repo-level lint gate) silently skips a package without one.
- Package commands run from the package directory (`cd packages/nax`).
- Gates shared by more than one package live in `packages/repo-tooling/scripts/` and scan the package they are run from (`--package=<dir>` overrides). Gates only nax runs stay in `packages/nax/scripts/`.
- Never run bare `bun test` (no path) and never `bun run nax`.

## Releases

Tag-driven, one `release.yml`: `vX.Y.Z` publishes `@nathapp/nax`; `nax-ai-vX.Y.Z` publishes `@nathapp/nax-ai`.
Releases are maintainer-initiated only.
Bumping nax-ai: bump its version and nax's exact pin in one PR; release `nax-ai-vX.Y.Z` before releasing nax.
