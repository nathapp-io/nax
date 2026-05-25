# SPEC: `callOp` honors `exhaustedFallback` on empty-output path

**Issue:** #1092
**Status:** Draft
**Stage:** Spec → review → implement
**Size:** ~15 LoC source patch + 1 strategy declaration + 3 test files

## Problem

`callOp` (`src/operations/call.ts`) has two exhaustion paths:

| Path | Site | `exhaustedFallback` honored? |
|:---|:---|:---|
| Parse failure after all retries | `src/operations/call.ts:485-510` (parse `try/catch` reads `retryFallback`) | ✅ yes |
| Empty `rawOutput` (no `result.output` after retries) | `src/operations/call.ts:470-476` (unconditional throw) | ❌ no |

The empty-output path throws `CALL_OP_NO_OUTPUT` before the parse-fallback branch runs, so an op that declared `exhaustedFallback` on its retry strategy does not get it honored when output is empty after exhaustion.

This is a contract bug: the retry-strategy SSOT (`.claude/rules/retry-strategy.md` §"`RetryDecision.fallback` and `exhaustedFallback`") promises that ops with `exhaustedFallback` can absorb retry exhaustion silently, but only the parse-failure path delivers on that promise today.

## Affected ops (current state, audited 2026-05-25)

| Op | File | `exhaustedFallback` declared? | Parse `parse()` style |
|:---|:---|:---|:---|
| `adversarialReviewOp` | `src/operations/adversarial-review.ts:66-69` | ✅ yes (returns `looksLikeFail` or `FAIL_OPEN`) | strict (throws `ParseValidationError`) |
| `semanticReviewOp` | `src/operations/semantic-review.ts:86-96` | ❌ **no** | graceful (returns `FAIL_OPEN` on invalid) |

Implication: adversarial gets full benefit from the 3-LoC `callOp` patch immediately. Semantic needs a tiny op-side companion change to declare `exhaustedFallback: () => FAIL_OPEN` so the empty-output path mirrors the parse-failure path (which is graceful-by-construction today).

## Scope

**In scope**
1. Patch `callOp` empty-output throw to read `retryFallback` first, mirroring the parse-failure branch.
2. Declare `exhaustedFallback: () => FAIL_OPEN` on `semanticReviewOp`'s retry strategy so AC4 holds.
3. Unit + integration tests for both ops and both paths (with/without fallback).

