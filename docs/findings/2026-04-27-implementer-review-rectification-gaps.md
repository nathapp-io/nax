# Gaps: Implementer ↔ Rectification ↔ Semantic + Adversarial Review

**Date:** 2026-04-27
**Project under test:** [koda](https://github.com/nathapp-io/koda) — feature branch `feat/memory-phase4-graph-code-intelligence`
**Run date:** 2026-04-26 13:48:36 UTC
**Affected stories:** US-001, US-006
**Status:** Planned — pending sign-off; execution deferred

Two independent gaps observed in the same nax run on koda. Each section below is self-contained and has a phased PR plan. Implementations should be separate PRs in the order listed at the end of the doc.

> **Evidence sources:** Findings cite locally-captured nax audit logs (`logs/prompt-audit/`, `logs/review-audit/`, gitignored). Load-bearing excerpts are inlined as code blocks below so claims are verifiable without local log access.

---

## Gap 1 — Adversarial review keeps moving the goalposts

### Symptom

For US-006, the adversarial reviewer ran 5+ rounds. Each round surfaced a *different* set of "blocking" findings. The implementer fixed the previous round's findings, but had no way to tell whether the next round's NEW findings were:

1. Genuine regressions introduced by the fix
2. Issues the reviewer could have raised the first time but didn't
3. The reviewer simply re-framing the same complaint at a different file/line

Concrete trace summary:

| Round | Timestamp (UTC) | Findings |
|:------|:----------|:---------|
| 1 | 14:22 | 3 errors: dead-code abandonment, missing input validation, e2e test gap |
| 2 | 14:40 | 8 findings (2 errors): auth bypass, NaN guard, redundant if/else, test cleanup, … (none from round 1) |
| 3 | 14:52 | 6 findings: redundant if/else **flagged again** as `error`, test gap re-framed |

Verbatim excerpts from the audit logs (`logs/review-audit/.../us-006-reviewer-adversarial.json`):

**Round 1 (14:22):**
```
[error][abandonment] apps/api/src/state/canonical-state.service.ts:27 —
  CanonicalStateService.getSnapshot is a public @Injectable() method but
  the service is never exposed via a controller or middleware. No consumer
  can reach it — the feature is entirely dead code.
[error][input] apps/api/src/state/canonical-state.service.ts:27 —
  getSnapshot accepts SnapshotQuery without validating projectId is non-empty.
[error][test-gap] test/e2e/api-endpoint/endpoint.e2e.spec.ts:1 —
  No e2e tests exist for this feature. AC#5 (unauthorized projectId) is untested.
```

**Round 2 (14:40):**
```
[error][error-path] apps/api/src/state/state.controller.ts:91 —
  Auth bypass: when actor is undefined (unauthenticated), checkProjectMembership
  is never called, making the endpoint publicly accessible.
[warn][error-path] apps/api/src/state/state.controller.ts:104 —
  parseInt(timeWindowMinutes, 10) has no NaN guard.
[error][test-gap] apps/api/test/e2e/state/canonical-state.e2e.spec.ts:10 —
  E2E test creates a NestJS TestingModule inside beforeEach without cleanup.
[warn][abandonment] apps/api/src/state/state.controller.ts:34 —
  The if/else branches for actorType !== 'agent' and else are literally identical code.
... (4 more findings)
```

**Round 3 (14:52):**
```
[error][error-path] apps/api/src/state/state.controller.ts:34 —
  The if (actorType !== 'agent') branch and the else branch contain identical logic.
  This is dead code. The if branch adds no unique behavior...
[warn][test-gap] apps/api/test/e2e/state/canonical-state.e2e.spec.ts:26 —
  E2E test only covers the 404 path. AC2-5 are never exercised at e2e level.
... (4 more findings)
```

Round 1's flagged issues are not addressed in round 2's verdict — the reviewer moved on. Round 3 re-flags the redundant-branches issue (round 2 also flagged it as `warn`; round 3 escalates to `error`). The loop never converges; eventually rectification budget is exhausted and the story escalates.

### Root cause

[`src/review/adversarial.ts:269-318, 377`](../../src/review/adversarial.ts#L269-L377)

- Each adversarial review opens a **fresh ACP session** and **explicitly closes it** at the end of the call.
- Session name is deterministic (`reviewer-adversarial`), but `closePhysicalSession` is called on every exit path → the next cycle starts cold.
- The next round's prompt is built from scratch with no reference to prior findings.
- **The implementer side, by contrast, has a structured memory mechanism**: `RectifierPromptBuilder.priorFailures(failures)` carries failure context forward as a prompt block ([rectifier-builder.ts:80-84](../../src/prompts/builders/rectifier-builder.ts#L80-L84)). The implementer also runs cold sessions across cycles, but it gets memory via prompt input, not session continuity. The adversarial reviewer has neither.

### Design tension

Two competing goods:

- **Fresh eyes** — a new session re-reads the diff cold and is willing to flag things prior rounds missed. Good when prior rounds were too lenient.
- **Continuity** — a session with memory can verify "issue A is now fixed" rather than treat every round as a new audit. Good when the implementer is making real progress.

Pure kept-session trades fresh eyes for memory. Pure fresh-session trades memory for fresh eyes. The recommended approach grafts memory onto fresh eyes via structured prompt input — same pattern the implementer already uses.

### Recommendation: fresh session + structured prior-findings carry-forward

Each round's prompt gets a `## PRIOR ADVERSARIAL FINDINGS — Round N-1` block:

```
## PRIOR ADVERSARIAL FINDINGS — Round N-1
[error][error-path] state.controller.ts:91 — Auth bypass when actor undefined
[error][test-gap]   canonical-state.e2e.spec.ts:1 — Missing e2e for AC#5

## Verdict required FIRST
For each prior finding, check whether it has been addressed.
Only after that, raise NEW blocking findings.
Do not re-flag a fixed finding with new wording at the same severity.
A NEW finding blocks only if it could not have been raised in round N-1
(i.e. the issue was introduced by the rectification, or is genuinely
distinct from prior findings).
```

### Why this over keep-session-open

| Concern | Kept session | Fresh + structured |
|:---|:---|:---|
| **Cost** | Replays full diff + findings + responses on every turn. By round 4–5 of a complex story: 100K+ tokens per call (~3–5× higher cost). | Fresh diff each round + compact prior-findings block. Stays under 30K consistently. |
| **Anchoring bias** | LLMs have well-documented commitment effects — a session that already issued a verdict tends to defend it rather than revise. Defeats the "fresh eyes" benefit. | Fresh session with explicit memory separates "what's there" from "what did I say before". |
| **Symmetry with implementer** | Implementer doesn't keep sessions across rectification cycles — it carries `priorFailures[]` as a structured prompt block. | Mirrors that pattern. One mechanism, two sides. |
| **Multi-turn dialogue** | Possible, but adversarial is one-shot by design ([adversarial.ts:10](../../src/review/adversarial.ts#L10)) — dialogue lives in the semantic-review path's `ReviewerSession`. | Same — no loss. |

### Phasing — three PRs, only the first is mandatory

| PR | Scope | LOC | Land if… |
|:---|:---|:---|:---|
| 1 | Cache findings in orchestrator; render prior-findings block in next prompt; verdict-first instruction in builder | ~80 | **Always — this is the actual fix** |
| 2 | Add `priorVerdict[]` field to response JSON; log "implementer fixed N/M prior findings" convergence signal; feed verdict back into next implementer rectification prompt | ~60 | If PR 1 deployed but observability/loop-closure desired |
| 3 | Convergence-stall heuristic (escalate when reviewer thrashes — zero new errors AND zero verified fixes for N rounds) | ~40 | Only if PR 1+2 still let runs diverge |

**Recommended sequence**: land PR 1 alone, run it on the next real feature, inspect audit logs, then decide PR 2/3 from data.

### PR 1 — what actually changes

**Three small additions, no response-shape change.**

1. `AdversarialReviewPromptBuilder.priorFindings(findings, roundNumber)` — new builder method that renders the compact block shown above. When called with empty/undefined findings, renders nothing (first round behaves identically to today). The `roundNumber` is interpolated into the block header (`## PRIOR ADVERSARIAL FINDINGS — Round 2` etc.) for audit-log readability.

2. `runAdversarialReview(...)` accepts `priorFindings?: ReviewFinding[]` and `priorRoundNumber?: number`, forwards both to the builder. Signature change is additive; existing callers that don't pass the parameters behave as before.

3. Orchestrator caches per-story state on the `ReviewOrchestrator` instance:

   ```typescript
   private adversarialState = new Map<string, {
     lastFindings: ReviewFinding[];
     roundNumber: number;
   }>();
   ```

   - **Scope:** keyed by `storyId`, lives on the orchestrator instance (lifecycle = one run). Cleared per-story when the story enters review for the first time, **not** on every adversarial call (otherwise cache is wiped before it's read).
   - **Initialization:** entry is created on the first adversarial call for a story with `{ lastFindings: [], roundNumber: 1 }`.
   - **Update rule:** after each `runAdversarialReview` returns, replace `lastFindings` with the just-returned findings (last-call-wins) and increment `roundNumber`.
   - **Clear rule:** on story success/escalation/failure (any terminal exit from the review→rectify loop), delete the entry. Prevents leaks if the orchestrator is reused for a follow-up run.
   - **Parallel execution:** keys are per-story, so concurrent stories don't collide. The `Map` is single-threaded JS; no locking needed.

**The reviewer answers the verdict question naturally inside its existing findings text.** PR 2 is what adds the structured `priorVerdict[]` field — but that's a follow-up, not required to fix the goalpost-moving symptom.

### PR 1 — files touched

- [`src/prompts/builders/adversarial-review-builder.ts`](../../src/prompts/builders/adversarial-review-builder.ts) — new `priorFindings()` builder method + verdict-first task instruction
- [`src/review/adversarial.ts`](../../src/review/adversarial.ts) — accept and forward `priorFindings` parameter
- [`src/review/orchestrator.ts`](../../src/review/orchestrator.ts) — cache last round's findings, thread to next call
- `test/unit/review/adversarial-prior-findings.test.ts` — new test asserting block renders correctly and is suppressed when empty
- Existing snapshot tests — update to cover the new prompt section

### Risks and edge cases

| Risk | Mitigation |
|:---|:---|
| Reviewer ignores the prior-findings block (model doesn't follow instruction) | Goalpost-moving symptom returns. Detectable in audit logs immediately — would trigger PR 3's stall heuristic. Acceptable for PR 1. |
| Prior-findings list grows unboundedly across rounds | Carry only the **most recent round's** findings, not full history. Enforced by last-call-wins cache (replace, don't append). |
| What counts as a "round"? Cycles can re-enter through autofix → verify → review | A "round" = each call to `runAdversarialReview` for a given `storyId`. Cache key is `storyId`. Origin of the cycle (autofix vs fresh review) doesn't matter — the reviewer sees its own immediate prior verdict. |
| Cache leaks across stories in parallel execution | Cache keyed by `storyId` — parallel stories are isolated. `Map` is single-threaded JS, no locking needed. |
| Cache key collisions across feature/run boundaries | Cache lives on the `ReviewOrchestrator` instance, scoped to one run. Cleared on story terminal exit. No cross-run leakage. |
| Orchestrator instance reuse between runs (e.g., a long-lived nax server) | Explicit clear-rule on story terminal exit (success/escalation/failure) prevents stale entries surviving into a new run. |

### Resolved design decisions

1. **Cache location.** ✅ In-memory `Map` on the `ReviewOrchestrator` instance, keyed by `storyId`, lifecycle = one run with explicit clear-on-story-terminal-exit. Persistence to `sessionScratchDir` rejected — adversarial findings have no post-run value, and persistence invites cache-staleness bugs.

2. **Implementer-side feedback loop.** ✅ In-scope as **PR 2**, gated on PR 1 landing first. PR 2 adds the structured `priorVerdict[]` response field, then threads `"reviewer says you fixed X but missed Y"` into the next implementer rectification prompt via [`RectifierPromptBuilder.regressionFailure(...)`](../../src/prompts/builders/rectifier-builder.ts) (the consolidated method introduced by Gap 2's PR 2). Coupling note: Gap 1 PR 2 depends on Gap 2 PR 2 having landed, so the rectifier method exists to extend.

3. **Semantic review parity.** ✅ Out of scope for PR 1. Adversarial only. Reasons:
   - Reported symptom was specifically adversarial (US-006 goalpost-moving)
   - Semantic has `ReviewerSession` dialogue mode ([dialogue.ts](../../src/review/dialogue.ts)) — different memory mechanism (kept session, debate-style)
   - Will revisit if semantic shows the same pattern. Tracked as a follow-up, not a blocker.

4. **Round numbering in the prompt.** ✅ Numeric. The cache holds `{ lastFindings, roundNumber }`; the block header reads `## PRIOR ADVERSARIAL FINDINGS — Round 2` (or 3, 4…). Audit-log readability outweighs the trivial cost of incrementing a counter.

### Alternatives considered

- **Keep session open across cycles** — simplest plumbing change, but cost-prohibitive for 4–6 round cycles and prone to anchoring bias. Rejected for the reasons in the comparison table above.
- **Reviewer drives implementer in same session** — pairs reviewer turn-by-turn with implementer. Couples the two roles tightly, blocks parallel-execution paths, and is closer to debate-mode (which already exists for semantic). Out of scope for this fix.
- **Reviewer reads its own audit JSON files** — uses `logs/review-audit/` as the carry-forward mechanism. Couples prompt logic to file-system layout; audit logs are observability, not control flow. Rejected.
- **Persist findings in session scratch** — same as the recommended approach but with persistence. Adds an indirection (the reviewer would need a "read prior findings" tool call). No clear advantage. Rejected.

### Execution status

- [ ] Spec finalized and approved (this doc)
- [ ] PR 1 — fresh session + structured carry-forward (mandatory)
- [ ] PR 2 — structured `priorVerdict[]` + implementer feedback loop (optional, after PR 1 telemetry)
- [ ] PR 3 — convergence-stall escalation (optional, only if needed)

Execution deferred until spec sign-off.

---

## Gap 2 — Rectification prompt doesn't demand full-suite green

### Symptom

US-001 implementer rectification ran multiple times. Two consecutive prompts (15:24 and 15:39 UTC, same `implementer` session resumed) illustrate the failure mode.

**Prompt 1 (15:24):** 12 unit-test failures, all in one file:

```
# PRIOR FAILURES

## Failure 1 — IncrementalGraphDiffService › AC-8: DiffResult shape › returns
  a DiffResult with added, removed, indexed, and durationMs fields
File: src/rag/incremental-graph-diff.service.spec.ts
Message: expect(received).rejects.toThrow()

## Failure 2 — IncrementalGraphDiffService › AC-9: stored graph loaded from
  GraphNode + GraphLink Prisma tables › queries GraphNode and GraphLink tables
File: src/rag/incremental-graph-diff.service.spec.ts
Message: expect(received).rejects.toThrow()

... (10 more failures, ALL in src/rag/incremental-graph-diff.service.spec.ts)

# TEST COMMAND

`bun run test`

# Rectification Required

Your changes caused test regressions. Fix these without breaking existing logic.

## Instructions
1. Review the failures above carefully.
2. Identify the root cause of each failure.
3. Fix the implementation WITHOUT loosening test assertions.
4. Run the test command shown above to verify your fixes.
5. Ensure ALL tests pass before completing.
```

**Prompt 2 (15:39, 14 minutes later, same session):** 1 NEW failure in a *different* spec file for an *unrelated* story:

```
# PRIOR FAILURES

## Failure 1 — API Integration Tests › Knowledge Base — Graphify Import (US-003)
  › POST /kb/import/graphify — 200 when links field is absent (links is optional)
File: test/e2e/api-endpoint/endpoint.e2e.spec.ts
Message: expect(received).toBe(expected) // Object.is equality

# TEST COMMAND

`bun run test`

# Rectification Required
... (same instructions as prompt 1)
```

Pattern: implementer fixed the 12 unit tests, ran a scoped subset to confirm green, declared done. The system's `checkResult` then ran the full suite, caught the cross-story e2e regression in US-003's endpoint, and kicked off a fresh rectification cycle (prompt 2). **One avoidable cycle per regression** — if the implementer had run `bun run test` (full suite) themselves before declaring done, they'd have caught the regression in cycle 1.

### Where the gap actually lives

The system already runs the full suite at every rectification iteration's `checkResult()` ([rectification-loop.ts:312-326](../../src/verification/rectification-loop.ts#L312-L326)). Cross-story regressions are not undetected — they're detected one cycle later than they could be.

The gap is purely **the agent's self-verification within its session**: the prompt's "Ensure ALL tests pass" is ambiguous, and the agent treats it as "all the failures listed in this prompt" rather than "every test in the repo". So they run `bun test <failing-files>`, see green, hand off — and the system catches the regressions on the next pass.

### Test-execution architecture (so the wording doesn't fight it)

| Surface | Tests run | Smart runner involved? |
|:---|:---|:---|
| Per-story verify (single-session: `tdd-simple`, `test-after`) | Scoped via `testScopedTemplate` when smart runner maps; full suite otherwise | Yes |
| Per-story verify (deferred mode + would-fall-back-to-full) | **Skipped** — defers to run-end gate | Yes (decides skip) |
| Three-session TDD full-suite gate (between session 2 and 3) | Full suite | No |
| Per-story rectification `checkResult()` (any trigger) | Full `testCommand` | No |
| Run-end deferred regression gate | Full suite | No |

The smart runner is upstream of rectification only — by the time the rectification prompt is built, `testCommand` is always the full-suite command. So the wording fix doesn't need any branching on strategy or `testScopedTemplate`.

### Root cause

Two issues, both in [`src/prompts/builders/rectifier-builder.ts`](../../src/prompts/builders/rectifier-builder.ts).

**(a) Trigger taxonomy is half-dead.** The `RectifierTrigger` union has four values:

| Trigger | Used via `.for(...)`? | Notes |
|:---|:---|:---|
| `tdd-test-failure` | **no** | TDD red phase has its own prompts in `TddPromptBuilder` |
| `tdd-suite-failure` | yes ([rectification-gate.ts:269](../../src/tdd/rectification-gate.ts#L269)) | Three-session TDD's full-suite gate |
| `verify-failure` | yes ([rectification-loop.ts:238](../../src/verification/rectification-loop.ts#L238)) | Per-story verify failure + deferred regression |
| `review-findings` | **no** | Review findings flow through `RectifierPromptBuilder.reviewRectification()` (a separate static method) |

Two of four are dead. Of the two live ones, the task strings are nearly identical — they describe the same situation from the implementer's perspective ("tests are broken after your implementation, fix them and confirm full suite green").

**(b) Task wording is ambiguous about what "ALL" means.** All four task constants share these lines:

```
4. Run the test command shown above to verify your fixes.
5. Ensure ALL tests pass before completing.
```

"Verify your fixes" reinforces the scoped-run interpretation. "ALL tests" is read as "all the failures listed", not "every test in the repo".

### Phase 5 history (why dead code exists)

[`docs/specs/prompt-builder-phase5.md`](../specs/prompt-builder-phase5.md) defines the migration that created `RectifierPromptBuilder`. Phase 5 planned to wire all four triggers:

| Trigger | Phase 5 plan | Today |
|:---|:---|:---|
| `tdd-test-failure` | `src/tdd/session-runner.ts` | **Never wired** — session-runner doesn't build a rectification prompt; the implementer session continues in-place after test-writer ([session-runner.ts:207-211](../../src/tdd/session-runner.ts#L207-L211)) |
| `tdd-suite-failure` | `src/tdd/rectification-gate.ts:210` | Wired ✓ |
| `verify-failure` | `src/verification/rectification-loop.ts:241` | Wired ✓ |
| `review-findings` | `verification/rectification-loop.ts` (with `.findings(...)`) | **Never wired** — review findings flow through `RectifierPromptBuilder.reviewRectification()`, a separate static method with semantic/adversarial/mechanical/combined sub-paths |

Phase 5's risk-1 mitigation ("keep four distinct trigger task constants — preserves the original prompt verbatim") was correct at migration time. That mitigation is no longer load-bearing: the historical TDD prompts the constants were preserving have since converged in wording, and the two unwired triggers represent flows that don't exist (tdd-test-failure: never had a fresh-prompt callsite; review-findings: superseded by `reviewRectification()`).

So consolidating now reclaims a parking spot, not erasing intent.

### Proposed approach — three-PR sequence

Land as three small, independent PRs rather than one big change:

#### PR 1 — Dead-code removal (low risk, atomic, reviewable in 2 minutes)

Delete unused trigger values and their plumbing. **No behavior change. No production callsite touched.**

Files modified:

- [`src/prompts/builders/rectifier-builder.ts`](../../src/prompts/builders/rectifier-builder.ts):
  - Remove `"tdd-test-failure"` and `"review-findings"` from the `RectifierTrigger` union ([:46-49](../../src/prompts/builders/rectifier-builder.ts#L46-L49))
  - Remove `TDD_TEST_FAILURE_TASK` constant ([:655-670](../../src/prompts/builders/rectifier-builder.ts#L655-L670)) and `REVIEW_FINDINGS_TASK` constant ([:706+](../../src/prompts/builders/rectifier-builder.ts#L706))
  - Remove their switch arms in `rectifierTaskFor()` ([:642-652](../../src/prompts/builders/rectifier-builder.ts#L642-L652))

- [`test/unit/prompts/rectifier-builder.test.ts`](../../test/unit/prompts/rectifier-builder.test.ts):
  - Remove ~12 test cases that reference the dead trigger values (lines 79, 82, 93, 107, 124, 139, 149, 174, 185, 229, 240, 251 — verify exhaustive list before deleting)
  - The remaining tests for `"tdd-suite-failure"` and `"verify-failure"` cover the live paths

Net: ~80 LOC removed across 2 files. No source callsites touched.

#### PR 2 — Consolidate + sharpen wording (the main Gap 2 fix)

After PR 1, the trigger union has only 2 values left and they describe the same situation. Replace `RectifierPromptBuilder.for(trigger).…build()` with a single static method, matching the existing pattern of sibling methods (`reviewRectification`, `testWriterRectification`, `firstAttemptDelta`):

```typescript
RectifierPromptBuilder.regressionFailure({
  story,
  failures,        // FailureRecord[] — formerly priorFailures()
  testCommand,
  conventions,     // boolean (default true)
  isolation,       // "strict" | "lite" | undefined
  constitution,    // string | undefined
  context,         // string | undefined
  promptPrefix,    // string | undefined — for diagnosis prefix from debate stage
})
```

Returns the assembled prompt string directly. Both call sites switch to the new shape:

- [`src/verification/rectification-loop.ts:238`](../../src/verification/rectification-loop.ts#L238)
- [`src/tdd/rectification-gate.ts:269`](../../src/tdd/rectification-gate.ts#L269)

Delete (PR 1 pruned the dead trigger values; PR 2 finishes the job):
- The remaining `RectifierTrigger` union and its `for(trigger)` constructor (now down to 2 values)
- `TDD_SUITE_FAILURE_TASK` and `VERIFY_FAILURE_TASK` constants (collapsed into the new method's body)
- The `rectifierTaskFor(trigger)` switch
- All chained instance methods on the builder used only by the trigger flow:
  - `constitution(c)`, `context(md)`, `story(s)`, `priorFailures(failures)`, `findings(fs)`, `testCommand(cmd)`, `isolation(mode)`, `conventions()`, `task()`, `build()`
  - The internal `SectionAccumulator` / `acc` field
  - The private `s(...)` section-tagging helper
- These instance methods are unique to the `for(trigger)` flow. **The other static methods on the builder remain untouched**: `firstAttemptDelta`, `continuation`, `noOpReprompt`, `reviewRectification`, `semanticRectification`, `adversarialRectification`, `mechanicalRectification`, `combinedLlmRectification`, `testWriterRectification`, `escalated`, `formatCheckErrors`. PR 2 removes only the trigger/builder/chain pattern, not the shared static helpers.

Single task string body, embedded in `regressionFailure()`:

```
# Rectification Required

Tests are failing. Fix the source so all tests pass — not just the ones listed.

## Instructions

1. Review the failures above and identify the root cause of each.
2. Fix the source code WITHOUT loosening test assertions or removing tests.
3. After your fix, run the FULL repo test suite — the EXACT command below:

   `<testCommand>`

   The verifier will replay this same command. If you only run the failing
   tests in isolation, you may have introduced cross-story regressions you
   won't see. There is no benefit to skipping this — the verifier WILL catch
   anything you miss, and you'll just be back here in another cycle.

4. Do not declare done until step 3 shows 0 failures.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.
```

Notes:
- No branching on `testScopedTemplate` — smart runner is orthogonal to rectification ([see architecture table above](#test-execution-architecture-so-the-wording-doesnt-fight-it)).
- The "verifier will replay this command" framing makes skipping it strictly worse than running it (no behavior change, just clearer incentive).
- One canonical wording covers both `tdd-suite-failure` and `verify-failure` semantics, since they're the same situation.

#### PR 3 (optional) — Spec annotation

Update [`docs/specs/prompt-builder-phase5.md`](../specs/prompt-builder-phase5.md) to reflect what actually shipped:

- Annotate the `tdd-test-failure` and `review-findings` callsites as "planned but never wired"
- Add a footnote pointing at PR 1 + PR 2

Optional and can land anytime. Purpose: prevent future readers from concluding the migration was incomplete and re-introducing the dead values.

### Scope estimate

| PR | LOC delta | Files | Risk | Standalone? |
|:---|:---|:---|:---|:---|
| 1 — dead-code removal | ~80 removed | 2 | Very low | Yes |
| 2 — consolidate + wording | ~120 net | ~5 (builder + 2 callsites + tests) | Low–medium | Yes (after PR 1) |
| 3 — spec annotation | ~10 | 1 | None | Yes (any time) |

### Resolved design decisions

1. **Stricter "do not modify test files" wording.** ✅ Skip — the new `regressionFailure()` method uses the unified wording shown above, with the standard "do not loosen assertions" rule. The stricter test-writer-style wording from the dead `tdd-test-failure` constant has no live caller; the current TDD design is implementer-session-continues-in-place ([session-runner.ts:207-211](../../src/tdd/session-runner.ts#L207-L211)). If a future caller emerges that needs the stricter wording, add it as an opt-in field on the options object then.

2. **Loop-level full-suite enforcement.** ✅ Skip — prompt-only. The system already validates with the full suite at every rectification iteration's `checkResult()` ([rectification-loop.ts:312-326](../../src/verification/rectification-loop.ts#L312-L326)). In-session enforcement (e.g., parsing agent output for evidence of a full-suite invocation) adds complexity without protecting against anything new.

3. **Pre-merge validation.** ✅ Required as part of PR 2's review process: capture before/after rendered prompts using a real `testCommand` from a recent run, attach to PR description, confirm token impact is small (~+10 lines net) and the `<testCommand>` interpolation renders correctly. Also run one full feature end-to-end with the new prompt to confirm no regression in implementer behavior.

### Execution status

- [ ] Spec finalized and approved (this doc)
- [ ] PR 1 — dead-code removal
- [ ] PR 2 — consolidate + sharpen wording
- [ ] PR 3 — spec annotation (optional)

Execution deferred until spec sign-off.

---

## Order of work

The two gaps are largely independent — except that **Gap 1 PR 2 depends on Gap 2 PR 2** (the implementer-feedback verdict block lives in `RectifierPromptBuilder.regressionFailure(...)`, which is created by Gap 2 PR 2).

### Recommended sequence

| Order | PR | Why this slot |
|:---|:---|:---|
| 1 | **Gap 2 PR 1** — dead-code removal | Smallest, lowest risk, atomic. Unblocks reviewers' mental model of the builder. |
| 2 | **Gap 2 PR 2** — consolidate + sharpen wording | Validates the regression-detection wording on a real run before stacking more changes. |
| 3 | **Gap 1 PR 1** — fresh session + structured carry-forward | The actual goalpost-moving fix. Independent of Gap 2 PR 2 for PR 1's own scope. |
| 4 | **Gap 1 PR 2** *(optional)* — `priorVerdict[]` + implementer feedback loop | Depends on both Gap 2 PR 2 (rectifier method) and Gap 1 PR 1 (cache + carry-forward). Land only after PR 1 telemetry shows it's worthwhile. |
| 5 | **Gap 2 PR 3** *(optional)* — spec annotation | Anytime; documentation hygiene. |
| 6 | **Gap 1 PR 3** *(optional)* — convergence-stall escalation | Only if Gap 1 PR 1+2 still let runs diverge. |

### Why this order

- **Land cleanups first.** Gap 2 PR 1 is mechanical and reduces surface area for everything that follows.
- **Validate wording before architectural change.** Gap 2 PR 2 changes a prompt the agent reads on every rectification cycle — get it on a real run before piling on Gap 1's changes.
- **Gap 1 PR 1 is the load-bearing change.** It's the actual fix for the goalpost-moving bug. Land it once Gap 2 has stabilized so the new prompt and the new builder method aren't both in flight at once.
- **Defer optional PRs until data exists.** PRs 4–6 are gated on observability from the prior PRs. Don't pre-build them.

Each PR carries its own tests, snapshot updates, and audit-log expectations.
