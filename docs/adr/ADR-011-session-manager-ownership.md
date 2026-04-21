# ADR-011: Session Manager Ownership

**Status:** Proposed
**Date:** 2026-04-18
**Author:** William Khoo, Claude
**Partially supersedes:** ADR-008 — policy retained, `keepSessionOpen` primitive replaced by state-machine transitions (see §Mapping).

---

## Context

ADR-008 decided *when* a session should stay warm per role (reviewer verdicts are independent, implementer iterations are stateful). That decision is still correct, but its primitive — `keepSessionOpen: boolean` passed from pipeline stage to adapter — has accumulated load it was not designed to carry.

As nax added availability fallback, scratch-based context transfer, crash recovery, and cross-adapter portability (SPEC-context-engine-v2 Amendment D, SPEC-context-engine-agent-fallback, SPEC-session-manager-integration), the adapter has ended up owning:

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
  - Close / resume / handoff decisions         - protocol-level retry on
  - Orphan detection (state-based)               QUEUE_DISCONNECTED (AC-79)
  - Agent-agnostic session naming
  - Prompt audit policy + file writing         Does NOT own:
    (src/session/audit.ts + audit-writer.ts)     - session lifecycle decisions
    See: docs/specs/SPEC-session-manager-audit.md - crash detection
                                                 - sidecar files
                                                 - prompt audit (reports via callback)

Does NOT own:
  - acpx process
  - protocol-level retry
