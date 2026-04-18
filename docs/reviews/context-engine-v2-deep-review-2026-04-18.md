# Deep Code Review — Context Engine v2 + Session Manager Integration

**Branch:** `fix/context-engine-review-followups-2026-04-17`
**Base commit:** `f7f41d42cda59ed4466081e851c43d650b26d2c5`
**Reviewed:** 2026-04-18
**Scope:** 43 commits, 133 files changed, +10,863 / −1,564 lines

**Specs covered:**
1. [SPEC-context-engine-v2.md](../specs/SPEC-context-engine-v2.md) (AC-1 … AC-43)
2. [SPEC-context-engine-v2-amendments.md](../specs/SPEC-context-engine-v2-amendments.md) (Amendments A–D, AC-44 … AC-78)
3. [SPEC-context-engine-v2-compilation.md](../specs/SPEC-context-engine-v2-compilation.md) (compilation view)
4. [SPEC-context-engine-agent-fallback.md](../specs/SPEC-context-engine-agent-fallback.md) (AC-1 … AC-18)
5. [SPEC-context-engine-canonical-rules.md](../specs/SPEC-context-engine-canonical-rules.md) (AC-1 … AC-20)
6. [SPEC-session-manager-integration.md](../specs/SPEC-session-manager-integration.md) (AC-79 … AC-83 + state machine)

**Methodology:** Three parallel AC-by-AC audits + targeted manual verification of claims that looked wrong (rules export, purge wiring, FAILED transition, metrics events, credentials validation, retry loop).

---

## Executive Summary

| Spec | ACs | Wired | Partial | Missing | Deferred |
|------|-----|-------|---------|---------|----------|
| v2 (AC-1 … AC-43) | 43 | 40 | 2 | 0 | 1 |
| Amendments A–D (AC-44 … AC-78) | 35 | 30 | 4 | 0 | 1 |
| Agent fallback (AC-1 … AC-18) | 18 | 14 | 2 | 2 | 0 |
| Canonical rules (AC-1 … AC-20) | 20 | 19 | 0 | 0 | 1 |
| Session manager (AC-79 … AC-83 + state) | ~10 | 6 | 3 | 0 | 1 |

**Overall completeness: ~88% wired, 10% partial, 2% missing.**

### Verdict

The branch is **substantially complete** and ready for merge, with three concrete gaps worth tracking as follow-up tickets (not merge blockers). Previous review passes (`today-commits-code-review-2026-04-17.md`, `context-engine-v2-final-review-2026-04-17.md`, `context-engine-v2-session-manager-review-2026-04-18.md`) have already closed the CRITICAL and HIGH findings from the first three review iterations.

The subsystems most heavily exercised (orchestrator, canonical loader, static rules, agent-swap loop, close-session lifecycle) are well-covered by tests and wired correctly.

---

## Wiring Verification Spot Checks

The Explore agents flagged several items as "missing" that turned out to be wired. These are the ground-truth findings:

