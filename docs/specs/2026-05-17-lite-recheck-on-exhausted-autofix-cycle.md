# SPEC: Lite Recheck on Exhausted Autofix Cycle

> Fixes issue #1030. Companion implementation plan: `docs/superpowers/plans/2026-05-17-lite-recheck-on-exhausted-autofix-cycle.md`.

## Summary

When the autofix V2 fix cycle exhausts a strategy's per-strategy attempt cap, the current code skips the final validate step and returns the *pre-fix* findings as `finalFindings`. If the final implementer fix actually resolved every finding, this is never detected and the story escalates needlessly. This feature replaces that skip with a "lite" validate — lint + typecheck + tests, but no LLM reviewers — which detects silent pass on the terminal fix and produces an accurate post-fix `findingsAfter` for the escalation digest when the cycle truly must escalate.

## Motivation

The skip-validate optimisation in `src/findings/cycle.ts:297-326` was intentional: don't pay for an expensive adversarial/semantic LLM call on a cycle that's already out of fix budget. But the optimisation is wrong-shaped. Two failure modes follow from it:

1. **Silent pass not detected.** If the last fix resolved everything, `cycle.findings` still holds the pre-fix snapshot. The cycle exits `max-attempts-per-strategy`, the story escalates, and a powerful-tier agent is spun up to "fix" code that is already correct. This is the primary bug reported in #1030 (run log `2026-05-14T02-46-16.jsonl`).
2. **Escalation digest is stale.** If the last fix partially helped (e.g. resolved 3 of 5 findings), the digest passed to the escalated tier still lists all 5. The higher tier wastes tokens on already-fixed items.

The right answer is to run validate on the terminal iteration but skip the LLM reviewers — adversarial/semantic findings discovered now cannot be fixed in this cycle, and the cost dominates. Mechanical checks (lint, typecheck, tests) are cheap and answer the only question that matters: did the last fix actually resolve things, or do we need to escalate.

## Design

### Approach

This is a pure orchestration change. No new config keys, no schema migrations, no new ops, no new prompts, no new adapter primitives. The change widens one callback signature, adds one optional boolean field to `PipelineContext`, and rewrites two existing branches.

### Validate signature

`FixCycle.validate` (defined in `src/findings/cycle-types.ts:179`) gains an `opts` argument:

```ts
validate: (ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<F[]>;
```

`opts.mode = "full"` is the existing behavior. `opts.mode = "lite"` signals the terminal call after the last attempt has been used — implementers SHOULD skip LLM reviewers. The acceptance-loop cycle in `src/execution/lifecycle/acceptance-loop.ts:297` accepts the arg and ignores it (acceptance validation is already mechanical-only).

### Lite-mode skip mechanism

`reviewStage.execute` has two LLM entry points:

1. **Runner path** — `src/review/runner.ts:323` iterates `config.checks`. At line 326 it already consults `ctx.retrySkipChecks?.has(checkName)` and skips checks listed there. "adversarial" and "semantic" are both valid entries in `config.checks`, so adding them to `retrySkipChecks` skips them via this existing mechanism.
2. **Dialogue path** — `src/pipeline/stages/review.ts:35-132` has two early-return branches that issue LLM semantic calls *before* delegating to the runner. They never consult `retrySkipChecks`. A new `ctx.skipLLMReviewers: boolean` field gates these branches; when set, they fall through to the orchestrator path which respects `retrySkipChecks`.

`recheckReview(ctx, { lite })` in `src/pipeline/stages/autofix.ts` is responsible for setting both signals before delegating to `reviewStage.execute` and restoring both after.

### Integration

- **Existing types to extend:**
  - `FixCycle<F>` in `src/findings/cycle-types.ts` — widen `validate` signature
  - `PipelineContext` in `src/pipeline/types.ts` — add `skipLLMReviewers?: boolean`
- **Integration points:**
  - `runFixCycle` in `src/findings/cycle.ts:297-326` — replace `allExhausted` early-return with lite-validate-then-classify
  - `validate` closure in `src/pipeline/stages/autofix-cycle.ts:530` — forward `opts.mode === "lite"` to `recheckReview`
  - `reviewStage.execute` dialogue branches in `src/pipeline/stages/review.ts:35` and `:74` — gate on `!ctx.skipLLMReviewers`
