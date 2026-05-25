# SPEC: Same-session re-prompt when AC-grounding drops all blocking findings

**Issue:** #1105 (companion to #1100 / #1101 ungrounded-drop telemetry)
**Status:** Draft
**Stage:** Spec → review → implement
**Size:** ~120 LoC op-side (adversarial + semantic hop steps + helpers) + 2 prompt-builder methods + `AcDroppedEntry<F>` shared type + `acRegroundOnDrop` schema field (×2) + new `dispatchEvent` variant + 4 test files

## Problem

When an LLM reviewer (adversarial or semantic) emits `passed: false` with one or more blocking-severity findings, but every blocking finding is rejected by the AC-grounding filter (`filterByAcQuote` / `filterByAcGroundingMinimal`), the wrapper currently **fail-closes** with `passed: false` and 0 surviving findings.

Observed failure mode (`logs/2026-05-25T10-51-44.jsonl` lines 367–375):

| Step | Outcome |
|:---|:---|
| Model emits 1 blocking finding flagging a real test regression (`portalocker.LockException` vs `CacheLockTimeoutError` in `test_locking.py:75`) | concern is substantively correct |
| Finding tagged with `acIndex: 0` (invalid — `acIndex` is 1-based per `adversarial-prompt-builder.ts`) | `filterByAcQuote` rejects → `acDropped` |
| Wrapper: `blockingFindings.length === 0 && !opResult.passed && acDropped.length > 0` → fail-closed | `passed: false`, `findings: []`, output says "dropped as ungrounded" |
| Orchestrator: escalates story to next tier (`balanced` → `powerful`) | the substantive concern is **discarded** along with the formatting error; the next tier may not re-find it |

The root cause is a **prompt-grounding error** (model used `acIndex: 0`), not a wrong verdict. Tier escalation is an expensive, blunt response to a formatting issue — it pays a powerful-tier session to re-derive a concern the fast tier already found. Worse: the dropped finding may simply be lost if the powerful tier doesn't reach the same regression.

## Goal

Give reviewers **one** in-session opportunity to re-emit dropped blocking findings with corrected AC grounding before the wrapper fail-closes. Preserves the model's substantive judgment when the only error was a formatting/grounding violation; falls back to today's behavior when the re-prompt also fails.

## Non-goals

- **Do not** flip `passed: true` when findings are dropped — concerns the model raised are not silently discarded.
- **Do not** retry on truncation (`looksLikeFail`) — that path is already handled by the parse-retry strategy.
- **Do not** retry on `failOpen` — the wrapper's existing fail-open behavior is correct for genuinely unparseable output.
- **Do not** retry more than once per review session — re-prompts that fail twice indicate a deeper model issue, not a formatting glitch; let escalation take over.
- **Do not** thread re-prompt through `op.retry` — `op.retry` handles parse failures, not post-verify semantic-validity drops. The hop body is the correct seam.

## Scope of impact

| Reviewer | Drops surfaced at op layer today? | Change needed |
|:---|:---|:---|
| Adversarial (`src/operations/adversarial-review.ts`) | ✅ `AdversarialReviewOutput.acDropped` exists (line 64) | Add hop step in `hopBody`; new builder method; threading |
| Semantic (`src/operations/semantic-review.ts:165`) | ❌ `SemanticReviewOutput` does **not** expose drops — `filterByAcGroundingMinimal`'s `dropped` is destructured away | Add `acDropped` to `SemanticReviewOutput`; thread from `verify()` filter; then same hop step |
| Semantic (debate path, `src/review/semantic-debate.ts:238-247`) | ✅ `acDropped` computed and logged but not re-prompted | Out of scope — debate already has multi-round structure; add re-prompt here in a follow-up. |

Yes, **semantic single-pass faces the identical failure mode** as adversarial. The wrapper at `src/review/semantic.ts:477-509` mirrors the adversarial fail-closed branch (`if (!opResult.passed && allFindings.length === 0)`). Semantic just doesn't surface drops at the op layer today, so the orchestrator log has never had drop context to print and the re-prompt path is unreachable. Both ship together.

