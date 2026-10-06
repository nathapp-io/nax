# nax-agent-acp — ACP backend for nax-agent sessions

`@nathapp/nax-agent-acp` lets the nax-agent session API drive external coding agents
(Claude Code first-class; Codex, Gemini CLI, OpenCode, pi registered) over ACP, the
Agent Client Protocol. It is nax-agent's own ACP client on `@agentclientprotocol/sdk`.
Design: `docs/superpowers/specs/2026-10-05-s4-acp-backend-design.md`.

> Edit this file to update AI agent context — do not edit `CLAUDE.md`, `AGENTS.md`,
> `.cursorrules`, `GEMINI.md` or other generated agent files directly.
> Run `nax generate` after changing it.

## Status

Built in stages S4-1 to S4-6. S4-2 adds `acpBackend()`: launch, connection,
capabilities, the session lifecycle and text-only `full` turns, tested against a fake
ACP agent (`test/fixtures/fake-agent/`, in process and as a subprocess). Profiles
none/read/ask (S4-3), tools (S4-4), full events and usage (S4-5) and resume (S4-6)
are refused with `AGENT_SESSION_CAPABILITY_UNSUPPORTED` until then. `./server` is
reserved for S5. Nothing is released before S4-6.

## Module map (`src/client/`)

| Module | Role |
|:-------|:-----|
| `options.ts`, `env.ts` | zod options; agent env allowlist and redaction set |
| `registry.ts` | per-agent launch, mode, pre-approval and auth data |
| `launch.ts` | process-group spawn, ndjson stream, stderr tail, `agentGoneError` |
| `connection.ts` | one SDK `ClientApp` per process; outbound requests |
| `capabilities.ts` | capability record, requirement checks, config options |
| `open.ts` | open sequence; kills the agent on any failure |
| `turn.ts`, `events.ts`, `inbound.ts` | prompt turn and abort; text events; inbound routing |
| `backend.ts` | `acpBackend()`, adapter, close; `_acpBackendDeps.launch` test seam |

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