- **Existing patterns to follow:**
  - The `ctx.retrySkipChecks` side-channel + runner consumption is the prior art for "tell the review stage which checks to skip without changing its signature."
  - `_autofixDeps` injection pattern (`src/pipeline/stages/autofix.ts:416`) — extend with a new `runReviewStage` dep so the existing dynamic `import("./review")` becomes test-stubbable without `mock.module()` (banned in this repo).

### Failure handling

- **Lite validate throws** → fall back to legacy stale-findings exit (`exitReason: "max-attempts-per-strategy"`, `finalFindings = cycle.findings`). The lite call is advisory; do not consume the `validatorRetries` budget on it. Log at warn level with `storyId`, `packageDir`, `cycleName`, `error`.
- **`agent-gave-up` signal on the terminal attempt** → continues to take priority over the lite-validate branch (ordering at `src/findings/cycle.ts:264-295` is preserved).
- **Lite-mode `failOpen` checks** → vacuous (no LLM checks ran); the fail-closed-on-retry guard at `src/pipeline/stages/autofix.ts:283` is bypassed in lite mode only.

### File-size constraint

`src/pipeline/stages/autofix-cycle.ts` is at the 600-line hard limit declared in `.claude/rules/project-conventions.md`. The change to its `validate` closure must be **line-neutral** — replace existing comment+call pair with a tighter comment+call pair, no net additions.

## Stories

1. **US-001: Widen `FixCycle.validate` signature with `mode` opts arg** — no dependencies
2. **US-002: `runFixCycle` runs lite validate on the terminal iteration of an exhausted cycle** — depends on US-001
3. **US-003: `recheckReview` gains lite mode that skips LLM reviewers via runner + dialogue paths** — no dependencies (can run parallel to US-001)
4. **US-004: Autofix V2 `validate` closure forwards lite mode to `recheckReview`** — depends on US-001 and US-003

---

### US-001: Widen `FixCycle.validate` signature with `mode` opts arg

Pure type widening across the cycle subsystem. Existing call sites pass `{ mode: "full" }`; existing closure definitions accept-and-ignore the new opts arg. No behavior changes.

#### Context Files

- `src/findings/cycle-types.ts` — `FixCycle<F>` definition (modify the `validate` field at line 179)
- `src/findings/cycle.ts` — the single `cycle.validate(ctx)` call site at line 333 (add opts arg)
- `src/pipeline/stages/autofix-cycle.ts` — `validate` closure at line 530 (accept opts, ignore for now)
- `src/execution/lifecycle/acceptance-loop.ts` — `validate` closure at line 297 (accept opts, ignore)
- `test/unit/findings/cycle.test.ts` — `makeCycle` helper signature at line 65 (widen validateFn parameter)

#### Acceptance Criteria

- `FixCycle<F>.validate` accepts `(ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<F[]>` as its type signature
- `runFixCycle` in `src/findings/cycle.ts` calls `cycle.validate(ctx, { mode: "full" })` at its non-terminal validate site
- The `validate` closure constructed in `src/pipeline/stages/autofix-cycle.ts` accepts an `opts: { mode: "full" | "lite" }` parameter
- The `validate` closure constructed in `src/execution/lifecycle/acceptance-loop.ts` accepts an `opts: { mode: "full" | "lite" }` parameter without altering its behavior
- The `makeCycle` test helper in `test/unit/findings/cycle.test.ts` declares its `validateFn` parameter as `(ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<Finding[]>`

---

### US-002: `runFixCycle` runs lite validate on the terminal iteration of an exhausted cycle

Replaces the `allExhausted` early-return block in `src/findings/cycle.ts:297-326` with a lite-validate-then-classify sequence. Detects silent pass on the final fix; produces accurate post-fix findings when escalation is genuinely needed.

#### Context Files

- `src/findings/cycle.ts` — replace the `allExhausted` block at lines 297–326
- `src/findings/cycle-types.ts` — `FixCycleResult`, `IterationOutcome`, `Iteration` shapes (read-only reference)
- `test/unit/findings/cycle.test.ts` — replace the `runFixCycle — skip validate on final allowed attempt` describe block at lines 306–357 with new lite-validate coverage
- `src/findings/cycle.ts:264-295` — the `agent-gave-up` branch that must remain ordered *above* the new lite-validate block (do not reorder)