## Trigger condition

Re-prompt fires in the hop body if and only if **all** of:

1. The model emitted `passed: false`.
2. `blockingFindings.length === 0` after AC-grounding filter — every blocking finding was rejected.
3. `acDropped.length > 0` — drops are the *reason* findings vanished (not "model emitted no findings at all").
4. The re-prompt has not yet fired in this `hopBody` invocation (structurally guaranteed — `hopBody` runs once per session turn; see § Design "Re-prompt-once guard").
5. Config gate `review.adversarial.acRegroundOnDrop` (or `review.semantic.acRegroundOnDrop`) is enabled — defaults `true`.

If any of (1)–(4) fails, behavior is identical to today. If (5) is disabled, behavior is identical to today.

## Design

### Architectural seam

The re-prompt runs **inside `hopBody`**, not inside `verify()`. Per the existing op contract (`src/operations/types.ts:122-159`), `verify()` is a pure transformation that receives `(parsed, input, verifyCtx)` and cannot issue agent turns. `hopBody` is the only seam that owns `ctx.send` / `ctx.sendWithParseRetry`, returns a `TurnResult`, and runs before the framework's outer `parse()` + `verify()` chain. The existing same-session requote loop (`requoteBlockingAdversarialFindings`, `src/operations/adversarial-review.ts:90-150`) already follows this pattern.

The hop step **does not call `op.verify()` directly**. Instead it probes the AC-grounding filter (`filterByAcQuote` for adversarial; `filterByAcGroundingMinimal` for semantic — both already imported by the ops) to decide whether to re-prompt. If a re-prompt happens, hopBody synthesises a `TurnResult` whose `output` is the merged JSON; the framework's standard `parse()` + `verify()` then runs once on that merged output, producing the final `AdversarialReviewOutput` / `SemanticReviewOutput`.

### Op-side: hop step (adversarial)

In `adversarialReviewOp.hopBody`, between the first `sendWithParseRetry` and the existing requote loop:

```typescript
const first = await ctx.sendWithParseRetry(initialPrompt);
const firstShape = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(first.output));
if (!firstShape) return first;  // parse() will handle FAIL_OPEN / looksLikeFail

const trigger = evaluateRepromptTrigger(firstShape, ctx.input);
if (!trigger.shouldReprompt) return first;

const dropPrompt = AdversarialReviewPromptBuilder.regroundDroppedFindings({
  drops: trigger.acDropped,                          // typed: AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[]
  acceptanceCriteria: ctx.input.story.acceptanceCriteria,
});
const second = await ctx.send(dropPrompt);
const secondShape = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(second.output));
if (!secondShape) return first;  // re-prompt unparseable → preserve first-pass fail-closed behavior

const merged = mergeAdversarialResponses(firstShape, secondShape);  // unions advisories; replaces blocking
return { ...second, output: JSON.stringify(merged) };
```

`evaluateRepromptTrigger` is the trigger condition above, encapsulated:

```typescript
function evaluateRepromptTrigger(
  shape: ValidatedAdversarialShape,
  input: AdversarialReviewInput,
): { shouldReprompt: false } | { shouldReprompt: true; acDropped: AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[] } {
  if (input.adversarialConfig.acRegroundOnDrop === false) return { shouldReprompt: false };
  if (shape.passed) return { shouldReprompt: false };
  const { accepted, dropped } = filterByAcQuote(shape.findings, input.story.acceptanceCriteria);
  const threshold = input.blockingThreshold ?? "error";
  const blockingAccepted = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
  if (blockingAccepted.length > 0) return { shouldReprompt: false };  // some blocking survived
  if (dropped.length === 0) return { shouldReprompt: false };          // not a drop scenario
  return { shouldReprompt: true, acDropped: dropped };
}
```

