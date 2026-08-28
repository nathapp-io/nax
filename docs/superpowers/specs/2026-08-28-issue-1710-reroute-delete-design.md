# Issue #1710 — Hybrid post-escalation LLM re-route: delete, do not wire

**Issue:** https://github.com/nathapp-io/nax/issues/1710
**Status:** Plan only — implementation requires separate go-ahead.
**Branch:** `fix/1710-hybrid-post-escalation-llm-reroute-delete`
**Base:** `origin/main` @ `eefe9ef09781ebf1be2624429046c93cd0ba200e`

## Summary

`handleTierEscalation` and `preIterationTierCheck` both call `tryLlmBatchRoute` in a `routingMode === "hybrid"` branch. The call sites were written on the assumption that `runtime` would be threaded into the handler context, but the only caller never passed it, so both calls have been guaranteed no-ops since the day they were written.

PR #1707 (already on main) added `runtime: ctx.runtime` to the caller of `handleTierEscalation` for an unrelated reason (the cost aggregator in `tier-outcome.ts`). That threading is the only thing still keeping the `tryLlmBatchRoute` calls inert at the pipeline site — `preIterationTierCheck` still passes nothing for `runtime`, but the call is already guarded out earlier by `tryLlmBatchRoute`'s `needsRouting` filter.

Activating these call sites is a billable behaviour change:

- `tryLlmBatchRoute` dispatches `classifyRouteBatchOp` — an LLM call — per call.
- `resolveOperatingTier` already makes the escalated tier authoritative, so the re-route cannot change the tier; its only practical effect on a real escalation is to clobber the ladder's deliberate `testStrategy` downgrade (`three-session-tdd-lite` / `tdd-simple`) via the cache-hit path in `resolveRouting`.
- For routing-less stories (the only ones `needsRouting` lets through — INJECT-ed non-lead batch members), activation does no useful work, costs money on every attempt, and writes a `StoryRouting` missing the type-required `complexity`, permanently re-classifying the story on each subsequent escalation.

**Decision: delete both call sites rather than wire `runtime`.** A comment is the only thing keeping the live path inert; deleting it removes a tripwire that would otherwise be triggered by what looks like routine tidy-up (e.g. spreading `ctx` into the call).

## Hand-off brief — original (superseded)

The hand-off brief in the issue body and the first two comments is wrong in one mechanical way:

