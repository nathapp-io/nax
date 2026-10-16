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
| `packages/nax-agent-acp` | `@nathapp/nax-agent-acp` | ACP backend for nax-agent sessions (`./client`; `./server` = the `nax-agent` ACP server bin, S5); Node library, nax-agent peer, versioned in lockstep with every published nax package (workspace private; npm uses staged manifest) |
| `packages/repo-tooling` | `@nathapp/nax-repo-tooling` | Check scripts shared by the packages (private; never published) |
| `packages/test-kit` | `@nathapp/nax-test-kit` | Shared bun:test helpers (private; never published) |

Dependency direction: `nax-ai` → `nax-agent` → `nax`, and `nax-agent` → `nax-agent-acp` (peer). nax imports nax-agent-acp only through `@nathapp/nax-agent-acp/client` and bundles it like nax-agent (S4b-2); nax-agent-acp reaches nax-agent only through its public entry. `check:package-boundaries` (packages/nax) enforces both.

## Tooling

- All packages are TypeScript (ESM). The root `package.json` declares `typescript` so tooling detects the language at the workspace root.
- Bun 1.4.3 (pinned in CI). Workspaces with `linker = "isolated"` (root `bunfig.toml`).
- Root scripts run every package in dependency order: `bun run build | typecheck | lint | check:all | test`.
- Every package must define `check:all`; root `check:all` (the repo-level lint gate) silently skips a package without one.
- Package commands run from the package directory (`cd packages/nax`).
- Gates shared by more than one package live in `packages/repo-tooling/scripts/` and scan the package they are run from (`--package=<dir>` overrides). Gates only nax runs stay in `packages/nax/scripts/`.
- Never run bare `bun test` (no path) and never `bun run nax`.

## Code Navigation (codebase-memory MCP)

Use `codebase-memory-mcp` for graph-first code navigation. In nax, the server ID is `codebase-memory` and its tools are named `codebase-memory__<tool>`; use the equivalent exposed names in other hosts. Availability depends on the host's MCP configuration and session stage.

Pass the absolute **Execution repository/worktree root** supplied in the nax prompt directly as the `project` argument (for example `"project": "/Users/alice/src/nax"`); the server resolves a repository root path to its index. If the host does not supply a root, obtain it with `git rev-parse --show-toplevel` (nax Git tool: `{"subcommand":"rev-parse"}`). The path must be the repository root, not a package directory such as `packages/nax`.

Do not start with `codebase-memory__list_projects`: it returns every repository indexed on the machine (no name or path filter), and nax truncates the result, which costs several paging calls. Call it only when a tool fails with `project not found or not indexed`: call it once with `{"limit": 100}` (no `include_details`) and use the entry whose `root_path` equals the repository root. If no entry matches, the repository is not indexed; fall back to direct reads and text search. Never select a different repository's project.

Then call the appropriate MCP tool before structural exploration with directory listings, whole-file reads or grep:
- `search_graph` to find symbols or routes
- `trace_path` for callers and callees
- `get_code_snippet` to read a symbol's exact source
- `get_architecture` for a module or package overview
- `search_code` for text across indexed code (see the regex rule below)
- `detect_changes` for symbols touched by the diff

Rules:
- fall back to direct reads or text search for structural discovery only when the MCP server is unavailable, no matching project is indexed, or a graph query returns insufficient results; explain the fallback
- the index can lag behind recent edits: read the known file before editing; this does not replace graph-first discovery
- `search_code` matches `pattern` as a literal string unless you pass `"regex": true`. An alternation such as `interface Foo|type Foo` or a call such as `git.run(` without it silently returns zero matches. For any pattern with `|`, `(`, `.` or other regex syntax, pass `"regex": true` and escape literal characters (`git\.run\(`). Treat a zero-match `search_code` result as unconfirmed until a text search agrees
- use text search directly for config files, JSON and Markdown

## Releases

Lockstep: `@nathapp/nax-ai`, `@nathapp/nax-agent`, `@nathapp/nax-agent-acp` and `@nathapp/nax` always share one version. From the repo root, `bun run release <patch|minor|major|canary|promote|X.Y.Z>` bumps all four (and nax/nax-agent's exact `@nathapp/nax-ai` pin) in one PR; `bun run release tag` pushes `vX.Y.Z`, and `release.yml` publishes in order nax-ai → nax-agent → nax-agent-acp → nax, skipping any version already on npm.
`check:lockstep` fails a commit whose versions or nax-ai pins disagree. Never bump one package alone.
Releases are maintainer-initiated only. See `RELEASING.md`.
