# nax monorepo — repo-wide context

This repository is a Bun-workspace monorepo. Package-specific context lives in
`.nax/mono/packages/<pkg>/context.md` and is generated into `packages/<pkg>/CLAUDE.md`.

## Layout

| Path | Package | Notes |
|:-----|:--------|:------|
| `packages/nax` | `@nathapp/nax` | CLI orchestrator (Bun bundle, `dist/nax.js`) |
| `packages/nax-ai` | `@nathapp/nax-ai` | Provider-agnostic LLM client (Node target, ESM-only, vitest) |
| `packages/nax-agent` | `@nathapp/nax-agent` | Node library: session contract, loop, tools, permissions, sandbox; also bundled into nax (workspace private; npm uses staged manifest) |
| `packages/nax-agent-acp` | `@nathapp/nax-agent-acp` | ACP backend for nax-agent sessions (`./client`; `./server` = the `nax-agent` ACP server bin, S5); Node library, nax-agent peer, versioned in lockstep with every published nax package (workspace private; npm uses staged manifest) |
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

Lockstep: `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax` always share one version. From the repo root, `bun run release <patch|minor|major|canary|promote|X.Y.Z>` bumps all four (and nax/nax-agent's exact `@nathapp/nax-ai` pin) in one PR; `bun run release tag` pushes `vX.Y.Z`, and `release.yml` publishes in order nax-ai → nax-agent → nax-agent-acp → nax, skipping any version already on npm.
`check:lockstep` fails a commit whose versions or nax-ai pins disagree. Never bump one package alone.
Releases are maintainer-initiated only. See `RELEASING.md`.
