# acpx 0.6.0 — Runtime SDK Migration (ADR Candidate)

**Parent:** [2026-04-26-acpx-0.6.x-adapter-opportunities.md](./2026-04-26-acpx-0.6.x-adapter-opportunities.md)
**Priority:** Defer (significant)
**Effort:** L (separate ADR + multi-PR rollout)
**Status:** Investigation only

## What changed in acpx

acpx 0.5.0 introduced the embeddable `acpx/runtime` API; 0.6.0 added `startTurn(...)` turn handles, persistent client pool keep-warm (#265), and late-update drain (#251).

The exported surface (from `dist/runtime.d.ts`):

```ts
import { createAcpRuntime, createRuntimeStore, AcpxRuntime } from "acpx/runtime";

const runtime = createAcpRuntime({
  cwd, sessionStore, agentRegistry,
  permissionMode, timeoutMs, mcpServers, ...
});

const handle = await runtime.ensureSession({ sessionKey, agent, mode: "persistent", cwd });
const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId });

for await (const ev of turn.events) { /* live events: text_delta, tool_call, status */ }
const result = await turn.result;  // { status: "completed" | "cancelled" | "failed", ... }
await turn.cancel({ reason });     // mid-turn cancellation
await runtime.close({ handle, reason });
```

Key shapes worth noting:

- **`AcpRuntimeTurn`** — separates live events (`AsyncIterable<AcpRuntimeEvent>`) from the terminal result (`Promise<AcpRuntimeTurnResult>`). The compatibility `runTurn(...)` returns a single AsyncIterable that includes `done`/`error` terminators, but the new shape is cleaner.
- **`AcpRuntimeEvent`** — typed: `text_delta` (with `stream: "output" | "thought"`), `status`, `tool_call`, plus compat `done`/`error`.
- **`AcpRuntimeError`** — typed error codes: `ACP_BACKEND_MISSING`, `ACP_BACKEND_UNAVAILABLE`, `ACP_BACKEND_UNSUPPORTED_CONTROL`, `ACP_DISPATCH_DISABLED`, `ACP_INVALID_RUNTIME_OPTION`, `ACP_SESSION_INIT_FAILED`, `ACP_TURN_FAILED`.
- **`createFileSessionStore({ stateDir })`** — file-backed session persistence; matches our current expectation that sessions survive restarts.

## Why we should care

Today's spawn-per-prompt model has costs:

| Cost today | Source |
|---|---|
| ~100–300ms cold-start per turn | `Bun.spawn("acpx", ...)` startup |
| No live tool-call streaming | We parse JSON only at process exit |
| No mid-turn cancel handle | Best we can do is `proc.kill(SIGTERM)` |
| Pipe-buffer deadlock risk | Why [spawn-client.ts:195-208](../../src/agents/acp/spawn-client.ts#L195-L208) needs the drain races and Bun-bug grace period |
| Process-tree leaks on crash | Periodic acpx/grandchild orphans noted historically |
| Per-turn permission re-evaluation | Each spawn re-loads acpx config |

Migrating to in-process runtime addresses all of these and unlocks:

- **Live event stream** to feed the TUI / interaction subscribers in real time (today they batch on turn end).
- **Granular cancellation** — `turn.cancel()` is well-defined and atomic vs SIGTERM races.
- **Cheap status polling** — `runtime.getStatus({ handle })` replaces `acpx ... status` spawns.
- **Mode/config switching** mid-session (`setMode`, `setConfigOption`) — useful for `permissionMode` upgrades inside a long story.

## Why this is an ADR, not a PR

Rewrites required:

1. [src/agents/acp/spawn-client.ts](../../src/agents/acp/spawn-client.ts) — replace `Bun.spawn` with runtime calls. ~80% rewrite.
2. [src/agents/acp/parser.ts](../../src/agents/acp/parser.ts) — current JSON line parsing becomes redundant; replaced by typed events.
3. [src/agents/acp/parse-agent-error.ts](../../src/agents/acp/parse-agent-error.ts) — switch from stderr regex to `AcpRuntimeError.code`.
4. [src/agents/acp/interaction-bridge.ts](../../src/agents/acp/interaction-bridge.ts) — likely benefits from real-time events (current bridge polls / batches).
5. [src/agents/acp/prompt-audit.ts](../../src/agents/acp/prompt-audit.ts) — verify audit hooks still fire at the right boundaries.
6. `IAgentAdapter` contract — does our `run()` / `complete()` shape need to expose a stream? If yes, this changes the adapter interface and ripples into [src/agents/manager.ts](../../src/agents/manager.ts) and every caller. ADR-013 / ADR-019 already touch this area; coordinate.
7. Test infrastructure — `_deps.spawn` mocking is replaced by `_deps.createAcpRuntime`. All spawn-client tests need rewriting.

Risks:

- acpx as an npm dependency, not just a system binary — adds install-step cost and version-skew exposure (we currently work with whatever `acpx` is on PATH).
- The runtime API is young (v0.5.0, ~2 months old at writing). Surface area may still churn.
- Behavioural parity testing is non-trivial — the current spawn path has years of dogfood; the runtime path does not.

## Recommended next steps

1. **Spike** (1–2 days): wire one path (e.g. `complete()`-only) to the runtime, run a subset of integration tests, measure cold-start savings.
2. **Write the ADR** ([docs/adr/](../../docs/adr/)) capturing:
   - Motivation (the costs above)
   - Migration plan (which adapter methods first, which last)
   - Rollback strategy (config flag `agent.acp.protocol: "spawn" | "runtime"`)
   - Test plan (parity tests, perf benchmarks)
   - Coordination with ADR-013 / ADR-019
3. **Phased rollout** behind config flag, default `"spawn"` until parity confirmed.

## Open questions

- Does the runtime SDK handle the same set of agents as the CLI (Claude, Codex, Gemini, Trae, Qoder, Kiro, Droid)? Need to verify `agentRegistry` mapping.
- Permission mode plumbing — does the runtime accept the same `approve-all` semantics our `resolvePermissions()` produces?
- What about `--prompt-retries` (see [acpx-prompt-retries.md](./acpx-prompt-retries.md)) — is there a runtime-level equivalent, or do we re-implement in nax?
- License / packaging: acpx is MIT, but pulling it as a dep ties our release cycle to theirs.

## Acceptance criteria (for the eventual ADR)

- [ ] ADR document approved.
- [ ] Spike branch demonstrating one method working through the runtime.
- [ ] Perf measurement: cold-start delta and per-turn delta.
- [ ] Config flag with both paths supported during transition.
- [ ] Parity test suite covering: success, transient failure, hard failure, cancellation, reconnect.