`mergeAdversarialResponses` returns a `ValidatedAdversarialShape` that unions advisories from both passes and replaces `passed` + `findings` (blocking-severity) with the re-prompt's response. Returning the merged JSON as the synthesised `TurnResult.output` means the outer `parse()` + `verify()` chain runs once on the merged input — the framework still owns final filtering, so there's no double-substantiation and no behavior split.

**Re-prompt-once guard.** Because hopBody is invoked once per session turn and `sendWithParseRetry` exhausts inside one invocation, there is no in-session loop that could re-enter the trigger. AC5 is satisfied structurally; no explicit `hasReprompted` flag is needed.

### Op-side: hop step (semantic)

Identical structure, with substitutions:
- `validateAdversarialShape` → `validateLLMShape` (the existing semantic-side validator at `src/operations/semantic-review.ts:70, 128`)
- `AdversarialReviewPromptBuilder.regroundDroppedFindings` → `ReviewPromptBuilder.regroundDroppedFindings`
- `filterByAcQuote` → `filterByAcGroundingMinimal` (note: this filter emits `AcGroundingMinimalRejection` codes, **not** `AcQuoteRejectionCode` — see Pre-condition #1)
- `AdversarialLLMFinding` → `LLMFinding`
- `AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>` → `AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>`
- `input.adversarialConfig.acRegroundOnDrop` → `input.semanticConfig.acRegroundOnDrop`
- `mergeAdversarialResponses` → `mergeSemanticResponses`
- `ValidatedAdversarialShape` → `ValidatedSemanticShape`

The pre-condition refactor (surface `acDropped` on `SemanticReviewOutput`) is part of this work — see § "Pre-conditions" and AC7.

### Prompt builders: `regroundDroppedFindings`

Two new static methods, one per existing builder class — no new builder files (per `forbidden-patterns.md` → Prompt Builder Convention):

| Method | File | Class |
|:---|:---|:---|
| `AdversarialReviewPromptBuilder.regroundDroppedFindings` | `src/prompts/builders/adversarial-review-builder.ts` | existing class (line 284) |
| `ReviewPromptBuilder.regroundDroppedFindings` | `src/prompts/builders/review-builder.ts` | existing class (line 98) — semantic side |

**No new `SemanticReviewPromptBuilder` class.** Semantic prompts already live on `ReviewPromptBuilder` (`src/prompts/builders/review-builder.ts:98`); add `regroundDroppedFindings` alongside `jsonRetry`, `jsonRetryCondensed`, etc.

**Drop-code translation.** The internal drop-code enums (`AcQuoteRejectionCode` at `src/review/ac-quote-validator.ts:31-35` for adversarial; `AcGroundingMinimalRejection` at `src/review/ac-quote-validator.ts:181` for semantic) are snake_case implementation identifiers and MUST NOT be emitted raw to the LLM. Each builder owns its own translation table mapping enum → human-readable message:

```typescript
// src/prompts/builders/adversarial-review-builder.ts
const DROP_CODE_MESSAGES_QUOTE: Record<AcQuoteRejectionCode, string> = {
  missing_ac_quote: "no `acQuote` field was provided — every blocking finding must cite an AC",
  ac_index_out_of_range: "`acIndex` is 0 or larger than the AC list — ACs are 1-indexed; the lowest valid value is 1",
  ac_quote_not_substring: "`acQuote` text does not appear verbatim in any AC bullet — copy the AC text character-for-character",
  ac_quote_does_not_constrain_locus: "the cited AC mentions the file but not the specific symbol your finding flags — pick a different AC, or downgrade to `info` / `warning`",
};

// src/prompts/builders/review-builder.ts (semantic side)
// AcGroundingMinimalRejection has exactly these 2 variants — table is complete.
const DROP_CODE_MESSAGES_MINIMAL: Record<AcGroundingMinimalRejection, string> = {
  missing_ac_index: "no `acIndex` field was provided — every blocking finding must cite an AC by 1-based index",
  ac_index_out_of_range: "`acIndex` is 0 or larger than the AC list — ACs are 1-indexed; the lowest valid value is 1",
};
```

The two tables stay co-located with their respective builders so each prompt-construction site reaches for the table that matches its filter's code domain. Unifying the enums (so a single translation table could cover both) is explicitly out of scope.

Example output (information-additive only — does not coerce a verdict):

```
Your prior response emitted `passed: false` with N blocking finding(s), but ALL were dropped
by the AC-grounding filter:

  1. packages/core/tests/unit/_internal/test_locking.py:75
     Issue: <verbatim `issue` field from the dropped finding>
     Drop reason: `acIndex` is 0 or larger than the AC list — ACs are 1-indexed; the lowest valid value is 1.

  2. ...

The substantive concerns may be real. Re-emit each finding with corrected grounding:

- `acIndex` MUST be 1-based (first AC = 1, second = 2, ...)
- `acQuote` MUST be a verbatim substring of the AC bullet text — copy it exactly
- If you cannot find an AC bullet that names the *specific symbol* in your finding,
  downgrade severity to "info" or "warning" — these will not block the story.
- If you genuinely cannot ground a concern in any AC, OMIT it (do not emit at error severity).

Respond with the same JSON shape as before. Include all advisory findings from your prior
response unchanged; only blocking findings are being re-evaluated.
```

The model may legitimately re-respond with `passed: true` and 0 findings ("on reflection, I cannot ground these concerns"), in which case the wrapper passes the story — that's the correct outcome.

### Wrapper changes

`src/review/adversarial.ts` and `src/review/semantic.ts`: **none**. The wrapper sees `verified` (post-re-prompt-merge) and routes through the existing branches. The fail-closed-on-drop branch still exists as the fallback for "re-prompt also failed."

### Config

Add to `ReviewConfig`:

```typescript
{
  adversarial: {
    acRegroundOnDrop?: boolean;  // default true
    // ... existing fields
  },
  semantic: {
    acRegroundOnDrop?: boolean;  // default true
    // ... existing fields
  }
}
```

Defaults `true` because the failure mode is common and the cost is one extra turn per affected review (an order of magnitude cheaper than tier escalation).

### Telemetry

Emit a `dispatchEvent` for visibility. Per `project-conventions.md` → "Structured Log Fields", `storyId` is the first field; the dispatch envelope already carries `runId` so it's not duplicated here.

| Field | Value |
|:---|:---|
| `kind` | `"review-reprompt-on-drop"` |
| `storyId` | `ctx.input.story.id` (mandatory, first key) |
| `reviewer` | `"adversarial" \| "semantic"` |
| `dropCount` | number of findings the first pass dropped |
| `repromptOutcome` | `"recovered-blocking" \| "recovered-advisory-only" \| "still-dropped" \| "parse-failed"` |
| `costUsd` | re-prompt turn cost |

Added as a new variant in `src/runtime/dispatch-events.ts` (sibling to the existing `kind: "review-decision"` at line 84). Used for offline analysis to validate that the feature actually recovers real findings and isn't just paying tokens to confirm drops.

## Pre-conditions to ship

1. **Declare `AcDroppedEntry<F, C>` as a shared exported type.** Add to `src/review/ac-quote-validator.ts` alongside the existing `AcQuoteRejectionCode` and `AcGroundingMinimalRejection`:
   ```typescript
   export interface AcDroppedEntry<F, C> {
     finding: F;
     code: C;
   }
   ```
   The two-parameter generic is required because the two AC-grounding filters return drops with **different code enums**: `filterByAcQuote` (adversarial) emits `AcQuoteRejectionCode`; `filterByAcGroundingMinimal` (semantic) emits `AcGroundingMinimalRejection`. A single-generic `AcDroppedEntry<F>` cannot type both reviewers without conflating distinct domains.

   Replace the existing inline shape on `AdversarialReviewOutput.acDropped` (currently `{ finding: AdversarialLLMFinding; code: AcQuoteRejectionCode }[]` at `src/operations/adversarial-review.ts:64`) with `AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[]`. New `SemanticReviewOutput.acDropped` uses `AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[]`.

2. **Export `ValidatedAdversarialShape` and `ValidatedSemanticShape`** as named types from their respective op modules. Today both are inferred return types of `validateAdversarialShape` (adversarial-review.ts) and `validateLLMShape` (semantic-review.ts). The new `evaluateRepromptTrigger` / `mergeAdversarialResponses` / `mergeSemanticResponses` helpers require expressible signatures.

   ```typescript
   // src/operations/adversarial-review.ts
   export type ValidatedAdversarialShape = NonNullable<ReturnType<typeof validateAdversarialShape>>;

   // src/operations/semantic-review.ts
   export type ValidatedSemanticShape = NonNullable<ReturnType<typeof validateLLMShape>>;
   ```

3. **Surface `acDropped` on `SemanticReviewOutput`.** Small refactor in `semanticReviewOp.verify()` (`src/operations/semantic-review.ts:165`) — it currently runs `filterByAcGroundingMinimal` and destructures `{ accepted }`, dropping the `dropped` array on the floor. Capture and return it.

4. **Add `acRegroundOnDrop?: boolean` to both review-config sub-schemas** in `src/config/schemas-review.ts` (`SemanticReviewConfigSchema`, `AdversarialReviewConfigSchema`). Default `true` via `z.boolean().default(true)`. Threads to the op via existing `input.adversarialConfig` / `input.semanticConfig`.

## Verification anchors

Source (modify):
- `src/operations/adversarial-review.ts` — add hop step in existing `hopBody`; `evaluateRepromptTrigger` + `mergeAdversarialResponses` helpers; export `ValidatedAdversarialShape`; switch inline `acDropped` shape to `AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[]`
- `src/operations/semantic-review.ts` — add hop step in existing `hopBody`; `evaluateRepromptTrigger` + `mergeSemanticResponses` helpers; export `ValidatedSemanticShape`; add `acDropped: AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[]` to `SemanticReviewOutput`; thread `dropped` from `filterByAcGroundingMinimal`
- `src/prompts/builders/adversarial-review-builder.ts` — `AdversarialReviewPromptBuilder.regroundDroppedFindings` static method + `DROP_CODE_MESSAGES_QUOTE` table (class already exists, line 284)
- `src/prompts/builders/review-builder.ts` — `ReviewPromptBuilder.regroundDroppedFindings` static method + `DROP_CODE_MESSAGES_MINIMAL` table (class already exists, line 98)
- `src/review/ac-quote-validator.ts` — export `AcDroppedEntry<F, C>` interface
- `src/config/schemas-review.ts` — add `acRegroundOnDrop` to both schemas
- `src/runtime/dispatch-events.ts` — add `kind: "review-reprompt-on-drop"` variant

Tests (new files):
- `test/unit/operations/adversarial-review-reprompt-on-drop.test.ts`
- `test/unit/operations/semantic-review-reprompt-on-drop.test.ts`
- `test/unit/prompts/regrounding-prompt-builder.test.ts`
- `test/integration/review/reprompt-on-drop.test.ts` (end-to-end via mocked agent)

## Acceptance criteria

[verbatim] [unit] **AC1.** When the first-pass parsed response satisfies `passed === false` and after running `filterByAcQuote(findings, story.acceptanceCriteria)` the result has `acceptedBlocking.length === 0` and `dropped.length >= 1`, and `input.adversarialConfig.acRegroundOnDrop !== false`, then `adversarialReviewOp.hopBody` MUST issue exactly one additional `ctx.send` whose prompt body contains the verbatim `dropped[0].finding.issue` string and the human-readable translation of `dropped[0].code` from `DROP_CODE_MESSAGES_QUOTE`.

[verbatim] [unit] **AC2.** When the re-prompt response parses (`validateAdversarialShape` returns non-null) to a shape with `passed === true` and zero blocking-severity findings after `filterByAcQuote`, `adversarialReviewOp.hopBody` MUST return a `TurnResult` whose `output` is a JSON string that parses to `{ passed: true, findings: [<union of advisory findings from both passes>] }`. The framework's outer `parse()` + `verify()` chain MUST then produce an `AdversarialReviewOutput` with `passed: true`.

[verbatim] [unit] **AC3.** When the re-prompt response parses to a shape with at least one blocking-severity finding that survives `filterByAcQuote`, `adversarialReviewOp.hopBody` MUST return a `TurnResult` whose `output` JSON includes the surviving re-grounded blocking finding in `findings`, and the framework's outer `verify()` MUST yield an `AdversarialReviewOutput` with `passed: false` and that finding present in `findings` / `normalizedFindings`.

[verbatim] [unit] **AC4.** When the re-prompt response fails to parse (`tryParseLLMJson` returns `null` OR `validateAdversarialShape` returns `null`) OR the re-prompt also drops all blocking findings via `filterByAcQuote`, `adversarialReviewOp.hopBody` MUST return the first-pass `TurnResult` unchanged — preserving today's fail-closed behavior byte-identically.

[verbatim] [unit] **AC5.** `adversarialReviewOp.hopBody` MUST issue at most one re-prompt per invocation. No `hasReprompted` flag is required: the structural guarantee comes from `hopBody` being invoked once per session turn and `evaluateRepromptTrigger` running exactly once between the first `sendWithParseRetry` and the optional re-prompt `ctx.send`.

[verbatim] [unit] **AC6.** When `input.adversarialConfig.acRegroundOnDrop === false`, `evaluateRepromptTrigger` MUST return `{ shouldReprompt: false }` regardless of `dropped.length`, and `adversarialReviewOp.hopBody` MUST NOT issue any additional `ctx.send` — behavior is byte-identical to the pre-feature baseline.

[verbatim] [unit] **AC7.** `SemanticReviewOutput` MUST expose `acDropped: AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[]` populated by `semanticReviewOp.verify()` from the `dropped` array returned by `filterByAcGroundingMinimal`. `semanticReviewOp.hopBody` MUST implement the same trigger / re-prompt / merge / fallback pattern as `adversarialReviewOp.hopBody`, gated on `input.semanticConfig.acRegroundOnDrop`, using `validateLLMShape`, `ReviewPromptBuilder.regroundDroppedFindings`, `DROP_CODE_MESSAGES_MINIMAL`, and `mergeSemanticResponses`.

[verbatim] [unit] **AC8.** A `dispatchEvent` of `kind: "review-reprompt-on-drop"` MUST be emitted exactly once per re-prompt occurrence (zero events when no re-prompt fires). The payload MUST have `storyId` as the first key (per `project-conventions.md`), followed by `reviewer`, `dropCount`, `repromptOutcome`, and `costUsd` — all populated, none undefined.

[verbatim] [file] **AC9.** `src/review/ac-quote-validator.ts` MUST export the two-parameter generic interface `AcDroppedEntry<F, C>`, and both `src/operations/adversarial-review.ts` and `src/operations/semantic-review.ts` MUST import `AcDroppedEntry` from there. The inline `{ finding: AdversarialLLMFinding; code: AcQuoteRejectionCode }[]` shape at the current line 64 of `adversarial-review.ts` MUST be replaced by `AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[]`; `SemanticReviewOutput.acDropped` MUST be typed as `AcDroppedEntry<LLMFinding, AcGroundingMinimalRejection>[]`. Zero occurrences of the literal pattern `{ finding: <Type>; code: AcQuoteRejectionCode }[]` or `{ finding: <Type>; code: AcGroundingMinimalRejection }[]` remain anywhere under `src/`.

[verbatim] [integration] **AC10.** Given a feature with one user story whose acceptance criteria intentionally trigger an adversarial reviewer to emit `passed: false` with all findings tagged `acIndex: 0` (forcing `ac_index_out_of_range` drops), and a mocked adversarial agent that responds correctly on the second turn, the integration test MUST observe: (a) two `ctx.send` invocations on the adversarial session, (b) final `AdversarialReviewOutput.passed === true` or `passed === false` with at least one blocking finding visible (depending on the mock's second response), and (c) one `dispatchEvent` of `kind: "review-reprompt-on-drop"`.

## Risks & mitigations

| Risk | Mitigation |
|:---|:---|
| Re-prompt costs add up across many stories | Default-on but config-gated; ship telemetry first run to measure recovery rate; cut feature if <20% of re-prompts recover real findings. |
| Model loops re-emitting the same ungrounded finding | Structural one-shot — `hopBody` is invoked once per session turn, and `evaluateRepromptTrigger` runs exactly once between the first `sendWithParseRetry` and the optional re-prompt `ctx.send`. No flag needed; see § Design "Re-prompt-once guard". |
| Re-prompt response contradicts the first pass in confusing ways (e.g., emits findings unrelated to the drops) | Wrapper still validates the re-prompt's findings against the AC filter; ungrounded re-emissions get dropped again and fall through to fail-closed. The merge logic keeps advisory findings from both passes to avoid losing information. |
| Drop-code strings are not user-friendly | Builder-owned `DROP_CODE_MESSAGES_QUOTE` / `DROP_CODE_MESSAGES_MINIMAL` tables translate raw snake_case enums into prose before they reach the LLM. The enums themselves stay internal. |

## Open questions

- Should the re-prompt include the **diff** again, or trust that the in-session context carries it? Adversarial review fetches the diff via tool calls inside the session, so the model should still have it. Recommendation: do not re-include — keep the re-prompt focused on the grounding correction.
- Should `severity: "unverifiable"` findings count toward the trigger? Today they don't (only blocking-severity findings can be dropped by AC-grounding). Confirm during implementation: if `unverifiable` findings can be dropped, decide whether to re-prompt on those too.

## Decomposition hint for `nax plan`

10 ACs exceed the per-story cap of 8. Suggested split:

- **US-001 — Shared infrastructure** (AC9): export `AcDroppedEntry<F, C>` from `src/review/ac-quote-validator.ts`; export `ValidatedAdversarialShape` and `ValidatedSemanticShape` from their op modules; migrate `adversarial-review.ts` inline shape to `AcDroppedEntry<AdversarialLLMFinding, AcQuoteRejectionCode>[]`. Pure refactor, no behavior change.
- **US-002 — Adversarial re-prompt** (AC1, AC2, AC3, AC4, AC5, AC6): hop step + `evaluateRepromptTrigger` + `mergeAdversarialResponses` + builder method + `DROP_CODE_MESSAGES_QUOTE` + config flag + `dispatchEvent` variant — adversarial only.
- **US-003 — Semantic re-prompt** (AC7): surface `acDropped` on `SemanticReviewOutput` (typed via shared `AcDroppedEntry`); hop step for semantic; builder method + `DROP_CODE_MESSAGES_MINIMAL`.
- **US-004 — End-to-end gate** (AC8, AC10): integration test driving both reviewers + telemetry event assertion.

US-002 owns the rollout flag flip; US-003 ships behind opt-in until US-004 confirms recovery rate.

## Rollout

1. **Phase 1** — Ship telemetry only (no re-prompt). One release of `dispatchEvent: "review-reprompt-on-drop-trigger-observed"` to measure trigger frequency in production.
2. **Phase 2** — Ship adversarial re-prompt behind `acRegroundOnDrop: false` default. Manual opt-in for early adopters.
3. **Phase 3** — Flip adversarial default to `true` after recovery-rate evidence.
4. **Phase 4** — Add `acDropped` to `SemanticReviewOutput`, ship semantic re-prompt behind opt-in flag.
5. **Phase 5** — Flip semantic default.

Each phase is independently revertible.
