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

Built in stages S4-1 to S4-6. S4-2 added `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text turns. S4-3 added all four profiles:
mode by profile and permission requests decided by profile (`permissions.ts`), with
`ask` going to the caller through the facade's ask port. S4-4 added embedder tools:
a per-session loopback MCP tool host (`tool-host.ts`, `tool-calls.ts`) and Claude
pre-approval (`pre-approval.ts`). S4-5 adds turn events (thinking, tool calls,
usage) and elicitation as questions. Tested against a fake ACP agent
(`test/fixtures/fake-agent/`, in process and as a subprocess; its `mcpCall` step is
a real MCP client, and its `update` and `elicit` steps send any session update and
elicitation). S4-6 added resume (`resume.ts`: stored-record check before spawning, `session/resume`
else `session/load`, identity via the id Claude echoes) and one reconnect after the
agent process dies (`backend.ts`: a new process, router and tool host token; the cost
baseline is carried over and persisted as `acp.costUsd`). `./server` is reserved for S5.
The packed smoke (`test/node/pack-smoke.test.ts`) stages both packages at one version.
The live Claude and initialize-only fixtures in `test/node/fixtures/` are
maintainer-run and billed, and never run in CI.

## Module map (`src/client/`)

| Module | Role |
|:-------|:-----|
| `options.ts`, `env.ts` | zod options; agent env allowlist and redaction set |
| `registry.ts` | per-agent launch, mode, pre-approval and auth data |
| `launch.ts` | process-group spawn, ndjson stream, stderr tail, `agentGoneError` |
| `connection.ts` | one SDK `ClientApp` per process; outbound requests |
| `capabilities.ts` | capability record, requirement checks, config options |
| `open.ts` | open sequence; kills the agent on any failure |
| `turn.ts`, `events.ts`, `inbound.ts` | prompt turn and abort; the turn's event collector; inbound routing (updates, permissions, elicitations) by turn and session |
| `stream-scrub.ts` | session secrets scrubbed from streamed agent text, holding back only a possible secret's start |
| `tool-events.ts` | `tool_call` / `tool_result` from ACP tool updates: sent when used, one result per call |
| `usage.ts` | per-turn tokens; the session's cost meter over cumulative reported cost |
| `elicitation.ts` | `elicitation/create` forms asked one field at a time as questions |
| `permissions.ts` | §6.4 decision per permission request, by profile; only `*_once` options |
| `tool-display.ts`, `text.ts` | what a person sees of a tool call; control-strip, secret scrub, caps |
| `tool-host.ts` | loopback MCP server for embedder tools: gate (Host, Origin, token, body cap), one stateless MCP server per request |
| `tool-calls.ts` | tools/list and tools/call: turn check, 8-call cap, `always` approval, run under the turn signal |
| `pre-approval.ts` | server name `nax`, rule `mcp__nax__<tool>`, Claude `_meta` |
| `backend.ts` | `acpBackend()`, adapter, tool host wiring, close; `_acpBackendDeps.launch` test seam |

Tests reach a process only through `_acpBackendDeps.launch`
(`test/helpers/in-memory-launch.ts`) or the subprocess fake (`FAKE_MAIN`). Never
start a real ACP adapter in the unit suite.

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