- It says "EscalationHandlerContext.runtime is optional, and the only caller never passed it."
- That is no longer true. `runtime: ctx.runtime` was threaded at `src/execution/pipeline-result-handler.ts:450` in commit `0492c8000` (PR #1707). The only thing still keeping the pipeline call site inert is the explicit comment `// runtime deliberately NOT forwarded — would activate a billable re-route. See #1710.` at `src/execution/escalation/tier-escalation.ts:587`.

The conclusion (delete) stands and is better supported by the corrected analysis. See the comment chain on the issue for the full trace.

## Mechanical changes

### File: `src/execution/escalation/tier-escalation.ts`

All line numbers refer to `origin/main` @ `eefe9ef09`. They drift by ±1 from the hand-off brief — use the actual file, not the brief, when applying.

1. **Delete** the hybrid re-route block at **L254–260** (the `"hybrid-re-route"` site inside `preIterationTierCheck`):

   ```ts
   // Hybrid mode: re-route story after escalation
   if (routingMode === "hybrid") {
     await tryLlmBatchRoute(config, [story], "hybrid-re-route", {
       agentManager: undefined,
       runtime: undefined,
     });
   }
   ```

2. **Delete** the hybrid re-route block at **L583–589** (the `"hybrid-re-route-pipeline"` site inside `handleTierEscalation`):

   ```ts
   // Hybrid mode: re-route escalated stories
   if (routingMode === "hybrid") {
     await tryLlmBatchRoute(ctx.config, storiesToEscalate, "hybrid-re-route-pipeline", {
       agentManager: ctx.agentManager,
       // runtime deliberately NOT forwarded — would activate a billable re-route. See #1710.
     });
   }
   ```

3. **Delete** the now-unused local `const routingMode = config.routing?.llm?.mode ?? "hybrid";` at **L181** (inside `preIterationTierCheck`). It had exactly one reader at L255, deleted in step 1.

4. **Delete** the now-unused local `const routingMode = ctx.config.routing.llm?.mode ?? "hybrid";` at **L453** (inside `handleTierEscalation`). It had exactly one reader at L584, deleted in step 2.

5. **Delete** the unused import at **L18**:

   ```ts
   import { tryLlmBatchRoute } from "@/routing";
   ```

6. **Replace** the stale cache-invalidation comment at **L246–252** with a short note recording the ruling (no LLM re-route, ladder's `testStrategy` choice is authoritative, link to this issue):

   ```ts
   // No routing-cache invalidation needed. Escalation does not LLM-re-route
   // (see #1710); tier is deterministic and ladder's testStrategy is authoritative.
   ```

7. **Replace** the stale comment at **L577–581** (just above the now-deleted L583–589 block) with the same one-line ruling, pointing to #1710. After step 2 the surrounding context is just the `await savePRD(updatedPrd, ctx.prdPath)` at L575 followed by `pipelineEventBus.emit(...)` at L591; the comment can be one or two lines.

   ```ts
   // Escalation does not LLM-re-route; tier is deterministic. See #1710.
   ```

### Files explicitly NOT changed

- `src/routing/router.ts` — `tryLlmBatchRoute` itself stays live. The run-start call site at `src/execution/runner-execution.ts:171` (`"routing"`) is correct and routes genuinely-routing-less stories at run start.
- `src/execution/runner-execution.ts` — no change.
- `src/execution/pipeline-result-handler.ts` — no change. `runtime: ctx.runtime` at L450 is correct and is not touched.
- `EscalationHandlerContext` type — no change. `runtime` is already passed by #1707 (`pipeline-result-handler.ts:450`); threading it again would activate the billable re-route this PR deletes.
- `src/prd/inject.ts` — separate defect, tracked as #1745. Fixing it would make this call site unreachable *again* (via the `complexity` guard), but the deletion here stands on its own.
- `test/unit/execution/escalation/tier-outcome.test.ts` — L114 contains a comment that says "caller of handleTierEscalation never passed `runtime`, so the fallback was taken", which is now stale (the call site does pass `runtime` since #1707). **Out of scope for this PR** — the test's behaviour assertions are still correct because the `?? ctx.totalCost` fallback path is unchanged; only the *reason* it was taken at the time the test was written is stale. Flag in the PR description; clean up in a follow-up if desired.

## Tests to add

Per the corrected hand-off brief (issue comment #2), the original test wording would have passed vacuously against the `needsRouting` guard. The reachable case is specifically: **batch escalation + non-lead member with `routing: undefined` + non-null runtime in context + `routing.strategy: "llm"` + `hybrid`**.

**Recommended placement:** new sibling file `test/unit/execution/escalation/tier-escalation-reroute-delete.test.ts`. The main `tier-escalation.test.ts` is already 1000+ lines — past the project's 400-line file cap. Fallback: append to `tier-escalation.test.ts` only if explicitly preferred.

### Test 1 — Regression guard (the regression #1707's threading would otherwise have introduced)

```ts
describe("#1710 — handleTierEscalation does not LLM-re-route even when reachable", () => {
  test("batch escalation with a routing-less non-lead member and a non-null runtime does not dispatch classifyRouteBatchOp", async () => {
    // Build a batch of 2: lead story has routing.complexity + testStrategy;
    // non-lead has routing === undefined (the #1745 reachable case).
    // routing.strategy === "llm", routingMode === "hybrid" (defaults).
    // Pass a non-null ctx.runtime.
    // Spy on _tryLlmBatchRouteDeps or on classifyRouteBatchOp and assert
    // it is never called. assertSpyCalls(spy, 0).
  });
});
```

Pin the *reachable* path — a vacuous test against `needsRouting` proves nothing, which is what the original wording ("a story that escalates in hybrid mode") would have done.

### Test 2 — Tier-precedence guard (pins `resolveOperatingTier` against future cache writers)

```ts
test("escalated tier wins over a lower-tier routingCache entry for the same story id", async () => {
  // Pre-populate the routing cache with a decision that picks a lower tier
  // for the escalating story id.
  // Escalate.
  // Assert the pipeline runs at the escalated tier (e.g. via the story's
  // routing.modelTier, or by spying on resolveRouting/resolveOperatingTier
  // and asserting the escalated tier is the one returned).
});
```

### Test 3 (optional) — Latch characterization

```ts
test("after batch escalation, a previously routing-less non-lead story still has no routing.complexity", async () => {
  // Same setup as Test 1. Run escalation.
  // Assert the non-lead story's routing is still missing complexity.
  // This pins the #1745 defect: when #1745 lands, this test will fail
  // and should be updated rather than deleted.
});
```

Skip Test 3 if deemed low value — it has no bearing on #1710 and is a characterization of a separate defect.

## Verification

Run in order. All must pass before opening the PR.

| Step | Command | Expected |
|------|---------|----------|
| 1 | `bun run typecheck` | clean — especially watch for unused `tryLlmBatchRoute` import, unused `routingMode` locals, unused `routing` field on `EscalationHandlerContext` if it was added speculatively |
| 2 | `bun run lint` | clean — Biome unused-import rule will catch step 5; the rest should be deletions-only |
| 3 | `bun test test/unit/execution/escalation/` | existing + new tests green |
| 4 | `bun test test/unit/routing/llm-batch-route.test.ts` | green — should not regress; `tryLlmBatchRoute` itself is unchanged |
| 5 | `bun test test/unit/routing/` | green — `operating-tier.test.ts` covers `resolveOperatingTier` precedence, which Test 2 also pins |
| 6 | `bun run test:bail` | full suite green |
| 7 | `grep -rn "hybrid-re-route" src/` | no matches — proves both call sites are gone, not just one |
| 8 | `grep -rn "routingMode" src/execution/escalation/tier-escalation.ts` | no matches — proves both locals are gone |

If step 8 finds matches, step 3 or 4 was missed.

## Out of scope

- Fixing #1745 (INJECT-ed stories carry no `routing`). Separate defect, separate PR.
- Threading `runtime` into `EscalationHandlerContext` for `tier-outcome.ts`'s cost aggregator (already done by #1707; no further work needed).
- Updating the stale comment in `test/unit/execution/escalation/tier-outcome.test.ts:114`. Behaviour is unchanged; only the historical justification is stale. Mention in the PR description; do not change here.
- Refactoring the comment at `tier-escalation.ts:145-150` (`!tierCfg` budget guard) — unrelated, do not touch.

## Commit strategy

Single commit on `fix/1710-hybrid-post-escalation-llm-reroute-delete`:

```
fix(escalation): delete inert hybrid post-escalation LLM re-route (#1710)

tryLlmBatchRoute in preIterationTierCheck (L254-260) and
handleTierEscalation (L583-589) has been a guaranteed no-op since
written — and PR #1707's runtime threading left the pipeline call
site one tidy-up away from activating a billable classifyRouteBatchOp
per escalation that, in the one reachable case (INJECT-ed non-lead
batch members, #1745), would clobber the ladder's deliberate
testStrategy downgrade.

Delete both call sites, drop the unused import and the now-dead
routingMode locals, replace the stale "routing cache invalidation
not needed" comments with a short ruling pointing to #1710, and
pin the invariants with two regression tests.

tryLlmBatchRoute itself and the run-start call site at
runner-execution.ts:171 are unchanged. #1745 is unchanged.
```

Implementation is one commit. Tests may land in the same commit or be split into a preceding commit (`test(escalation): pin #1710 invariants before deletion`) if reviewer preference; recommend single commit for atomicity.

## PR description

- Title: `fix(escalation): delete inert hybrid post-escalation LLM re-route (#1710)`
- Body: link the issue, link the spec (`docs/superpowers/specs/2026-08-28-issue-1710-reroute-delete-design.md`), summarise the corrected analysis (issue comment #2 supersedes the body and comment #1), list the tests added, flag the stale comment in `tier-outcome.test.ts:114` as a follow-up consideration, link #1745 as the related separate defect.

## Evidence trail

- Issue body + 4 comments: https://github.com/nathapp-io/nax/issues/1710
- Comment #1 (original hand-off): conclusion correct, one stale premise about runtime threading
- Comment #2 (correction): corrects comment #1's two wrong claims, supersedes with stronger reasoning
- Comment #3: links separate defect #1745
- Comment #4: notes #1707 already threaded `runtime` on main, frames deletion as removing a live tripwire
- Relevant commits on main: `0492c8000` (#1707 → #1711), `eefe9ef09` (current main HEAD)
