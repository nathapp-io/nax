# Codex Instructions

This file is auto-generated from `.nax/context.md`.
DO NOT EDIT MANUALLY — run `nax generate` to regenerate.

---

## Project Metadata

> Auto-injected by `nax generate`

**Project:** `@nathapp/nax-agent-acp`

**Language:** TypeScript

**Key dependencies:** zod, @types/bun, bun-types, typescript, vitest

**Commands:** test: `bun run test` | lint: `bun run check:all` | typecheck: `bun run typecheck`

---
# nax-agent-acp — ACP backend for nax-agent sessions

`@nathapp/nax-agent-acp` lets the nax-agent session API drive external coding agents
(Claude Code first-class; Codex, Gemini CLI, OpenCode, pi registered) over ACP, the
Agent Client Protocol. It is nax-agent's own ACP client on `@agentclientprotocol/sdk`.
Design: `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`.

> Edit this file to update AI agent context — do not edit `CLAUDE.md`, `AGENTS.md`,
> `.cursorrules`, `GEMINI.md` or other generated agent files directly.
> Run `nax generate` after changing it.

## Status

Built in stages S4-1 to S4-6. S4-1 is the scaffold plus the agent registry
(`src/client/registry.ts`); `./client` exports nothing until S4-2 adds `acpBackend()`.
`./server` is reserved for S5 and stays empty. Nothing is released before S4-6.

## Boundaries

- Import nax-agent only as `@nathapp/nax-agent` (its public entry). Never
  `@nathapp/nax-agent/internal` or a deep path, in src/ or test/.
- `src/` imports only `@agentclientprotocol/sdk` (root, never `/experimental`),
  `@modelcontextprotocol/sdk`, `zod` and `node:` builtins. No Bun API in `src/`.
- No other package imports this one until S4b.
- `bun run check:package-boundaries` in packages/nax enforces these rules.

## Commands (from packages/nax-agent-acp)

| Command | Purpose |
|:--------|:--------|
| `bun run typecheck` | `tsc --noEmit` over src/, test/ and scripts/ |
| `bun run build` | nodenext emit to `dist/` |
| `bun run test` | bun:test unit suite |
| `bun run test:node` | vitest on real Node 22/24 |
| `bun run test:coverage` | 80% floor, overall and per file; per-file baseline stays empty |
| `bun run check:api` / `api:update` | API snapshot of `./client` and `./server` |
| `bun run check:all` | Biome plus the shared repo-tooling gates |
| `bun run stage-publish` | `.publish/` with the peer rewritten to `^<version>`; refuses version drift from nax-agent |

## Releases

Versioned in lockstep with nax-agent and released by nax-agent's helper
(`bun run release ...`, then `release tag`, then `release tag-acp`). See `RELEASING.md`.