#### Acceptance Criteria

- When all active strategies have reached `maxAttempts` after the iteration's `fixesApplied`, `runFixCycle` invokes `cycle.validate(ctx, { mode: "lite" })` exactly once
- `runFixCycle` returns `{ exitReason: "resolved", finalFindings: [], exhaustedStrategy: undefined }` when the lite validate returns an empty array (the resolved path does not attribute a cap-exhausted strategy)
- `runFixCycle` returns `{ exitReason: "max-attempts-per-strategy", finalFindings: <lite-validate result>, exhaustedStrategy: <first-strategy-in-group name> }` when the lite validate returns a non-empty array
- The terminal iteration pushed to `cycle.iterations` carries `findingsAfter` equal to the lite validate's return value (not the pre-fix `cycle.findings` snapshot)
- The `outcome` field on the terminal iteration equals `classifyOutcome(findingsBefore, liteFindingsAfter)`
- After the lite validate returns successfully, `cycle.findings` is updated to the lite validate's return value so external readers of the in-memory cycle see the post-fix state
- When `cycle.validate` throws in the lite call, `runFixCycle` returns `{ exitReason: "max-attempts-per-strategy", finalFindings: cycle.findings, exhaustedStrategy: <first-strategy-in-group name> }` (legacy stale-findings fallback) and logs at warn level with `storyId`, `packageDir`, `cycleName`, and `error` fields; the validator-retries budget is not consumed by this advisory call
- On the resolved exit path, `runFixCycle` emits a structured info log with stage `"findings.cycle"` and a data object whose first key is `storyId` and that includes `packageDir`, `cycleName`, and `reason: "resolved"`
- On the cap-exhausted exit path that ran a successful lite validate, `runFixCycle` emits a structured info log with stage `"findings.cycle"` and a data object whose first key is `storyId` and that includes `packageDir`, `cycleName`, `reason: "max-attempts-per-strategy"`, `exhaustedStrategy`, and the count of `liteFindingsAfter`
- When a strategy's `extractApplied` returns `unresolved` on the terminal attempt, `runFixCycle` exits with `exitReason: "agent-gave-up"` without invoking `cycle.validate` (agent-gave-up ordering preserved)

---

### US-003: `recheckReview` gains lite mode that skips LLM reviewers via runner + dialogue paths

Adds an optional `{ lite?: boolean }` argument to `recheckReview` and gates the two LLM entry points in `reviewStage.execute`. Introduces an injectable `_autofixDeps.runReviewStage` so behavior is testable without `mock.module()`.

#### Context Files

- `src/pipeline/stages/autofix.ts` — rewrite `recheckReview` at lines 273–286; extend `_autofixDeps` export at lines 416–420 with a `runReviewStage` field that wraps the existing dynamic `import("./review")` pattern
- `src/pipeline/types.ts` — add `skipLLMReviewers?: boolean` field near the existing `retrySkipChecks` field at line 258
- `src/pipeline/stages/review.ts` — narrow the two dialogue branch conditions at line 35 and line 74 with `&& !ctx.skipLLMReviewers`
- `src/review/runner.ts` — read-only reference for the existing `retrySkipChecks` consumption at line 326
- `test/unit/pipeline/stages/autofix.test.ts` — create new test file mirroring `src/pipeline/stages/autofix.ts`
- `test/unit/pipeline/stages/review.test.ts` — create or extend
- `test/unit/pipeline/stages/autofix-unresolved.test.ts` — read-only reference for the existing `_autofixDeps` stubbing pattern

#### Acceptance Criteria