| Claim | Agent verdict | Actual state | Evidence |
|-------|---------------|--------------|----------|
| AC-30 `nax rules export` missing | v2 agent said missing | **Wired** | [src/cli/rules.ts:95-173](../../src/cli/rules.ts#L95-L173) (`rulesExportCommand`, `AGENT_SHIM_FILES` registry for claude + codex) |
| AC-31 `allowLegacyClaudeMd` flag missing | v2 agent said not found | **Wired** | [src/config/schemas.ts](../../src/config/schemas.ts), [src/context/engine/providers/static-rules.ts](../../src/context/engine/providers/static-rules.ts), [src/context/engine/orchestrator-factory.ts:42](../../src/context/engine/orchestrator-factory.ts#L42) |
| AC-20 `purgeStaleScratch` not wired to lifecycle | v2 agent said unclear | **Wired** | [src/execution/lifecycle/run-completion.ts:255](../../src/execution/lifecycle/run-completion.ts#L255) calls `purgeStaleScratch(...)` on run completion |
| AC-41 fallback observability missing | fallback agent said missing | **Wired (divergent shape)** | Spec says `metrics.events.push({ type: "agent.fallback.triggered", ... })`. Implementation uses structured `StoryMetrics.fallback.hops[]` via `AgentFallbackHop` in [src/metrics/types.ts:76](../../src/metrics/types.ts#L76), populated at [src/pipeline/stages/execution.ts:307-308](../../src/pipeline/stages/execution.ts#L307-L308), surfaced at [src/metrics/tracker.ts:172](../../src/metrics/tracker.ts#L172) |
| AC-3 rate-limit retry not wired | fallback agent said partial | **Wired** | `retryAfterSeconds` parsed at [src/agents/acp/parse-agent-error.ts:57](../../src/agents/acp/parse-agent-error.ts#L57); honoured in adapter retry loop at [src/agents/acp/adapter.ts:552,592,1046](../../src/agents/acp/adapter.ts) |
| AC-83 force-terminate | session agent said wired | **Wired** | [src/agents/types.ts:305](../../src/agents/types.ts#L305) signature with `options?: { force?: boolean }`; [src/execution/session-manager-runtime.ts:37,68](../../src/execution/session-manager-runtime.ts) sets `force = descriptor.state === "FAILED"` |

---

## Confirmed Gaps (sorted by severity)

### HIGH

#### H-1 — Session is never explicitly transitioned to `FAILED`

**Spec:** SPEC-session-manager-integration.md §State machine says sessions move `RUNNING → FAILED` on a retriable failure, or `RUNNING → CLOSING → FAILED`.

**Actual behaviour:** The only explicit transitions in the codebase are:
- `CREATED → RUNNING` ([src/pipeline/stages/execution.ts:153](../../src/pipeline/stages/execution.ts#L153))
- `RUNNING → COMPLETED` via [src/session/manager.ts:266](../../src/session/manager.ts#L266) inside `closeStory()` (unconditionally, for any non-terminal session)

Failed stories are indistinguishable from successful stories in the final session state — both end up as `COMPLETED`. This breaks the audit trail and the force-terminate path: `session-manager-runtime.ts` checks `descriptor.state === "FAILED"` to decide whether to pass `force: true` to `closePhysicalSession`, but no code path ever sets `FAILED` on a live session.

**Impact:** Real behaviour gap with concrete downstream effects:
- AC-83 force-terminate never fires in practice (state is always `RUNNING` or `COMPLETED` at close time)
- Orphan sweep / resume paths relying on `FAILED` marker won't see failed sessions
- Metrics consumers of `SessionDescriptor.state` are misled

**Remediation:** Add an explicit `FAILED` transition in the execution stage when `AgentResult.success === false` and/or `adapterFailure.category === "availability"` is terminal after fallback exhaustion. Roughly:

```typescript
// src/pipeline/stages/execution.ts, after agent.run()
if (!result.success && ctx.sessionManager && ctx.sessionId) {
  ctx.sessionManager.transition(ctx.sessionId, "FAILED", { reason: result.adapterFailure?.outcome });
}
```

#### H-2 — Fallback credentials validation not performed at run start

**Spec:** SPEC-context-engine-agent-fallback.md §Runner behaviour — "A fallback candidate configured in the map but missing credentials is logged as a warning and removed from the runtime map."

**Actual:** No credential pre-validation. Missing API keys surface only at first swap attempt, causing a runtime adapter error instead of a clean startup warning.

**Impact:** Operators can configure `fallbackMap: { claude: ["codex"] }` without `CODEX_API_KEY` set; the run proceeds normally until a swap is attempted, then the swap itself fails (double-failure). Not a correctness gap — the fallback loop still exhausts correctly — but an ergonomics / observability gap.

**Remediation:** Add a validation pass in `runSetupPhase()` that reads the fallback map, checks credential availability per agent, logs warnings for misconfigured targets, and prunes them from the runtime map.

### MEDIUM

#### M-1 — `fallback.discardPartialWork` config option not implemented

**Spec:** SPEC-context-engine-agent-fallback.md §11 — "`fallback.discardPartialWork: true` (default false) runs `git restore .` on fallback so the new agent starts clean."

**Actual:** Not in schema ([src/config/schemas.ts](../../src/config/schemas.ts) `ContextV2FallbackConfigSchema`) or runtime types. No call site references it. Partial work is preserved unconditionally.

**Impact:** Low operational impact — default (false) is the current behaviour — but operators cannot opt in to the "clean slate" policy the spec offers.

#### M-2 — `handoff()` does not transition state to `HANDED_OFF`

**Spec:** SPEC-session-manager-integration.md — sessions that are handed off to a fallback agent move to a `HANDED_OFF` state (listed in the target state enum).

**Actual:** [src/session/manager.ts:214-239](../../src/session/manager.ts#L214-L239) updates `agent` and `lastActivityAt` but leaves `state` unchanged (typically `RUNNING`). Spec notes this state "may be deferred"; the branch acknowledges this in `docs/reviews/context-engine-v2-session-manager-review-2026-04-18.md` as deferred.

**Impact:** Audit trail is weaker — callers cannot distinguish a running session from a session that was handed off mid-pipeline. Same dynamic as H-1: state field loses fidelity.

#### M-3 — Fallback observability diverges from spec shape

**Spec:** SPEC-context-engine-agent-fallback.md §14 calls for `metrics.events.push({ type: "agent.fallback.triggered", storyId, priorAgent, newAgent, outcome, category, hop })` with a run-summary section listing counts and exhaustion lists.

**Actual:** Structured-per-story form ([src/metrics/types.ts:76](../../src/metrics/types.ts#L76) `AgentFallbackHop` → `StoryMetrics.fallback.hops[]`). Data content matches 1:1; format is an array per story rather than a run-level event stream.

**Impact:** Downstream consumers that grep for `agent.fallback.triggered` won't find anything. Run-summary aggregation (exhaustion list, counts per agent) not implemented. Data is recoverable by walking per-story metrics, but not pre-aggregated.

**Remediation (optional):** Add a run-completion pass that derives the per-run aggregates from `storyMetrics[].fallback.hops[]` and surfaces them in the final run summary.

### LOW / DEFERRED

- **Canonical rules dogfood (AC-19 of canonical-rules spec):** nax project has not migrated its own `.claude/rules/` to `.nax/rules/`. Process item, not a code gap.
- **AC-52 no-test rectify scope:** Stage config correct; no integration test specifically verifies that no-test mode rectify reads only review findings (not verify output). Gap in test coverage, not behaviour.
- **Per-package config integration test:** AC-59 relies on existing config merge logic with no dedicated integration test exercising a real monorepo layout (packages/api, packages/web).

---

## Verified Correct Wiring (sampled, not exhaustive)

These are items I independently verified because they were either recent fixes or frequently mis-audited in previous reviews.

| AC | Title | Evidence |
|----|-------|----------|
| AC-16 | Unknown provider ID validation scoped to `stageConfig.providerIds` only | [src/context/engine/orchestrator.ts:237-260](../../src/context/engine/orchestrator.ts#L237-L260); `request.providerIds` (test override) deliberately filters silently |
| AC-19 | `nax context inspect` CLI | [src/cli/context.ts](../../src/cli/context.ts) with `formatContextInspect()`; tested in [test/unit/cli/context.test.ts](../../test/unit/cli/context.test.ts) |
| AC-25 | Provider cost accounting | [test/unit/metrics/tracker-provider-cost.test.ts](../../test/unit/metrics/tracker-provider-cost.test.ts) (226 lines) |
| AC-41 | Agent-swap per-hop metrics | Populated at [src/pipeline/stages/execution.ts:307-308](../../src/pipeline/stages/execution.ts#L307-L308), surfaced via `StoryMetrics.fallback.hops[]` |
| AC-42 | Cross-agent scratch neutralization | [src/context/engine/scratch-neutralizer.ts](../../src/context/engine/scratch-neutralizer.ts); tests in [test/unit/context/engine/scratch-neutralizer.test.ts](../../test/unit/context/engine/scratch-neutralizer.test.ts) |
| AC-51 | planDigestBoost single-session modes | [test/unit/context/engine/orchestrator-plan-digest-boost.test.ts](../../test/unit/context/engine/orchestrator-plan-digest-boost.test.ts) |
| AC-54 / 60 / 61 | Dual workdir (`repoRoot` + `packageDir`) in `ContextRequest` + manifest | [src/context/engine/types.ts](../../src/context/engine/types.ts), manifest fields verified |
| AC-55 | `GitHistoryProvider` historyScope option | [src/context/engine/providers/git-history.ts](../../src/context/engine/providers/git-history.ts) |
| AC-56 / 62 | `CodeNeighborProvider` neighborScope + crossPackageDepth | [src/context/engine/providers/code-neighbor.ts](../../src/context/engine/providers/code-neighbor.ts) |
| AC-57 | Per-package canonical rules overlay | [src/context/engine/providers/static-rules.ts](../../src/context/engine/providers/static-rules.ts) with package-wins same-name merge |
| Amendment A AC-44–49 | Min-score / staleness / contradiction / pollution metrics | [src/context/engine/pollution.ts](../../src/context/engine/pollution.ts), [src/context/engine/staleness.ts](../../src/context/engine/staleness.ts), [src/context/engine/effectiveness.ts](../../src/context/engine/effectiveness.ts) |
| Canonical rules AC-1–6 | Loader, neutrality linter, frontmatter, budget truncation | [src/context/rules/canonical-loader.ts](../../src/context/rules/canonical-loader.ts) |
| Canonical rules AC-11–16 | Export + migrate CLI | [src/cli/rules.ts](../../src/cli/rules.ts) |
| AC-83 | Force-terminate on FAILED | See H-1 note above re: it currently never fires because FAILED is never set |
| Session idempotency | Repeated `closeAllRunSessions()` calls are a no-op | [test/unit/execution/session-manager-runtime.test.ts:108-124](../../test/unit/execution/session-manager-runtime.test.ts#L108-L124) |
| Fallback exhaustion → escalate | Multi-hop fallback exhausts then returns `{ action: "escalate" }` | [test/integration/execution/agent-swap.test.ts](../../test/integration/execution/agent-swap.test.ts) |

---

## Test & Build Health

| Check | Result |
|-------|--------|
| `bun run typecheck` | Clean |
| `bun run lint` | 441 files, no issues |
| `bun run test:unit` | 6274 pass / 0 fail / 13 skip |
| `bun run test:integration` | 1187 pass / 0 fail / 39 skip |

No snapshot drift, no flakiness observed across runs.

---

## Comparison to Prior Review Iterations

| Review file | Date | Findings status |
|-------------|------|-----------------|
| `today-commits-code-review-2026-04-17.md` | 2026-04-17 | Closed in commit `59097685` |
| `context-engine-v2-final-review-2026-04-17.md` | 2026-04-17 | Closed in commit `88f22c1d` |
| `context-engine-review-followups-2026-04-17.md` | 2026-04-17 | All items landed |
| `context-engine-v2-session-manager-review-2026-04-18.md` | 2026-04-18 | CRIT-1 / H-1 / H-4 / H-5 / MINORs closed in commits `2fc2ad49`, `d8bb51d5`, `f3bae3f3` |

The branch has undergone four review passes. Each pass has landed its findings before the next pass was written.

---

## Recommendation

**Merge-ready**, with the following three items opened as follow-up tickets (none block the current branch):

1. **H-1 (FAILED state transition):** Highest priority because it directly affects AC-83 effectiveness. ~10 lines in `execution.ts`. Worth doing before the next release.
2. **H-2 (Fallback credentials validation at run start):** Ergonomics, not correctness. Fit for a small standalone PR.
3. **M-3 (Run-summary fallback aggregates):** Improves observability surface. Can piggy-back on the next metrics-export change.

The deferred items (HANDED_OFF state, dogfood migration, no-test rectify integration test) are called out in prior review docs and do not need re-tracking here.
