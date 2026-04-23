# ADR-011: Session Manager Ownership

**Status:** Accepted (implemented; `runInSession` primitive refined by [ADR-013](./ADR-013-session-manager-agent-manager-hierarchy.md))
**Date:** 2026-04-18 (revised 2026-04-23)
**Author:** William Khoo, Claude
**Refines:** [ADR-008](./ADR-008-session-lifecycle.md) — policy retained, primitive replaced (see §Mapping)
**Extended by:** [ADR-013](./ADR-013-session-manager-agent-manager-hierarchy.md) — introduces `ISessionRunner` and threads `AgentManager` through `runInSession`

---

## Context

ADR-008 decided *when* a session should stay warm per role (reviewer verdicts are independent, implementer iterations are stateful). That decision is still correct, but its primitive — `keepSessionOpen: boolean` passed from pipeline stage to adapter — accumulated load it was not designed to carry.

As nax added availability fallback, scratch-based context transfer, crash recovery, and cross-adapter portability (SPEC-context-engine-v2 Amendment D, SPEC-context-engine-agent-fallback, SPEC-session-manager-integration), the adapter ended up owning:

- Session naming (`buildSessionName()` from `(workdir, feature, storyId, role)`)
- Session state (sidecar file `acp-sessions.json`, statuses `in-flight` / `open`)
- Crash detection (sidecar mtime > 2h heuristic)
- Cleanup policy (`finally` block decides close vs. promote-to-open based on `keepSessionOpen` + success)
- Force-terminate intent (inferred from error state, not expressed)

Five concrete problems this created, each reproduced in production:

1. **Adapter decides close, pipeline can't override.** `keepSessionOpen` is a hint; the `finally` block still closes on certain error paths. Callers cannot reliably keep a session alive across adapter-level errors that the pipeline would classify as retryable.
2. **Session state is protocol-specific.** Sidecars are keyed on ACP session names. A Codex or Gemini adapter would need a parallel sidecar format and parallel crash-detection heuristic.
3. **No stable ID for the pipeline.** `ctx.sessionId` did not exist; every call site recomputed the ACP name. Fallback handoff and audit correlation had no persistent identifier to hang on to.
4. **Scratch had nowhere to live.** Context-engine v2's `SessionScratchProvider` needs per-session disk state that survives a session close. The adapter owns no such thing.
5. **Force-terminate was unreachable.** AC-83 requires `session.close({ forceTerminate: true })` for errored sessions, but the adapter's `finally` block has no access to the pipeline-level distinction between "done normally" and "failed terminally" — it only sees exit codes.

The review-oscillation failure from ADR-008 was the canary. Fallback, scratch, and force-terminate are the forcing function.

---

## Decision

Move session *lifecycle* out of the adapter into a dedicated `SessionManager`. The adapter keeps the *physical* session (acpx process, protocol calls). Policy (ADR-008) is preserved but re-expressed as state-machine transitions rather than a boolean flag.

### Ownership boundary

```
SessionManager  (src/session/manager.ts)     Adapter  (src/agents/acp/adapter.ts)
─────────────────────────────────────────    ─────────────────────────────────────
Owns:                                        Owns:
  - Stable session ID (sess-<uuid>)            - acpx process lifecycle
  - State machine (7 states)                   - loadSession / createSession
  - Scratch directory                          - sendPrompt / multi-turn loop
  - index.json (sidecar replacement)           - token / cost tracking
  - Close / resume / handoff decisions         - prompt audit
  - Orphan detection (state-based)             - protocol-level retry on
  - Agent-agnostic session naming                QUEUE_DISCONNECTED (AC-79)
  - runInSession primitive (ADR-013)           - multi-turn `keepOpen` within
                                                 a single run() call

Does NOT own:                                Does NOT own:
  - acpx process                               - session lifecycle decisions
  - protocol-level retry                       - crash detection
  - prompt audit                               - sidecar files
```

### State machine (7 states, terminal = COMPLETED | FAILED)

```
CREATED → RUNNING → { PAUSED | COMPLETED | FAILED | CLOSING }
PAUSED  → { RESUMING | FAILED }
RESUMING → { RUNNING | FAILED }
CLOSING → { COMPLETED | FAILED }
```

