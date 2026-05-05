# Issue 886 Implementation Plan: Full-Suite Gate Exhaustion Before Verifier

## Context

Issue: https://github.com/nathapp-io/nax/issues/886

Worktree: `.nax-wt/issue-886-full-suite-gate`

Base: `origin/main` at `8af391bf2a09e530b5722e6dec9e1f8bc1806cbf`

Current behavior:

- `runThreeSessionTdd()` runs the full-suite gate after the implementer session.
- `runFullSuiteGate()` can return `passed: false` after rectification retries are exhausted.
- `runThreeSessionTdd()` records `fullSuiteGatePassed`, but does not branch on the failed gate.
- The verifier session then starts even though the pre-verifier full-suite gate is already known to have failed.

Primary files:

- `src/tdd/orchestrator.ts`
- `src/tdd/rectification-gate.ts`
- `src/tdd/types.ts`
- `src/pipeline/stages/execution-helpers.ts`
- `src/execution/escalation/tier-escalation.ts`
- `docs/guides/tdd/strategies.md`
- `docs/architecture/subsystems.md`

## Decision

Choose Option A from issue 886: stop before verifier when rectification is exhausted for attributable full-suite failures.

Rationale:

- The full-suite gate owns pre-verifier regression detection.
- The verifier owns TDD integrity checks, not terminal suite-regression adjudication.
- Continuing to verifier after a known exhausted gate creates ambiguous failure ownership.
- A verifier verdict can currently map the final outcome back to generic `tests-failing`, which hides that the failure source was the full-suite gate.

Important distinction:

- Do not short-circuit every `fullSuiteGatePassed === false`.
- Short-circuit only the explicit rectification-exhausted case.
- Existing `fullSuiteGatePassed: false` meanings include disabled gate, deferred unattributable failures, inconclusive/crash-like output, and execution failure. Those should preserve current behavior unless separately redesigned.

## Target Behavior

When the full-suite gate finds attributable failures and exhausts rectification:

1. Do not start the verifier session.
2. Return a failed `ThreeSessionTddResult`.
3. Preserve sessions already run: test-writer if applicable, implementer.
4. Include rectification cost in `totalCost`.
5. Set `failureCategory: "full-suite-gate-exhausted"`.
6. Set `reviewReason` to a clear source-specific message.
7. Set `fullSuiteGatePassed: false`.
8. Leave `verdict` as `undefined`, because verifier was not attempted.
9. Roll back to the initial ref when `config.tdd.rollbackOnFailure` is true, matching other TDD failures.
10. Route the failure through normal tier escalation and final max-attempt failure behavior.

## Type Design

Add a status discriminator to the full-suite gate result while keeping existing fields for metrics compatibility.

```ts
export type FullSuiteGateStatus =
  | "disabled"
  | "passed"
  | "passed-with-nonzero-exit"
  | "deferred-unattributable"
  | "inconclusive"
  | "execution-failed"
  | "rectification-exhausted";

export interface FullSuiteGateResult {
  passed: boolean;
  cost: number;
  fullSuiteGatePassed: boolean;
  status: FullSuiteGateStatus;
  attempts?: number;
}
```

Recommended mapping:

| Current return path | New `status` | Short-circuit? |
|---|---|---|
| rectification disabled | `disabled` | No |
| clean full suite pass | `passed` | No |
| non-zero exit, parsed passed tests, zero failures | `passed-with-nonzero-exit` | No |
| failures parsed but no attributable failure records | `deferred-unattributable` | No |
| no parsed test results from output | `inconclusive` | No |
| failed with no output | `execution-failed` | No |
| rectification loop exhausted | `rectification-exhausted` | Yes |

Add a new TDD failure category:

```ts
| "full-suite-gate-exhausted"
```

Category semantics:

- More specific than `tests-failing`.
- Still represents an automatic escalation-worthy failure.
- At max attempts, it should fail rather than pause, same as `tests-failing`.

## Implementation Steps

### 1. Extend full-suite gate result status

File: `src/tdd/rectification-gate.ts`

- Export `FullSuiteGateStatus` and `FullSuiteGateResult`.
- Add `status` to all return sites.
- Add `attempts: outcome.attempts` on the `rectification-exhausted` return.
- Keep `passed` and `fullSuiteGatePassed` unchanged for existing callers and metrics.

Notes:

- Avoid using `fullSuiteGatePassed === false` as a control-flow signal.
- The status string is the source of truth for why the gate did not fully pass.

### 2. Add orchestrator short-circuit

File: `src/tdd/orchestrator.ts`

- Capture the full result:

```ts
const fullSuiteGate = await runFullSuiteGate(...);
const { cost: fullSuiteGateCost, fullSuiteGatePassed } = fullSuiteGate;
```

- Immediately after the gate, before `captureGitRef()` for verifier, branch on:

```ts
if (fullSuiteGate.status === "rectification-exhausted") {
  ...
}
```

- Return a failed result with:

```ts
success: false,
sessions,
needsHumanReview: true,
reviewReason: "Full-suite gate failed after rectification exhausted",
failureCategory: "full-suite-gate-exhausted",
totalCost: sessions.reduce(...) + fullSuiteGateCost,
totalDurationMs: sessions.reduce(...),
totalTokenUsage: sumTddTokenUsage(sessions),
lite,
fullSuiteGatePassed,
```

