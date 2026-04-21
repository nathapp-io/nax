# ADR-013: SessionManager → AgentManager Hierarchy

**Status:** Accepted (Phases 1–5 complete; Phase 6 in progress — see addendum)
**Date:** 2026-04-20 (Phase 6 addendum: 2026-04-21)
**Author:** William Khoo, Claude
**Extends:** ADR-012 (AgentManager Ownership); ADR-011 (SessionManager Ownership)
**Related:** #592 (auth error bypasses fallback due to adapter retry); #594 (SIGINT cascade); #596–#598 (ISessionRunner / runInSession foundation); #601 (tracking)
**Issues:** Phase 1 #603 · Phase 2 #604 · Phase 3 #605 · AgentRegistry cleanup #602 · Phase 5 direct-call migration #606

---

## Context

ADR-011 extracted session lifecycle into `SessionManager`. ADR-012 extracted agent-selection policy into `AgentManager`. Both ADRs assumed the two managers are **peers**, both wired by the execution layer (`execution.ts` / `SingleSessionRunner` / `ThreeSessionRunner`).

This peer relationship is now causing concrete bugs and architectural debt.

### Three problems from the peer architecture

**Problem 1 — Retry decisions are scattered (#592)**

When an acpx session exits with `stopReason: "error"`, `AcpAgentAdapter` runs its own session-error retry loop (`shouldRetrySessionError`, `SESSION_ERROR_MAX_RETRIES`) *before* returning a result. This loop fires unconditionally — including for `authentication_error` (401). The auth error is consumed by a pointless retry; AgentManager's `shouldSwap` never sees it; the fallback chain never activates.

The root cause: the adapter owns retry decisions it should not own. There are now three isolated retry sites:
- `AcpAgentAdapter` — session-error retry (new session, same agent)
- `AgentManager.runWithFallback` — agent swap (auth / rate-limit → next agent)
- `src/review/semantic.ts`, `src/review/adversarial.ts` — payload-shape retry (JSON parse fail → re-ask), but calling `agent.run()` directly

**Problem 4 — Direct adapter calls are pervasive (~28 sites, 15 files)**

`agent.run()`, `adapter.complete()`, `adapter.plan()`, and `adapter.decompose()` are called directly across review, acceptance, tdd, debate, routing, and CLI modules — bypassing `AgentManager` entirely. Consequences:
- Auth/rate-limit failures in these modules never activate the fallback chain (e.g. semantic review hitting a 401 fails the whole review instead of swapping to codex).
- PID registration does not happen for adapter calls outside `AgentManager`.
- No single place to audit all LLM calls.

Full site list tracked in #606.

**Problem 2 — PidRegistry leaks into the adapter**

`AcpAgentAdapter` receives a `PidRegistry` in `AgentRunOptions` and calls `pidRegistry.register(pid)` directly after spawn. This means the adapter holds a process-management dependency that has nothing to do with prompt execution. Every test that exercises the adapter must either inject a mock PidRegistry or tolerate the `undefined` path.

**Problem 3 — AgentRegistry is bypassed directly**

Several files outside `AgentManager` still call `getAgent(name)` or `createAgentRegistry(config)` directly. `getAgent()` always returns CLI adapters from `ALL_AGENTS[]`, silently ignoring `config.agent.protocol`. This is flagged as a violation in `adapter-wiring.md` but not enforced structurally — nothing prevents new code from repeating the pattern.

### Pre-existing gap surfaced by this analysis

**Gap A — Descriptor not updated after agent swap (High)**

`SessionManager.handoff(sessionId, newAgent)` exists and correctly updates `descriptor.agent` + persists to disk. However, it is **never called** after an agent swap. When `AgentManager.runWithFallback` swaps claude → codex, the session descriptor still shows `agent: "claude"`. The descriptor is stale for the remainder of the run and any resume attempt would try the wrong agent.

**Gap B — `complete()` auth failures do not fall back (Medium)**

`AgentManager.completeWithFallback()` exists and correctly chains fallback on auth / rate-limit. However, several call sites invoke `adapter.complete()` or `agentManager.complete()` directly, bypassing `completeWithFallback`. On a 401 the call fails with no swap. This is tracked as #567 and is **out of scope for this ADR** — it is noted here because Phase 1 explicitly wires `IAgentManager` so that call sites have one clear path to reach fallback.

The structural fix for all three: **establish a strict ownership hierarchy** where SessionManager orchestrates AgentManager, rather than the two being wired independently by the execution layer.

---

## Decision

### Two-path rule

Not every LLM call needs session lifecycle tracking. The rule splits at `IAgentManager`:

```
Path A — descriptor session (needs crash recovery, state machine, resume):
  SessionManager.runInSession(sessionId, agentManager, request)
    └─ IAgentManager.run(request)
         └─ AgentAdapter.run(options)   ← pure executor

Path B — ephemeral call (no descriptor, no state machine):
  IAgentManager.run(request)            ← caller uses directly
    └─ AgentAdapter.run(options)
  IAgentManager.complete(prompt, opts)  ← caller uses directly
    └─ AgentAdapter.complete(options)
```

**The single rule that governs both paths:** `AgentAdapter.run()` and `AgentAdapter.complete()` are never called outside `AgentManager`. Everything else flows from this.

### When to use each path

| Call needs... | Use |
|:---|:---|
| Descriptor persistence, crash recovery, state machine, resume | `SessionManager.runInSession(sessionId, agentManager, request)` |
| Fallback chain + PID tracking, no persistence | `agentManager.run(request)` directly |
| One-shot LLM call, no session at all | `agentManager.complete(prompt, options)` directly |

Concrete assignments:

| Caller | Descriptor needed? | Correct path |
|:---|:---|:---|
| Main execution session | Yes — crash recovery, resume | `SessionManager.runInSession()` |
| TDD writer / implementer / verifier | Yes — crash recovery, resume | `SessionManager.runInSession()` |
| Semantic / adversarial review | No — ephemeral, retry is in-memory | `agentManager.run()` directly |
| Review dialogue (debate) | No | `agentManager.run()` directly |
| Acceptance fix diagnosis / executor | No | `agentManager.run()` directly |
| Routing LLM classify | No | `agentManager.complete()` directly |
| Acceptance generator / refinement | No | `agentManager.complete()` directly |
| Interaction auto-approve | No | `agentManager.complete()` directly |

### SessionManager has one method — runInSession() — forever

`SessionManager` manages session **lifecycle**. It has exactly one execution entry point: `runInSession()`. The session **topology** (how many sessions, in what order, what roles) is the responsibility of `ISessionRunner` implementations — not new SessionManager methods.

```
// ❌ Wrong — topology leak into SessionManager
sessionManager.runInDebateSession(...)
sessionManager.runInTddSession(...)
sessionManager.runInReviewSession(...)

// ✅ Correct — topology lives in ISessionRunner implementations
class SingleSessionRunner  implements ISessionRunner { run() → sessionManager.runInSession() }
class ThreeSessionRunner   implements ISessionRunner { run() → sessionManager.runInSession() × 3 }
class DebateSessionRunner  implements ISessionRunner { run() → sessionManager.runInSession() × N }
```

When a new session topology needs descriptor tracking in future (e.g. debate sessions, acceptance fix sessions), the answer is always: **add a new `XSessionRunner`, not a new SessionManager method**. Session type is encoded in the descriptor's `role` field — it is data, not a method on the manager.

`SessionManager.runInSession()` is stable. It takes a `sessionId`, an `IAgentManager`, and a `SessionAgentRunRequest`. New runner types do not change this signature.

### 0. Core principle: adapter methods are AgentManager-internal

`AgentAdapter.run()`, `AgentAdapter.complete()`, `AgentAdapter.plan()`, and `AgentAdapter.decompose()` are **AgentManager-internal only**. No code outside `src/agents/manager.ts` calls these methods directly.

```
// ✅ Correct — all LLM calls go through IAgentManager
agentManager.run(request)
agentManager.complete(prompt, options)

// ❌ Forbidden — anywhere outside AgentManager
adapter.run(options)
agent.complete(prompt, options)
adapter.plan(options)
```

This principle is what makes fallback, PID registration, and retry policy apply uniformly to every LLM call in the system, not just the main execution path.

### 1. IAgentManager — single interface, not two

`SessionManager.runInSession` receives `IAgentManager`. This is a **single interface** that includes both `run()` and `complete()`, rather than splitting into `AgentRunner` + `AgentCompleter`:

```typescript
// src/agents/manager-types.ts
export interface IAgentManager {
  /** Long-running session call — multi-turn, file editing. */
  run(request: SessionAgentRunRequest): Promise<AgentResult>;

  /** One-shot call — no tool use, no session persistence. */
  complete(prompt: string, options: CompleteOptions): Promise<CompleteResult>;

  /** Return the canonical default agent name for this run. */
  getDefault(): string;

  /** Return a specific adapter by name (internal use by subsystems). */
  getAgent(name: string): AgentAdapter;
}
```

**Why single interface over two:** splitting `AgentRunner` + `AgentCompleter` halves the interface surface for SessionManager but forces every call-site to decide which interface it holds — adding cognitive overhead without measurable benefit. `IAgentManager` is the natural boundary: it represents "the agent management layer" and pipeline stages that need `complete()` get the same object via context.

### 2. Session-error retry moves from Adapter to SessionManager

`AcpAgentAdapter` removes its retry loop entirely. It executes **once**, classifies the result, and returns:

```
Adapter returns:
  adapterFailure.outcome = "fail-adapter-error", retriable: true   → session-transport error (QUEUE_DISCONNECTED)
  adapterFailure.outcome = "fail-adapter-error", retriable: false  → broken session, no retry value
  adapterFailure.outcome = "fail-auth"                             → auth error, needs agent swap
  adapterFailure.outcome = "fail-rate-limit"                       → rate-limit, needs backoff + swap
```

`SessionManager.runInSession` handles session-transport retry (new session, same `IAgentManager`):

```typescript
// Inside SessionManager.runInSession — after agentManager.run() returns:
if (result.adapterFailure?.outcome === "fail-adapter-error" &&
    result.adapterFailure.retriable &&
    sessionRetries < maxSessionRetries &&
    !abortSignal?.aborted) {
  sessionRetries++;
  continue; // retry with a fresh session via agentManager.run()
}
// Otherwise: surface result to caller (AgentManager handles auth/rate-limit swap internally)
```

Rate-limit backoff **stays in AgentManager** (`cancellableDelay` in `runWithFallback`). SessionManager never retries on `fail-rate-limit` — that would double-retry and bypass AgentManager's backoff logic.

**Retry layer ownership after this ADR:**

| Layer | Concern | Owner |
|:---|:---|:---|
| Session-transport retry | Broken socket / QUEUE_DISCONNECTED — new session, same agent | **SessionManager** |
| Availability fallback + backoff | Auth / rate-limit — new agent, exponential delay | **AgentManager** (unchanged) |
| Payload-shape retry | JSON parse fail — re-ask same agent | **Caller** (review module, unchanged) |

This ordering ensures auth errors always bubble through SessionManager → AgentManager without being consumed at the adapter level.

**Config keys** for retry limits already exist in `src/config/schemas.ts` (`sessionErrorMaxRetries`, `sessionErrorRetryableMaxRetries`) — no schema changes needed. The adapter currently reads them; Phase 2 moves the read to SessionManager.

### 3. Adapter fires onPidSpawned callback — AgentManager registers PIDs

The adapter no longer receives or calls `PidRegistry` directly. Instead it fires a callback immediately after spawn:

```typescript
// AgentRunOptions — new field
onPidSpawned?: (pid: number) => void;

// Adapter — replaces pidRegistry.register(pid):
const proc = Bun.spawn(...);
options.onPidSpawned?.(proc.pid);

// AgentManager — provides the callback when calling run():
{
  onPidSpawned: (pid) => this.pidRegistry.register(pid),
}
```

This mirrors the `onSessionEstablished` callback pattern from #591/#598. The adapter is clean: it owns process execution, not registry state. AgentManager owns the PID lifecycle for runs it orchestrates.

`PidRegistry` itself remains a separate infrastructure concern — it is not "owned" by AgentManager, but AgentManager holds a reference and bridges the callback.

### 4. AgentRegistry is internal to AgentManager

`AgentRegistry` (and the `getAgent()` / `createAgentRegistry()` exports) becomes **internal** to `AgentManager`. No code outside `AgentManager` may call these directly.

```typescript
// ✅ Correct — through AgentManager
ctx.agentManager.getAgent("claude")

// ❌ Forbidden — bypass structural ownership
import { getAgent } from "../agents/registry";
import { createAgentRegistry } from "../agents/registry";
```

17+ violation sites across 10 files are tracked in #602. They must be migrated before Phase 4 closes.

### 5. SessionManager calls handoff() after agent swap (Gap A fix)

Phase 2 closes Gap A: when `IAgentManager.run()` returns a result that includes a completed agent swap, `SessionManager.runInSession` calls `handoff(sessionId, newAgent)` to update the descriptor.

The mechanism: `AgentResult` already carries enough signal via `adapterFailure` and per-hop records (`agentFallbacks`). `SessionManager` reads the final agent used from the result and updates the descriptor if it differs from the original:

```typescript
// After agentManager.run() returns in runInSession:
const finalAgent = result.agentFallbacks?.at(-1)?.newAgent ?? request.agentName;
if (finalAgent !== descriptor.agent) {
  this.handoff(sessionId, finalAgent); // updates descriptor.agent + persists
}
```

This requires `AgentResult` to expose the final agent name (already available via `agentFallbacks` from ADR-012 Phase 5).

### 6. SessionManager receives IAgentManager via runInSession options

`SessionManager.runInSession` signature changes to accept `IAgentManager`:

```typescript
// Before (ADR-011 / #596)
runInSession(
  sessionId: string,
  runner: SessionAgentRunner,   // (opts: AgentRunOptions) => Promise<AgentResult>
  options: AgentRunOptions,
): Promise<AgentResult>

// After (this ADR)
runInSession(
  sessionId: string,
  agentManager: IAgentManager,
  request: SessionAgentRunRequest,
  options?: SessionRunOptions,  // retryLimits, abortSignal, onSessionEstablished
): Promise<AgentResult>
```

`SingleSessionRunner` and `ThreeSessionRunner` become thinner: they build a `SessionAgentRunRequest` and call `sessionManager.runInSession(sessionId, agentManager, request)`. The execution layer (`execution.ts`) wires `sessionManager` and `agentManager` together — it no longer needs to think about retry or PID registration.

---

## Known Gaps and Out-of-Scope Items

### Gap B — complete() auth fallback (#567, out of scope)

`completeWithFallback()` exists on AgentManager but many call sites invoke `adapter.complete()` or `agentManager.complete()` directly. Phase 1 wires `IAgentManager` into all call-sites via context, creating one clear path. Migrating call sites to `completeWithFallback` is tracked in #567 and deferred.

### TDD per-role agent selection

`ThreeSessionRunner` currently passes a single agent for all three roles (test-writer, implementer, verifier). Phase 1 wires `IAgentManager` through to TDD sessions. If per-role agent selection is needed in future (e.g. a cheaper agent for verifier), `IAgentManager` is the right injection point — no structural change needed beyond passing different run options per role.

### Payload-shape retry (semantic / adversarial review)

Both `src/review/semantic.ts` and `src/review/adversarial.ts` use `agent.run()` with `keepOpen: true` for their initial call and a JSON-fix retry. The retry *logic* (re-ask for valid JSON) is correctly owned by the review module — but the *call* violates the core principle: it bypasses `AgentManager` entirely. These are Phase 5 migration targets (#606). After migration, a 401 during review activates the fallback chain instead of failing the whole review.

### abortSignal threading

`abortSignal` is already correctly threaded end-to-end: `crash-signals.ts` → session runners → `AgentRunOptions`. Phase 2's retry loop in SessionManager inherits the signal from the existing `options.abortSignal` path. No additional threading work needed.

---

## Consequences

### Positive

- **#592 fixed by construction.** Auth errors can never be consumed by a session-retry loop — the adapter has no loop. SessionManager only retries for `fail-adapter-error, retriable: true`.
- **Gap A fixed.** Descriptor `agent` field is updated after every swap — resume attempts use the correct agent.
- **Retry decisions are auditable.** Three layers, three owners, no overlap.
- **Adapter is a pure executor.** No retry state, no registry calls, no `shouldRetrySessionError` dep. Tests no longer need `shouldRetrySessionError = false`.
- **AgentRegistry violations are structural.** Once unexported, the compiler enforces the boundary.
- **PID lifecycle is centralized.** Adapter is clean; AgentManager owns the callback bridge.
- **SessionManager is stable and extensible.** One `runInSession()` method forever. New session topologies add `ISessionRunner` implementations — zero SessionManager changes required.
- **Non-descriptor callers are not over-engineered.** Review, debate, routing, acceptance modules use `IAgentManager` directly. They gain fallback chain activation without taking on session lifecycle overhead they do not need.

### Negative

- **`runInSession` signature change** — breaking change to the interface introduced in #596/#598. Callers (`SingleSessionRunner`, `ThreeSessionRunner`) need updates.
- **SessionManager gains retry logic** — it is no longer a pure descriptor store + thin wrapper. Acceptable: `runInSession` was already headed this direction and the retry logic is bounded (one `while` loop, one counter).
- **Broad blast radius** — touches `AcpAgentAdapter`, `SessionManager`, `AgentManager`, both session runners, and `execution.ts`. Phased to limit risk.
- **Gap B deferred** — `complete()` call sites do not yet get auth fallback. This is a pre-existing gap, not introduced by this ADR, and is tracked.

### Risks

| Risk | Likelihood | Mitigation |
|:---|:---|:---|
| Double-retry on rate-limit | Low | SessionManager explicitly excludes `fail-rate-limit` from its retry guard; backoff stays in AgentManager |
| Descriptor handoff called with wrong agent name | Medium | `agentFallbacks` field on AgentResult is the authoritative source; Phase 2 tests cover the swap-then-read path |
| TDD sessions receive wrong IAgentManager | Low | ThreeSessionRunner is thin; IAgentManager is passed through unchanged |
| Phase 4 migration breaks a violation site silently | Medium | Unexport forces compiler errors; no silent breakage possible |

### Out of scope

- `completeWithFallback()` migration (#567) — tracked separately.
- Multi-agent concurrent execution — separate concern.
- Payload-shape retry in review modules — stays with caller.
- CLI adapter — does not exist; no cleanup needed. (ADR-013 earlier drafts mentioned it; removed.)

---

## Implementation Plan

### Phase 1 — IAgentManager interface + SessionManager wiring (#603)

**Deliverables:**
- Formalise `IAgentManager` in `src/agents/manager-types.ts` with `run()`, `complete()`, `getDefault()`, `getAgent()`.
- `AgentManager` implements `IAgentManager`.
- `SessionManager.runInSession` accepts `IAgentManager` instead of the raw runner function.
- `SingleSessionRunner` and `ThreeSessionRunner` updated to pass `agentManager` to `runInSession`.
- `execution.ts` wires `agentManager` into the session runners.

**Acceptance criteria:**
- [ ] `IAgentManager` exported from `src/agents` barrel.
- [ ] `SessionManager.runInSession(sessionId, agentManager: IAgentManager, request, options?)` compiles.
- [ ] `SingleSessionRunner` and `ThreeSessionRunner` pass existing test suites without change to test expectations.
- [ ] `test/unit/session/manager-run-in-session.test.ts` updated for new signature.
- [ ] No behaviour change — retry logic still lives in adapter for now.

### Phase 2 — Adapter retry loop removed + SessionManager owns session-error retry (#604)

**Deliverables:**
- Remove `shouldRetrySessionError`, `SESSION_ERROR_MAX_RETRIES`, `SESSION_ERROR_RETRYABLE_MAX_RETRIES`, and the retry loop from `AcpAgentAdapter`.
- Adapter `run()` becomes single-execution: call `_runWithClient`, classify result, return.
- `SessionManager.runInSession` gains session-transport retry loop:
  - Retry only on `fail-adapter-error, retriable: true`
  - Never retry on `fail-auth`, `fail-rate-limit`, `fail-aborted`
  - Respects `abortSignal`
  - Reads limits from `config.execution.sessionErrorMaxRetries` / `sessionErrorRetryableMaxRetries`
- **Gap A fix:** after `agentManager.run()` returns, check `agentFallbacks` and call `handoff(sessionId, finalAgent)` if agent changed.

**Acceptance criteria:**
- [ ] `_acpAdapterDeps.shouldRetrySessionError` deleted.
- [ ] `adapter-failure.test.ts` no longer sets `shouldRetrySessionError = false` in `beforeEach`.
- [ ] `test/unit/session/manager-session-retry.test.ts` covers:
  - `fail-adapter-error, retriable: true` → retries up to max
  - `fail-adapter-error, retriable: false` → does not retry
  - `fail-auth` → does not retry, surfaces to AgentManager
  - `fail-rate-limit` → does not retry at SessionManager level
- [ ] Descriptor `agent` field updated after swap (handoff called).
- [ ] Dogfood: `fallback-probe` — claude 401 → codex fallback, no intermediate session-retry log line.

### Phase 3 — onPidSpawned callback + PidRegistry removed from adapter (#605)

**Deliverables:**
- Add `onPidSpawned?: (pid: number) => void` to `AgentRunOptions`.
- `AcpAgentAdapter` fires `options.onPidSpawned?.(proc.pid)` immediately after `Bun.spawn`; removes `pidRegistry.register()` call.
- `AgentManager.run()` provides `onPidSpawned: (pid) => this.pidRegistry.register(pid)`.
- `AgentRunOptions.pidRegistry` field removed.

**Acceptance criteria:**
- [ ] `AgentRunOptions.pidRegistry` deleted — compiler error if any code still passes it.
- [ ] `grep -rn "pidRegistry" src/agents/acp/` → 0 hits.
- [ ] PID registration timing test: PID registered before first prompt fires.
- [ ] `bun run typecheck && bun run test` green.

### Phase 5 — Migrate all direct adapter call sites to IAgentManager (#606)

**Deliverables (one PR per subsystem):**
- All `agent.run()`, `adapter.complete()`, `adapter.plan()`, `adapter.decompose()` calls outside `AgentManager` replaced with `agentManager.run()` / `agentManager.complete()`.
- ~28 call sites across 15 files migrated: review (semantic, adversarial, dialogue), acceptance (fix-diagnosis, fix-executor, fix-generator, generator, refinement), tdd (session-runner, rectification-gate), verification (rectification-loop), debate (session-stateful, session-helpers, resolvers, session-plan), routing (llm strategy), interaction (auto plugin), CLI (plan).
- `AgentAdapter.run()` and `AgentAdapter.complete()` marked `@internal` in JSDoc.
- `adapter-wiring.md` updated with the full forbidden-call list.

**Acceptance criteria:**
- [ ] `grep -rn "adapter\.run\|agent\.run\|adapter\.complete\|agent\.complete\|adapter\.plan\|adapter\.decompose" src/` outside `src/agents/manager.ts` → 0 hits.
- [ ] Each per-subsystem PR passes the full test suite independently.
- [ ] Auth failure in semantic review triggers agent fallback, not review failure (fixture run or targeted test).
- [ ] `bun run typecheck && bun run test` green.

**Sequencing:** Blocked by Phase 1 (#603). Can run as parallel per-subsystem PRs once Phase 1 lands.

### Phase 4 — AgentRegistry ownership cleanup (#602)

**Deliverables:**
- `getAgent()` and `createAgentRegistry()` unexported from `src/agents/index.ts`.
- All 17+ violation sites migrated to `ctx.agentManager.getAgent(name)` or DI'd `IAgentManager`.
- `adapter-wiring.md` updated: "compiler-enforced, not just convention".

**Acceptance criteria:**
- [ ] `grep -rn "createAgentRegistry" src/` outside `src/agents/manager.ts` → 0 hits.
- [ ] `grep -rn "from.*agents/registry" src/` outside `src/agents/manager.ts` → 0 hits (type-only test imports excepted).
- [ ] All tests pass.

---

## Alternatives Considered

**(a) Keep peers, fix #592 with a guard in the adapter.**
Add `parsed.type !== "auth" && parsed.type !== "rate-limit"` to the session-error retry condition. Fixes the immediate symptom but leaves retry logic in the adapter, Gap A (stale descriptor) open, and PidRegistry coupling unresolved.

**(b) AgentManager as orchestrator (not SessionManager).**
Move session-error retry into `AgentManager.runWithFallback`. Rejected: AgentManager's concern is "which agent" — it should not know about session handles, descriptor state, or transport-level errors. The hierarchy `SessionManager → AgentManager` maps naturally to the containment relationship: a session contains an agent run, not the other way around.

**(c) Two interfaces: AgentRunner + AgentCompleter.**
Separate interfaces for `run()` and `complete()` so SessionManager only receives `AgentRunner`. Rejected: splits a single concept (`IAgentManager`) into two, adds cognitive overhead at every call-site, and gains nothing — SessionManager does not call `complete()` but pipeline stages that already hold `IAgentManager` do.

**(d) Expose `agentFallbacks` on every AgentResult for handoff.**
The fallback hop list is already emitted by `AgentManager` (ADR-012 Phase 5). Relying on it for Gap A avoids adding a new field to `AgentResult`. This is the chosen approach.

**(e) Add per-topology methods to SessionManager (runInDebateSession, runInReviewSession, …).**
Rejected: topology is the runner's concern, not the manager's. Each new method would couple SessionManager to a specific workflow and require changes every time a new session type is introduced. The `ISessionRunner` pattern — add a new runner class, call the same `runInSession()` — is open for extension without touching SessionManager. Session type is data in the descriptor's `role` field, not a method.

**(f) Route all calls through SessionManager, including complete() and ephemeral run() calls.**
Rejected: `complete()` calls are stateless and ephemeral — no descriptor, no state machine, no crash recovery needed. Forcing them through `SessionManager.runInSession()` would create session descriptors for one-shot LLM calls (routing decisions, AC refinement, auto-approve) that have no meaningful lifecycle. The two-path rule (descriptor sessions via `runInSession()`, ephemeral calls via `IAgentManager` directly) gives each call site exactly the overhead it needs — no more, no less.

---

## Addendum — Phase 6: Manager Lifetime & Factory (2026-04-21)

Post-Phase 5 review surfaced that this ADR assumed a single `AgentManager` per run but did not enforce it. Seven `new AgentManager(config)` call sites exist outside `src/execution/runner.ts`, and at least two of them (`verification/rectification-loop.ts`, `debate/session-helpers.ts`) run **mid-story** — where creating a fresh manager silently discards the unavailability map (`_unavailable`) and fallback-pruning state (`_prunedFallback`) accumulated by the canonical manager. The symptom is a story re-hitting a 401 on an agent the main runner already marked unavailable, because the mid-story manager starts with empty state.

This was not a wrong decision in Phases 1–5; it was a gap in the lifetime contract. Phases 1–5 established "all adapter calls go through `IAgentManager`" and enforced it via `test/integration/cli/adapter-boundary.test.ts`. They did not establish "one manager per run."

Phase 6 corrects this without changing the decided hierarchy. Implementation details, migration plan per call site, acceptance criteria, and rollback are tracked in `docs/specs/SPEC-agent-manager-lifetime.md` — kept separate so this ADR remains a stable record of the decision while the SPEC evolves through implementation.

---

## References

- ADR-011: SessionManager Ownership
- ADR-012: AgentManager Ownership (retry-layer table at §Retry-layer separation)
- Issue #592: auth error not triggering fallback — root cause is adapter session-error retry
- Issue #567: complete() fallback gap (out of scope, tracked separately)
- Issue #594: SIGINT cascade (PidRegistry freeze pattern, same process-management concern)
- PRs #596–#598: ISessionRunner / runInSession foundation that Phase 1 builds on
- `.claude/rules/adapter-wiring.md` §Rule 3: AgentRegistry direct-use violations (17+ sites, #602)
- Gap analysis: pre-implementation audit 2026-04-20