**Out of scope**
- Adversarial same-session requote recovery (issue #1093).
- Orchestrator vs wrapper filter parity (issue #1100).
- Adding `exhaustedFallback` to ops that don't already declare one. Behavior change is opt-in.
- Touching `op.recover` semantics or `MAX_COMPLETE_RETRY_ATTEMPTS` ceiling.

## Design

### Change 1 — `src/operations/call.ts:470-476`

Current:

```typescript
if (!rawOutput) {
  throw new NaxError(`callOp[${op.name}]: agent returned no output`, "CALL_OP_NO_OUTPUT", {
    stage: op.stage,
    storyId: ctx.storyId,
    agentName: dispatchAgent,
  });
}
```

Patched — mirrors the **full escape-hatch ladder** from the parse-failure branch (`call.ts:502-519`): `exhaustedFallback` → shape guard → `op.recover` → throw. This preserves contract symmetry with parse-failure exhaustion and respects the documented ordering in `.claude/rules/retry-strategy.md` ("escape hatches in order").

```typescript
if (!rawOutput) {
  if (retryFallback !== undefined) {
    if (typeof retryFallback !== "object" || retryFallback === null) {
      throw new NaxError(
        `callOp[${op.name}]: exhaustedFallback returned a non-object (${typeof retryFallback}); fallback must be a plain object`,
        "CALL_OP_INVALID_FALLBACK",
        { stage: op.stage, storyId: ctx.storyId },
      );
    }
    getSafeLogger()?.warn("callop", "Returning exhaustedFallback on empty output", {
      storyId: ctx.storyId,
      opName: op.name,
      agentName: dispatchAgent,
    });
    return { ...retryFallback, estimatedCostUsd: totalCost } as O;
  }
  if (op.recover) {
    const verifyCtx = makeVerifyCtx(buildCtx);
    const recovered = await op.recover(input, verifyCtx);
    if (recovered !== null) {
      getSafeLogger()?.warn("callop", "Recovered from empty output via op.recover", {
        storyId: ctx.storyId,
        opName: op.name,
        agentName: dispatchAgent,
      });
      return recovered;
    }
  }
  throw new NaxError(`callOp[${op.name}]: agent returned no output`, "CALL_OP_NO_OUTPUT", {
    stage: op.stage,
    storyId: ctx.storyId,
    agentName: dispatchAgent,
  });
}
```

Notes:
- `retryFallback` (line 300), `totalCost` (line 468), `getSafeLogger` (line 10 import), and `makeVerifyCtx` are already in scope at this site — no new imports or threading.
- TypeScript narrows `retryFallback` from `unknown` to `object` after the line-503-equivalent guard, so the spread works without an explicit `as object` cast — matching the parse-failure branch at line 510.
- Shape validation duplicates the parse-failure branch verbatim. Acceptable duplication for this PR; a `consumeRetryFallback(...)` helper consolidating both sites is a follow-up refactor (out of scope).
- The `op.recover` branch mirrors lines 515-519 — disk-recovery ops (e.g. `planInteractiveOp`, issue #993) get the same escape hatch on empty output as on parse failure.

### Change 2 — `src/operations/semantic-review.ts:86-96`

Add `exhaustedFallback` so semantic's behavior on empty-output exhaustion matches its graceful parse behavior:

```typescript
retry: (input) =>
  makeParseRetryStrategy({
    validate: (parsed) => validateLLMShape(parsed) !== null,
    reviewerKind: "semantic",
    maxAttempts: 2,
    prompts: { /* unchanged */ },
    exhaustedFallback: (lastOutput) =>
      /"passed"\s*:\s*false/.test(lastOutput)
        ? { passed: false, findings: [], normalizedFindings: [], looksLikeFail: true }
        : FAIL_OPEN,
    logContext: { blockingThreshold: input.blockingThreshold ?? "error" },
  }),
```

This mirrors `adversarialReviewOp`'s strategy verbatim and aligns with the rule "ops that cannot tolerate a raw `TurnResult` as their output MUST provide `exhaustedFallback`" (`.claude/rules/retry-strategy.md`).

Note: `lastOutput` may be empty in the empty-output case — the regex test on `""` yields `false`, so empty output cleanly falls through to `FAIL_OPEN`. No special-case needed.

## Acceptance Criteria

1. **AC1 [verbatim]** When a run-kind callOp's retry strategy has set `retryFallback` (via `exhaustedFallback`) and the final `rawOutput` is empty, callOp returns the fallback merged with cumulative `estimatedCostUsd` instead of throwing `CALL_OP_NO_OUTPUT`.

2. **AC2 [verbatim]** When `retryFallback` is undefined and `rawOutput` is empty, callOp throws `CALL_OP_NO_OUTPUT` (existing behavior preserved).

3. **AC3 [verbatim]** For `adversarialReviewOp`: when all manager retries exhaust and output is still empty, the op returns `FAIL_OPEN = { passed: true, findings: [], failOpen: true }` (or `looksLikeFail: true` variant per `exhaustedFallback` logic) instead of hard-failing the story.

4. **AC4 [verbatim]** For `semanticReviewOp`: empty-output exhaustion produces the same FAIL_OPEN-equivalent the op already produces on parse failure, with no regression in the parse-failure path.

5. **AC5 [verbatim]** Downstream consumers reading `failOpen: true` from review results behave identically to today's parse-failure FAIL_OPEN — no new code paths needed in review consumers.

6. **AC6** When `retryFallback` is set to a non-object (e.g. `null`, primitive) and `rawOutput` is empty, callOp throws `CALL_OP_INVALID_FALLBACK` — same shape-guard behavior as the parse-failure branch.

7. **AC7** When `retryFallback` is undefined, `op.recover` is defined, and `rawOutput` is empty, callOp invokes `op.recover(input, verifyCtx)`; if it returns non-null, that value is returned as `O`; if it returns null, callOp throws `CALL_OP_NO_OUTPUT`. Escape-hatch order matches the parse-failure branch.

## Verification

### Unit tests — `test/unit/operations/call-exhausted-fallback.test.ts` (new)

Build directly on the existing `call.ts` test harness pattern. Each test uses a synthetic `RunOperation` with a `runWithFallback` mock that resolves to `{ output: "" }` to exercise the empty-output branch.

| Test | Asserts |
|:---|:---|
| empty output + `exhaustedFallback: () => FAIL_OPEN` returns FAIL_OPEN merged with `estimatedCostUsd` | AC1 |
| empty output + no `exhaustedFallback` throws `CALL_OP_NO_OUTPUT` | AC2 |
| empty output + `exhaustedFallback: () => null` throws `CALL_OP_INVALID_FALLBACK` | AC6 |
| empty output + `exhaustedFallback: () => "string"` throws `CALL_OP_INVALID_FALLBACK` | AC6 |
| empty output, cumulative cost across attempts is summed onto fallback | AC1 cost-merging |
| empty output + `op.recover` returning a value, no `exhaustedFallback` → returns recovered value | AC7 |
| empty output + `op.recover` returning `null`, no `exhaustedFallback` → throws `CALL_OP_NO_OUTPUT` | AC7 |
| empty output + both `exhaustedFallback` and `op.recover` set → `exhaustedFallback` wins (recover not called) | AC7 ordering |
| non-empty output still flows through `op.parse` unchanged (regression) | no parse-path regression |

### Integration tests — additions to existing review op tests

| File | Addition |
|:---|:---|
| `test/unit/operations/adversarial-review.test.ts` | Test: mock `runWithFallback` to return `{ output: "" }` after all retries, assert op returns FAIL_OPEN (passed: true, normalizedFindings: []) — AC3 |
| `test/unit/operations/semantic-review.test.ts` | Test 1: same as above for semantic — AC4. Test 2: parse-failure path still returns FAIL_OPEN — AC4 no-regression. |

### Test commands

```bash
timeout 30 bun test test/unit/operations/call-exhausted-fallback.test.ts --timeout=5000
timeout 30 bun test test/unit/operations/adversarial-review.test.ts --timeout=5000
timeout 30 bun test test/unit/operations/semantic-review.test.ts --timeout=5000
timeout 60 bun run test:bail
```

## Risk

| Risk | Mitigation |
|:---|:---|
| Hiding genuine empty-output bugs by silently returning FAIL_OPEN | `logger.warn` on the empty-output fallback path; only opt-in ops affected; parse-failure path already does this and is operational |
| Future op declares `exhaustedFallback` returning non-object | Shape guard throws `CALL_OP_INVALID_FALLBACK` (AC6) — same gate the parse-failure branch enforces |
| Cost double-counting | `estimatedCostUsd` is summed once from `totalCost` (line 468) and merged onto the fallback — same pattern as parse-failure branch line 510-ish |
| Semantic op behavior change | New `exhaustedFallback` matches existing graceful `parse()` semantics exactly — no observable behavior change for non-empty output |

## Out-of-scope follow-ups

- #1093 — adversarial same-session requote recovery
- #1100 — orchestrator/wrapper filter parity (substantiate + AC grounding)

Both belong in PR B and depend on adversarial/semantic op-internal post-processing changes that this PR deliberately does not touch.

## File touch list

| File | Change |
|:---|:---|
| `src/operations/call.ts` | Empty-output branch reads `retryFallback` (Change 1) |
| `src/operations/semantic-review.ts` | Declare `exhaustedFallback` on retry strategy (Change 2) |
| `test/unit/operations/call-exhausted-fallback.test.ts` | New test file (6 cases) |
| `test/unit/operations/adversarial-review.test.ts` | +1 test (empty-output FAIL_OPEN) |
| `test/unit/operations/semantic-review.test.ts` | +2 tests (empty-output FAIL_OPEN + parse-failure no-regression) |

No changes to: `src/review/`, `src/findings/`, `src/execution/story-orchestrator.ts`, any pipeline stage, or any rule doc.