Transitions are validated by the manager (`SESSION_TRANSITIONS` map). **Invalid transitions throw `NaxError SESSION_INVALID_TRANSITION`** carrying `{ from, to, allowed, sessionId }` context — they do not silently accept or warn. Terminal states have empty transition arrays; any attempt to leave them fails fast. See [src/session/manager.ts:194-211](../../src/session/manager.ts#L194-L211).

Teardown helpers that must run regardless of current state (e.g. run-completion catch-all) chain transitions through `getStorylessCloseChain()` in [src/execution/session-manager-runtime.ts:42-57](../../src/execution/session-manager-runtime.ts#L42-L57) rather than jumping directly to `COMPLETED`, so the state-machine invariant is preserved on cleanup paths.

### The `runInSession` primitive (added in ADR-013 Phase 1)

All state transitions except terminal-failure cleanup go through one method on `SessionManager`:

```typescript
sessionManager.runInSession(sessionId, agentManager, request): Promise<AgentResult>
```

Inside one call it owns:

1. **`CREATED → RUNNING`** before dispatching to `agentManager.run()` (`RESUMING` is left alone so rectification loops that re-enter an already-running session don't trip `SESSION_INVALID_TRANSITION`).
2. **Eager handle binding** via `onSessionEstablished(protocolIds, sessionName)` callback (issue #591). The adapter fires this before any prompt runs; the manager chains it into `bindHandle()` so if the run is interrupted between `session/new` and `session/prompt`, the descriptor already carries the correlation needed for crash recovery. The caller's own callback is preserved.
3. **Session-transport retry** on `fail-adapter-error` (retriable: `sessionErrorRetryableMaxRetries`, default 3; non-retriable: `sessionErrorMaxRetries`, default 1). Auth/rate-limit failures surface immediately so `AgentManager.runWithFallback` can engage without `SessionManager` doubling up the retry.
4. **Post-run agent reconcile.** If `AgentManager` swapped agents mid-run (via `result.agentFallbacks`), the final agent is applied to the descriptor via `handoff()` so metrics and crash recovery see the correct owner.
5. **`RUNNING → COMPLETED`** on success or **`RUNNING → FAILED`** on failure. If the runner throws, the manager transitions to `FAILED` and re-throws — the session is never left hanging in `RUNNING`.

**Rule:** Every `ISessionRunner` implementation (`SingleSessionRunner`, `ThreeSessionRunner`, `DebateSessionRunner`) MUST route each session through `runInSession`. This is how cross-cutting concerns (state transitions, handle binding, transport retry, agent reconcile) stay in one place instead of being re-implemented per call site. See [ADR-013 §Decision](./ADR-013-session-manager-agent-manager-hierarchy.md).

### Mapping ADR-008 policy to new primitives

The per-role policy matrix from ADR-008 maps onto the state machine:

| ADR-008 primitive | New primitive |
|:---|:---|
| `keepSessionOpen: true` after call | Session stays `RUNNING`; caller may transition to `PAUSED` for mid-task pause, or hand off to the next pipeline stage |
| `keepSessionOpen: false` after call | `runInSession` transitions to `COMPLETED` at end of call |
| Reviewer "initial: true / retry: false" | Initial call leaves session `RUNNING`; JSON-retry transitions to `COMPLETED` |
| Rectifier `!isLastAttempt` | All but last attempt leave session `RUNNING`; last transitions to `COMPLETED` |
| Escalation (new tier) | Current session transitions to `FAILED`; manager creates a fresh session for the next tier |

The policy from ADR-008 is preserved verbatim. The change is the encoding: decisions are now explicit state transitions at call sites instead of a boolean the adapter interprets.

### `keepOpen` is narrowed, not removed

`AgentRunOptions.keepOpen?: boolean` survives on the `AgentAdapter` interface ([src/agents/types.ts](../../src/agents/types.ts)) but its scope is narrowed:

- **Before:** controlled both the physical-close decision AND the pipeline-level "should this session survive to the next call" decision. Two concerns on one boolean.
- **After:** controls only the adapter's internal close-on-success within a single `run()` invocation. Whether the session *logically* survives is owned by the `SessionDescriptor.state` transition.

That separation is load-bearing: the adapter can keep the physical ACP session warm for a multi-turn retry inside one `run()` while the manager independently decides whether that session continues into the next pipeline stage. The two no longer have to agree through one flag.

### New architectural decisions (not in ADR-008)

1. **Run-level centralization.** One `SessionManager` per `Runner.run()`, threaded via `PipelineContext`. Sessions do not persist across separate `nax` invocations in Phase 0; `index.json` is rewritten at run start, orphan sweep runs at setup ([src/execution/lifecycle/run-setup.ts:230](../../src/execution/lifecycle/run-setup.ts#L230)).

   *Why this is the right default:* cross-run session resume requires reconciling scratch, protocol IDs, agent version, and permission context across process boundaries — non-trivial and easy to get wrong. Nothing in the current pipeline *requires* cross-run continuity (the resume-from-queue flow re-enters a fresh run). We defer it behind a single consolidation point: the on-disk `descriptor.json` is already written on every mutation ([src/session/manager.ts:124-135](../../src/session/manager.ts#L124-L135)), so a future "resume last run" feature has a serialization format to build on without changing the in-memory contract.

2. **AC-83 force-terminate on `FAILED`.** `AgentAdapter.closePhysicalSession(handle, workdir, options?: { force?: boolean })` is the only way to hard-terminate. The runtime helper `session-manager-runtime.ts` sets `force = descriptor.state === "FAILED"` on all close paths — `closeStorySessions`, `closeStorylessSession`, `failAndClose`.

3. **Orphan detection via state, not mtime.** `sweepOrphans(ttlMs)` walks the in-memory registry for terminal sessions older than TTL (default 4h) and removes their entries. Replaces the sidecar-mtime heuristic. Deterministic and adapter-agnostic. Non-terminal sessions are never swept — if a session is still "running" in state terms, the run that owns it is still responsible for closing it.

4. **Handoff preserves session identity.** `manager.handoff(id, newAgent, reason?)` updates the `agent` field but keeps `id`, `handle`, `scratchDir`, and `storyId` stable. The new agent inherits scratch history (with cross-agent neutralization, AC-42). Supports availability fallback without losing story context. Handoff is also applied post-run by `runInSession` to reconcile with `AgentManager`'s final-agent decision (Gap A fix).

5. **Explicit fail-and-close at point of terminal failure.** Because `listActive()` excludes terminal sessions, a failed session must be physically closed at the moment of transition — teardown will not see it. The `failAndClose(sessionManager, sessionId, agentGetFn)` helper performs transition + force-close atomically at [src/execution/session-manager-runtime.ts:86-106](../../src/execution/session-manager-runtime.ts#L86-L106). Called from [src/pipeline/stages/execution.ts](../../src/pipeline/stages/execution.ts) on agent-exhaustion and merge-conflict abort paths.

---

## Alternatives Considered

### A. Extend the adapter's sidecar with more fields

Keep adapter ownership; add `state`, `failure`, `scratchDir` columns to `acp-sessions.json`. **Rejected** — still protocol-specific; does not solve cross-adapter portability or run-level state queries. Every new adapter re-implements the same state machine.

### B. Thread `keepSessionOpen` plus a `markFailed` flag

Minimal change: add a `forceClose: boolean` parameter to `agent.run()`, let the adapter continue to own the rest. **Rejected** — does not address scratch ownership, handoff, or crash detection. Papers over symptoms.

### C. Manager owns everything including physical session

Push acpx process management into the manager. **Rejected** — the manager becomes protocol-aware, defeating the separation. Adapters are per-protocol for a reason (acpx vs. CLI vs. future OpenAI-native).

### D. Use sidecar mtime for orphan detection (retain from old design)

Keep the `>2h` mtime heuristic. **Rejected** — the failure mode in ADR-008's review oscillation surfaced because crashes within the window were invisible. State-based detection is strictly more accurate. Storage cost of `lastActivityAt` ISO timestamp is negligible.

### E. Let `closeStory()` also return already-FAILED sessions for physical close

Instead of `failAndClose` doing inline close, have `closeStory()` include terminal sessions in its return list so teardown handles them. **Rejected** — muddies the contract (`closeStory` returns "sessions closed by this call" vs. "sessions needing cleanup"). Inline close is more direct: the session is dead; release the handle now.

### F. Scatter state transitions across call sites (no `runInSession`)

Let each pipeline stage call `transition()` before and after `agent.run()`. **Rejected in ADR-013** — produces ~40 call sites that all need to remember: CREATED→RUNNING, bindHandle, post-run agent reconcile, transport retry, COMPLETED vs. FAILED. One missing `try/finally` leaves a session stuck in `RUNNING` forever. `runInSession` collapses this into one primitive the compiler can enforce via `ISessionRunner`.

---

## Consequences

### Positive

- **Adapter stays thin.** Codex / Gemini adapters implement `run()`, `complete()`, `closePhysicalSession()`, and `deriveSessionName()`. No state machine, no sidecar, no crash heuristic.
- **Pipeline has a stable handle.** `ctx.sessionId` is constant across a story; audits, metrics, scratch, and handoff all hang on it.
- **Availability fallback works.** Handoff preserves `scratchDir` and session identity; the new agent picks up from where the old agent left off. `AgentManager`-level fallback is reconciled back into the descriptor post-run.
- **Force-terminate is reachable.** Explicit transition to `FAILED` + `failAndClose` guarantees AC-83 fires. Previously unreachable (see SPEC-session-manager review H-1).
- **Orphan detection is deterministic.** State-based; no mtime races.
- **Crash resilience.** Eager `onSessionEstablished` binding means even an interrupted first turn leaves a descriptor with enough protocol-level IDs to resume.

### Structural Guarantees

- **No double-close by construction.** `closeAllRunSessions` operates on `listActive()`, which filters out `COMPLETED`/`FAILED`. A session closed inline via `failAndClose` is structurally invisible to teardown — the "two layers of cleanup" is not a documented assumption but a consequence of the filter. Asserted by [test/unit/execution/session-manager-runtime.test.ts](../../test/unit/execution/session-manager-runtime.test.ts).
- **State machine enforced, not advisory.** Every transition passes through `SESSION_TRANSITIONS[current].includes(to)`; violations throw. No code path can skip from `CREATED` straight to `COMPLETED` or resurrect a terminal session.
- **In-memory is authoritative; disk is supplementary.** `descriptor.json` writes are fire-and-forget (`void ...catch(warn)`) so disk failures never block session creation or mutation. The `Map` is the SSOT; disk exists only for cross-iteration discovery and future cross-run resume.

### Negative / Trade-offs

- **Two layers of cleanup still exist logically** (inline `failAndClose` + teardown `closeAllRunSessions`), but as noted above, the `listActive()` filter makes them structurally disjoint. A refactor that switches teardown to iterate the full registry would reintroduce the hazard — test coverage guards against this regression.

- **`keepOpen` semantics changed subtly.** Old callers that passed `keepSessionOpen: true` to preserve session *across stages* need to migrate to state-machine transitions. Old callers that passed it for *multi-turn within a single run* keep working as-is. The field was renamed (`keepSessionOpen` → `keepOpen`) and narrowed, not deleted. Full migration to the state machine for cross-stage continuity is tracked through the `ISessionRunner` rollout in ADR-013.

- **State machine is fully enforced; `PAUSED`/`RESUMING` have limited consumers.** All 7 states are wired into validation and teardown (`getStorylessCloseChain` recovers from `PAUSED`/`RESUMING` on cleanup). But only queue PAUSE/RESUME flows transition *into* `PAUSED`/`RESUMING`; rectification loops re-enter `RUNNING` directly. This is the intended shape (loops don't pause; user control does), but means four of seven states are exercised on narrow paths. The transition map is cheap to keep correct and expensive to re-derive, so spec'ing all seven states up front is preserved as a forward investment.

- **Path serialization is relative on disk.** Persisted `descriptor.json` and `context-manifest-*.json` path fields are stored relative to `projectDir` for cross-machine portability; loaders rehydrate to absolute paths at read time. Consumers must not read raw JSON directly — go through the descriptor accessor.

- **Plugin-provided adapters.** External adapters implementing `AgentAdapter` must also implement `closePhysicalSession` and `deriveSessionName`. Absent implementations surface as `TypeError` at wiring time (not silent no-op); the adapter-wiring rule at [.claude/rules/adapter-wiring.md](../../.claude/rules/adapter-wiring.md) is the contract.

### Scope of Changes

| File | Change |
|:---|:---|
| `src/session/manager.ts` | New file — `SessionManager` class, 7-state machine, `runInSession` primitive |
| `src/session/types.ts` | `SessionState`, `SessionRole`, `SessionDescriptor`, `ISessionManager`, `SESSION_TRANSITIONS` |
| `src/session/scratch-purge.ts` | `purgeStaleScratch()` — AC-20 retention |
| `src/session/session-runner.ts` | `ISessionRunner` — ADR-013 |
| `src/execution/session-manager-runtime.ts` | `closeStorySessions`, `closeAllRunSessions`, `failAndClose`, `getStorylessCloseChain` — orchestration helpers outside the manager to avoid protocol coupling |
| `src/execution/runner.ts` | Creates the single `SessionManager` per run; threaded via `PipelineContext` |
| `src/execution/lifecycle/run-setup.ts` | Calls `sweepOrphans` at run start |
| `src/execution/lifecycle/run-completion.ts` | Calls `closeAllRunSessions` + `purgeStaleScratch` at run end |
| `src/agents/types.ts` | `AgentRunOptions.session?: SessionDescriptor`; `AgentAdapter.closePhysicalSession(handle, workdir, options?: { force?: boolean })`; `AgentAdapter.deriveSessionName(descriptor)`; `keepOpen` narrowed to adapter-internal use |
| `src/agents/acp/adapter.ts` | Uses `session` descriptor when present; sidecar writes removed (issue #477) |
| `src/pipeline/stages/execution.ts` | Delegates to `SingleSessionRunner`/`ThreeSessionRunner`; calls `failAndClose` on terminal failure |
| `src/pipeline/types.ts` | `PipelineContext.sessionManager`, `ctx.sessionId` |
| `docs/adr/ADR-008-session-lifecycle.md` | Marked as refined by ADR-011 — policy retained |

### Not Changed

- ADR-008's per-role policy matrix (kept verbatim — see §Mapping).
- Adversarial vs. semantic reviewer session reset rules (still one reviewer session per `runReview()` call chain, closes by end of call).
- Implementer session continuity across TDD → autofix → rectification (ADR-007 rules carried into ADR-008 §6 still apply).
- `complete()` one-shot call sites — no session lifecycle concept applies.

---

## Implementation Status (2026-04-23)

| Item | Status |
|:---|:---|
| `SessionManager` with 7-state FSM | Implemented |
| `runInSession` primitive | Implemented (ADR-013 Phase 1) |
| Eager `onSessionEstablished` handle binding | Implemented (#591) |
| `failAndClose` + force-terminate on FAILED | Implemented (H-1 fix) |
| Orphan sweep at run setup | Implemented |
| Adapter sidecar removal | Completed (#477) |
| Cross-run session resume | Deferred — disk format in place, no consumer yet |
| External adapter (Codex/Gemini) port | Pending — contract stable |

---

## References

- [ADR-008](./ADR-008-session-lifecycle.md) — session lifecycle policy (refined by this ADR)
- [ADR-013](./ADR-013-session-manager-agent-manager-hierarchy.md) — `runInSession` primitive and `ISessionRunner`
- `docs/specs/SPEC-session-manager-integration.md` — mechanism spec (interface changes, migration phases)
- `docs/specs/SPEC-context-engine-v2-amendments.md` Amendment D — motivating requirement (scratch, handoff, protocol IDs)
- `docs/specs/SPEC-context-engine-agent-fallback.md` — AC-42 scratch neutralization, AC-83 force-terminate
- [src/session/manager.ts](../../src/session/manager.ts) — implementation
- [src/execution/session-manager-runtime.ts](../../src/execution/session-manager-runtime.ts) — `failAndClose`, `closeAllRunSessions`
- `docs/reviews/context-engine-v2-deep-review-2026-04-18.md` — H-1 finding that surfaced the missing FAILED transition
- [.claude/rules/adapter-wiring.md](../../.claude/rules/adapter-wiring.md) — session role registry