```

### State machine (7 states, terminal = COMPLETED | FAILED)

```
CREATED → RUNNING → { PAUSED | COMPLETED | FAILED | CLOSING }
PAUSED  → { RESUMING | FAILED }
RESUMING → { RUNNING | FAILED }
CLOSING → { COMPLETED | FAILED }
```

Transitions are validated by the manager (`SESSION_TRANSITIONS` map). Terminal states cannot transition further.

### Mapping ADR-008 policy to new primitives

The per-role policy matrix from ADR-008 maps directly onto state transitions:

| ADR-008 primitive | New primitive |
|:---|:---|
| `keepSessionOpen: true` after call | Stage does not transition to COMPLETED; caller may transition to PAUSED for mid-task pause, or leave RUNNING for the next call in the same pipeline |
| `keepSessionOpen: false` after call | Stage transitions to COMPLETED at end of the call |
| Reviewer "initial: true / retry: false" | Initial call leaves session RUNNING; JSON-retry transitions to COMPLETED |
| Rectifier `!isLastAttempt` | All but last attempt leave RUNNING; last transitions to COMPLETED |
| Escalation (new tier) | Current session transitions to FAILED; manager creates a fresh session for the next tier |

The policy from ADR-008 is preserved verbatim. The change is the encoding: decisions are now explicit state transitions at call sites instead of a boolean the adapter interprets.

### New architectural decisions (not in ADR-008)

1. **Run-level centralization.** One `SessionManager` per run, threaded via `PipelineContext`. Sessions do not persist across runs in Phase 0; `index.json` is rewritten at run start.
2. **AC-83 force-terminate on FAILED.** Adapter's `closePhysicalSession(handle, workdir, options?: { force?: boolean })` is the only way to hard-terminate. The runtime helper `session-manager-runtime.ts` sets `force = descriptor.state === "FAILED"`.
3. **Orphan detection via state, not mtime.** `sweepOrphans(ttlMs)` walks `index.json` for sessions in non-terminal states older than TTL. Replaces the sidecar-mtime heuristic. Deterministic and adapter-agnostic.
4. **Handoff preserves session identity.** `manager.handoff(id, newAgent)` updates the `agent` field but keeps `id`, `handle`, and `scratchDir` stable. The new agent inherits scratch history (with cross-agent neutralization, AC-42). Supports availability fallback without losing story context.
5. **Explicit fail-and-close at point of terminal failure.** Because `listActive()` excludes terminal sessions, a failed session must be physically closed at the moment of transition — teardown will not see it. The `failAndClose(sessionManager, sessionId, agentGetFn)` helper performs transition + force-close atomically.

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

---

## Consequences

### Positive

- **Adapter stays thin.** Codex / Gemini adapters implement `run()`, `complete()`, `closePhysicalSession()`, and `deriveSessionName()`. No state machine, no sidecar, no crash heuristic.
- **Pipeline has a stable handle.** `ctx.sessionId` is constant across a story; audits, metrics, scratch, and handoff all hang on it.
- **Availability fallback works.** Handoff preserves `scratchDir` and session identity; the new agent picks up from where the old agent left off.
- **Force-terminate is reachable.** Explicit transition to FAILED + `failAndClose` guarantees AC-83 fires. Previously unreachable (see SPEC-session-manager review H-1).
- **Orphan detection is deterministic.** State-based; no mtime races.

### Negative / Trade-offs

- **Two layers of cleanup.** A failed session is physically closed at the point of failure (`failAndClose`), AND run-completion teardown runs `closeAllRunSessions()`. The second is a no-op for already-FAILED sessions but must be correct under that assumption. Documented; tested.
- **`keepSessionOpen` removal is a breaking change to `AgentRunOptions`.** Migration: old callers keep passing the flag during Phase 0 dual-write; it is ignored when a `session: SessionDescriptor` is present. Phase 5.5 removes the old parameter entirely. Captured in SPEC-session-manager-integration Interface Changes.
- **State machine is enforceable but not enforced everywhere yet.** Only `CREATED → RUNNING` and implicit `RUNNING → COMPLETED` (via `closeStory`) are wired on main. The explicit `RUNNING → FAILED` transition is new in the H-1 fix. `PAUSED` / `RESUMING` are spec'd but not consumed by any call site yet (Phase 1+).

### Scope of Changes

| File | Change |
|:---|:---|
| `src/session/manager.ts` | New file — `SessionManager` class, 7-state machine |
| `src/session/types.ts` | `SessionState`, `SessionRole`, `SessionDescriptor`, `ISessionManager` |
| `src/session/scratch-purge.ts` | `purgeStaleScratch()` — AC-20 retention |
| `src/execution/session-manager-runtime.ts` | `closeStorySessions`, `closeAllRunSessions`, `failAndClose` — orchestration helpers outside the manager to avoid protocol coupling |
| `src/execution/runner.ts` | Creates the single `SessionManager` per run; threaded via `PipelineContext` |
| `src/execution/lifecycle/run-completion.ts` | Calls `closeAllRunSessions` + `purgeStaleScratch` at run end |
| `src/agents/types.ts` | `AgentRunOptions.session?: SessionDescriptor`; `AgentAdapter.closePhysicalSession(handle, workdir, options?: { force?: boolean })`; `AgentAdapter.deriveSessionName(descriptor)` |
| `src/agents/acp/adapter.ts` | Uses `session` descriptor when present; legacy path retained during Phase 0 dual-write |
| `src/pipeline/stages/execution.ts` | `CREATED → RUNNING` on start; `failAndClose` on terminal failure |
| `src/pipeline/types.ts` | `PipelineContext.sessionManager`, `ctx.sessionId` |
| `docs/adr/ADR-008-session-lifecycle.md` | Mark as "partially superseded by ADR-011; policy retained, primitive replaced" |

### Not Changed

- ADR-008's per-role policy matrix (kept verbatim — see §Mapping).
- Adversarial vs. semantic reviewer session reset rules (still one reviewer session per `runReview()` call chain, closes by end of call).
- Implementer session continuity across TDD → autofix → rectification (ADR-007 rules carried into ADR-008 §6 still apply).
- `complete()` one-shot call sites — no session lifecycle concept applies.

---

## References

- ADR-008 — session lifecycle policy (partially superseded by this ADR)
- SPEC-session-manager-integration.md — mechanism spec (interface changes, migration phases)
- SPEC-context-engine-v2-amendments.md Amendment D — motivating requirement (scratch, handoff, protocol IDs)
- SPEC-context-engine-agent-fallback.md — AC-42 scratch neutralization, AC-83 force-terminate
- `src/execution/session-manager-runtime.ts` — `failAndClose` implementation (H-1 fix)
- `docs/reviews/context-engine-v2-deep-review-2026-04-18.md` — H-1 finding that surfaced the missing FAILED transition
- `.claude/rules/adapter-wiring.md` — session role registry