- Run rollback before returning when `shouldRollbackOnFailure` is true.
- Log a source-specific warning:

```ts
logger.warn("tdd", "Stopping before verifier because full-suite gate rectification exhausted", {
  storyId: story.id,
  attempts: fullSuiteGate.attempts,
  failureCategory: "full-suite-gate-exhausted",
});
```

Recommended helper to avoid duplicating rollback code:

```ts
async function rollbackTddFailureIfNeeded(options: {
  shouldRollback: boolean;
  workdir: string;
  initialRef: string;
  storyId: string;
  failureCategory?: FailureCategory;
}): Promise<void>
```

Keep the helper small and local to `orchestrator.ts`.

### 3. Extend failure routing

Files:

- `src/pipeline/stages/execution-helpers.ts`
- `src/execution/escalation/tier-escalation.ts`

Changes:

- `routeTddFailure("full-suite-gate-exhausted", ...)` returns `{ action: "escalate" }`.
- `resolveMaxAttemptsOutcome("full-suite-gate-exhausted")` returns `"fail"`.
- Update exhaustive category arrays in tests.

Reasoning:

- The implementation might pass on a higher tier or later attempt.
- If all attempts are exhausted, this is an automated failure, not a human-review pause like `verifier-rejected` or `isolation-violation`.

### 4. Documentation updates

Files:

- `docs/guides/tdd/strategies.md`
- `docs/architecture/subsystems.md`

Document:

- The full-suite gate runs between implementer and verifier.
- If attributable failures persist after rectification, verifier is skipped.
- `full-suite-gate-exhausted` identifies this source.
- ADR-021/ADR-022 `tdd-verifier` findings remain reserved/unproduced and must not absorb full-suite gate failures.

Also consider a short note in `docs/adr/ADR-021-findings-and-fix-strategy-ssot.md` near the TDD verifier implementation-status paragraph:

- Full-suite gate exhaustion is represented as a TDD failure category, not as `tdd-verifier` findings.

## Tests

### Required new tests

1. Integration test for orchestrator short-circuit.

File: `test/integration/tdd/tdd-orchestrator-failureCategory.test.ts`

Scenario:

- test-writer succeeds.
- implementer succeeds.
- full-suite gate returns attributable failures.
- rectification attempts exhaust.
- verifier mock result is present in the queue but must not be consumed.

Assert:

- `result.success === false`
- `result.failureCategory === "full-suite-gate-exhausted"`
- `result.fullSuiteGatePassed === false`
- `result.verdict === undefined`
- `result.sessions.map((s) => s.role)` does not include `"verifier"`
- `result.totalCost` includes rectification cost

2. Unit or integration test for route behavior.

File: `test/unit/execution/execution-stage.test.ts`

Assert:

- `routeTddFailure("full-suite-gate-exhausted", false, ctx).action === "escalate"`

3. Unit/integration test for max-attempt outcome.

Files:

- `test/unit/execution/escalation/tier-escalation.test.ts`
- `test/integration/execution/runner-escalation.test.ts`

Assert:

- `resolveMaxAttemptsOutcome("full-suite-gate-exhausted") === "fail"`

4. Rectification gate result status tests.

File: `test/unit/tdd/rectification-gate-session.test.ts` or `test/integration/agents/acp/tdd-flow-rectification.test.ts`

Assert:

- persistent failure returns `status: "rectification-exhausted"`
- clean pass returns `status: "passed"`
- disabled rectification returns `status: "disabled"`
- unattributable failures return `status: "deferred-unattributable"`

### Regression tests to update

Search for hardcoded `FailureCategory[]` arrays and update them:

- `test/unit/execution/execution-stage.test.ts`
- `test/integration/pipeline/pipeline.test.ts`
- `test/integration/execution/runner-escalation.test.ts`
- `test/unit/prd/prd-failure-category.test.ts`

Some existing tests mention "all four categories"; update wording.

## Verification Commands

Run focused tests first:

```sh
bun test test/integration/tdd/tdd-orchestrator-failureCategory.test.ts --timeout=30000
bun test test/unit/tdd/rectification-gate-session.test.ts --timeout=30000
bun test test/unit/execution/execution-stage.test.ts --timeout=30000
bun test test/unit/execution/escalation/tier-escalation.test.ts --timeout=30000
bun test test/integration/execution/runner-escalation.test.ts --timeout=30000
```

Then run:

```sh
bun run typecheck
bun run lint
```

Full suite if time allows:

```sh
bun run test
```

## Risk Notes

- `fullSuiteGatePassed` currently has multiple `false` meanings. Do not use it as the short-circuit trigger.
- The verify pipeline stage skips when `ctx.fullSuiteGatePassed` is true. Failed gate exhaustion should leave it false, but TDD failure routing should prevent normal verification from continuing for that story.
- Metrics should continue to report `fullSuiteGatePassed: false` for this failed story.
- Rollback behavior should match existing TDD failure semantics.
- The verifier verdict schema should not be expanded for this change because verifier is not run in the chosen design.

## Suggested PR Summary

Implement issue 886 by making rectification-exhausted full-suite gate failures terminal before the verifier session. The change adds an explicit gate status, introduces `full-suite-gate-exhausted` as a TDD failure category, routes it through normal escalation, and documents the verifier boundary so suite-regression failures cannot be misattributed to verifier verdicts.