- `PipelineContext` has an optional `skipLLMReviewers?: boolean` field; unset behaves identically to `false`
- `recheckReview`'s `opts` parameter is optional and defaults to `{}`, so existing callers (`recheckReview(ctx)`) continue to compile and behave as today
- `recheckReview(ctx, { lite: true })` augments `ctx.retrySkipChecks` with `"adversarial"` and `"semantic"` for the duration of its delegated call, then restores the original value (including when the original was `undefined`), **even when the delegated call throws**
- `recheckReview(ctx, { lite: true })` sets `ctx.skipLLMReviewers = true` for the duration of its delegated call, then restores the original value (including when the original was `undefined`), **even when the delegated call throws**
- `recheckReview(ctx, { lite: true })` returns `true` when `ctx.reviewResult.success === true` regardless of whether any check has `failOpen: true` (the fail-closed-on-retry guard is bypassed in lite mode)
- `recheckReview(ctx)` and `recheckReview(ctx, { lite: false })` retain the existing behavior — `failOpen` checks cause a `false` return; `retrySkipChecks` and `skipLLMReviewers` are not mutated
- `_autofixDeps.runReviewStage` is exported as a function `(ctx: PipelineContext) => Promise<void>` that wraps the existing dynamic `import("./review")` + `reviewStage.execute(ctx)` call; `recheckReview` invokes it instead of performing the inline dynamic import
- `_autofixDeps.runReviewStage` returns without invoking `reviewStage.execute` when `reviewStage.enabled(ctx) === false` (preserves the early-return at `src/pipeline/stages/autofix.ts:276`)
- `reviewStage.execute` does not invoke `ctx.reviewerSession.reReview()` when `ctx.skipLLMReviewers === true`, even when `dialogueEnabled` is true and `ctx.reviewerSession` is set
- `reviewStage.execute` does not invoke `ctx.reviewerSession.review()` when `ctx.skipLLMReviewers === true`, even when `dialogueEnabled` is true and `ctx.agentManager` / `ctx.sessionManager` are set
- When `ctx.skipLLMReviewers` is unset or `false`, `reviewStage.execute` dialogue branches execute exactly as today (no behavior change to the existing path)
- When `reviewDebateEnabled === true`, the first dialogue gate is already unreachable (its existing condition includes `!reviewDebateEnabled`) and the second branch's inner `if (!reviewDebateEnabled)` LLM call is also unreachable; control falls through to `reviewFromContext` → `runReview` → `src/review/runner.ts:326`, which honors `ctx.retrySkipChecks`. No additional `skipLLMReviewers` check is required inside the debate branch.

---

### US-004: Autofix V2 `validate` closure forwards lite mode to `recheckReview`

The single-line wiring that activates lite mode end-to-end. Must keep `src/pipeline/stages/autofix-cycle.ts` at or below 600 lines (the project's hard limit).

#### Context Files

- `src/pipeline/stages/autofix-cycle.ts` — `validate` closure at line 530; modify the existing `recheckReview(ctx)` call to forward `opts.mode === "lite"` as `{ lite }`. Net line change must be zero.
- `src/pipeline/stages/autofix.ts` — `recheckReview` signature (read-only reference for the new opts shape)
- `.claude/rules/project-conventions.md` — file-size hard limit reference

#### Acceptance Criteria

- The `validate` closure in `src/pipeline/stages/autofix-cycle.ts` invokes `_autofixDeps.recheckReview(ctx, { lite: opts.mode === "lite" })` on every call
- When `runFixCycle` invokes the closure with `opts.mode === "full"`, the LLM reviewers configured in `config.checks` execute as today (no behavior change to the non-terminal path)
- When `runFixCycle` invokes the closure with `opts.mode === "lite"`, no `adversarial` or `semantic` LLM call is dispatched — including in the dialogue path when `config.review.dialogue.enabled === true`
- No other lines in the `validate` closure body are modified: `iterationBeforeRef` capture via `_autofixCycleGuardDeps.captureGitRef`, `collectCurrentFindings`, `resolveTestFilePatterns`, `validateMockStructureFiles`, the `pendingMockStructureHandoffs` stash, `applyTestEditDeclarations`, and the `ctx.testEditDeclarations` clear-after-consumption all retain their current behavior
- `wc -l src/pipeline/stages/autofix-cycle.ts` reports a line count less than or equal to 600 after the change

---

## Out of Scope

- No changes to `src/agents/`, `src/operations/`, `src/runtime/`, or the adapter/manager/session boundary.
- No new config keys, no schema changes, no migration shims.
- No changes to the V1 autofix loop in `src/pipeline/stages/autofix.ts` beyond the `recheckReview` signature widening.
- No changes to the escalation digest format — only the *content* of `finalFindings` feeding into it improves.
- No changes to the acceptance-loop's validation semantics — it accepts the new opts arg and ignores `mode` because its validator is mechanical-only.
- No optimisation to skip the lite validate when no files changed since the last iteration — left for a follow-up if profiling shows the lite cost matters (see plan §"trade-off").
