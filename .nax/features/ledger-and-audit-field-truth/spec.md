# SPEC: Ledger and Audit Field Truth

## Summary

The cost ledger and the review audit record each drop a field that both sides of
their seam already handle: the producer computes it, the consumer would read it,
and the middleware in between never copies it across. This feature makes
`roundTrips`, `roundTripUnit` and `modelPassed` survive to the persisted record,
attributes error cost rows to a model, and stops a class of successful dispatch
from writing no row at all.

## Motivation

This is the fourth confirmed instance of one seam defect. The 2026-08-01 review
pipeline gap analysis found four dropped fields; #1907 found `acks` and
`blockingThreshold` and shipped a guard test to prevent a fourth pass.

The guard is working as designed and is not itself defective. Its
`ADVERSARIAL_OUTPUT_KEYS` list already names `modelPassed`, so the op-output side
was recorded; what the guard forces is a conscious choice between routing a field
onto `ReviewDecisionEvent` and judging it not worth persisting, and for
`modelPassed` that choice landed on "not routed". This feature revisits it. The
cost-row seam has no equivalent guard at all, which is why `roundTrips` was
dropped silently.

Measured, against the full audit corpus (5,359 review records, all projects):

| quantity | value |
|---|---:|
| adversarial audit records carrying `modelPassed` | 0 of 2,494 |
| cost rows wire-exact, September 2026 | 2 of 50 |
| cost rows with no model, no tokens, no cost | 5 |

Without `roundTrips` on a cost row, `cacheRead` is the only proxy for loop
length, and it cannot separate a long transcript from many turns. Without
`modelPassed`, a `passed:true` verdict carrying an `error`-severity finding
cannot be attributed to the model's own claim or to a miscomputed verdict.

## Design

### Integration

This feature changes four record/event shapes. Baselines are stated only to
locate the code; they are never the interface to implement.

**`CostEvent`** — `src/runtime/cost-aggregator.ts:3` (US-001)
- Baseline: carries `ts`, `runId`, `agentName`, `model`, `stage`, `sessionRole`,
  `tokens`, `estimatedCostUsd`, `exactCostUsd`, `costUsd`, `confidence`,
  `pricingSource`, `durationMs` and related optional attribution fields.
- Target: the same, plus optional `roundTrips` (number), `roundTripUnit`
  (`"model-call" | "agent-run"`), and `usageMissing` (boolean) — **and `tokens`
  becomes optional.** It is required today (`cost-aggregator.ts:50`) while
  `CostErrorEvent.tokens` is already optional (`:113`) for exactly the reason
  AC-10 restates: a zeroed `tokens` re-creates the "failed versus cost-zero"
  ambiguity. AC-10 cannot be satisfied without this change.

**`DispatchErrorEvent`** — `src/runtime/dispatch-events.ts:130` (US-001)
- Baseline: carries `agentName`, `stage`, `errorCode`, `durationMs`,
  `sessionRole`, `tokenUsage`, `estimatedCostUsd`, `exactCostUsd`; it carries no
  model at all.
- Target: the same, plus an optional `model` string.

**`COST_ROW_SCHEMA_VERSION`** — `src/runtime/middleware/cost.ts:38` (US-001)
- Baseline: `3`.
- Target: `4`, with the doc comment above it extended to state what a v4 row
  guarantees, following the convention already used for the v2/v3 boundary.

**`ReviewDecisionPayload`** — `src/execution/story-orchestrator/review-decision.ts:13` (US-002)
- Baseline: carries `reviewer`, `parsed`, `passed`, `failOpen`, `result`,
  `unparsedPreview`, `acks`, `blockingThreshold`.
- Target: the same, plus an optional `modelPassed` boolean.

**`ReviewDecisionEvent`** — `src/runtime/dispatch-events.ts` (US-002)
- Baseline: declares `blockingThreshold`, `acks`, `acDropped`, `advisoryFindings`,
  `unparsedPreview`, `diffAvailable` and the adversarial analysis fields; it
  declares no `modelPassed`.
- Target: the same, plus an optional `modelPassed` boolean.

Only the adversarial op populates `modelPassed` — `SEMANTIC_OUTPUT_KEYS` in the
canary does not list it, and `semanticReviewOp.verify()` does not set it. This
feature does not add it to the semantic path; a semantic output simply has no
`modelPassed`, which is the absent input class AC-3 pins.

Symbols this feature reads but does not change:

- `attachCostSubscriber(bus, aggregator, runId, projectKey?)` —
  `src/runtime/middleware/cost.ts:40`. The only subscriber that builds cost rows.
- `buildDispatchErrorEvent` — `src/agents/manager-dispatch.ts:179`. The only
  producer of a `DispatchErrorEvent`.
- `modelAttribution()` — `src/agents/manager-dispatch.ts:45`. Already resolves
  the model for the success path; the error path reuses it.
- `buildSessionTurnEvent` — `src/agents/manager-dispatch.ts:59`. Already stamps
  `roundTrips` and `roundTripUnit` onto the dispatch event at `:104-105`.
- `emitReviewDecision` — `src/execution/story-orchestrator/review-decision.ts:84`.
  The only live emitter of `review-decision`.
- `AdversarialReviewOutput.modelPassed` — `src/operations/adversarial-review.ts:81`,
  populated by `verify()` at `:567`.

### Approach

Both stories follow the precedent `blockingThreshold` set in #1907: the value is
read off the record the op returned, forwarded by the emitter, and persisted by
the existing writer. No new computation is introduced anywhere — every value this
feature persists is already computed correctly upstream.

`roundTripUnit` travels with `roundTrips` because the two units are not
comparable quantities: native counts model completions, ACP counts delegated
agent runs. A consumer that averages them without the discriminator produces a
meaningless number, so the count is never persisted alone.

The `modelPassed` forwarding is guarded by extending the existing field-forwarding
canary at
`test/unit/execution/story-orchestrator/review-decision-field-forwarding.test.ts`,
which drives the real `verify()` rather than a hand-authored fixture.

### Failure Handling

| condition | behaviour |
|---|---|
| dispatch event is `kind: "complete"`, which declares no round-trip fields | both fields omitted from the cost row, never defaulted |
| dispatch error event carries no model | the error row's `model` is absent, not `"unknown"` |
| op output carries a non-boolean `modelPassed` | the field is absent from the payload |

## Out of Scope

- Repairing the adversarial verdict path that allowed ten historical records to
  carry `passed:true` beside an `error`-severity finding is out of scope for this
  feature. It requires the `modelPassed` data this feature makes observable, and
  is deferred to a follow-up.
- Changes to the telemetry analyzer script `analyze.py` are out of scope. It lives
  outside this repository and no change here can reach it.
- Backfilling, rewriting or migrating cost rows already written at
  `schemaVersion` 3 is out of scope. The schema version is how a consumer
  distinguishes them.
- Making the native path report a wire-exact cost is out of scope. nax-ai supplies
  rates and computes no cost, so no wire cost exists to report.
- The atomicity of `CostAggregator.drain()` under concurrent record-and-drain is
  out of scope and unchanged by this feature.
- Persisting a per-call tool-call count is out of scope. `codingToolUse` exists on
  the native turn result but not on the ACP path, so it has no cross-transport
  meaning.

## Stories

**US-001 — Cost ledger records what it already knows**

Adds round-trip attribution, model attribution on error rows, and a row for
dispatches that currently vanish. Independent of US-002.

### Context Files

**US-001**
- `src/runtime/middleware/cost.ts` — the only cost-row builder; contains the
  early-return being replaced and the `pricingSource` precedence to preserve.
- `src/runtime/cost-aggregator.ts` — `CostEvent` and `CostErrorEvent` shapes.
- `src/runtime/dispatch-events.ts` — `DispatchEvent` and `DispatchErrorEvent`.
- `src/agents/manager-dispatch.ts` — where both events are built, and where
  `modelAttribution()` already resolves the model for the success path.
- `test/unit/runtime/middleware/cost.test.ts` — the existing behaviour pins.

### Modifies

**US-001**
- `test/unit/runtime/middleware/cost.test.ts` — two assertions break against a
  correct implementation. The test named `"#1464: rows carry schemaVersion 3"`
  (`:528-536`) asserts `schemaVersion` is exactly `3`; under AC-12 it becomes
  `4`. The test named `"skips emit when no tokenUsage and no exactCostUsd"`
  (`:105`) asserts that this dispatch records nothing; under AC-8 it records
  exactly one row carrying `usageMissing: true`. US-001 owns updating both to the
  new invariants.

**US-002 — Review audit records verdict provenance**

Forwards the model's own pass claim to the persisted audit record. Independent of
US-001.

### Context Files

**US-002**
- `src/execution/story-orchestrator/review-decision.ts` — `toReviewDecisionPayload`
  and `emitReviewDecision`; the `blockingThreshold` precedent at `:112-118`.
- `src/runtime/dispatch-events.ts` — `ReviewDecisionEvent`.
- `src/runtime/middleware/review-audit.ts` — the audit subscriber.
- `src/operations/adversarial-review.ts` — where `modelPassed` is populated.
- `test/unit/execution/story-orchestrator/review-decision-field-forwarding.test.ts`
  — the #1907 canary this story extends.

### Seams

No cross-story seam exists: US-001 and US-002 share no symbol and neither
consumes the other's output. Each story's own wiring is proven by an acceptance
criterion that enters at its production emitter rather than at an internal
helper — the dispatch bus for US-001, `emitReviewDecision` for US-002.

## Acceptance Criteria

### US-001 — Cost ledger records what it already knows

1. `[unit]` Emitting a session-turn dispatch event carrying `roundTrips: 7` and
   `roundTripUnit: "model-call"` on the dispatch bus records a cost row whose
   `roundTrips` equals `7`.
2. `[unit]` That same recorded cost row carries `roundTripUnit` equal to
   `"model-call"`.
3. `[unit]` Emitting a session-turn dispatch event carrying `roundTrips: 3` and
   `roundTripUnit: "agent-run"` records a cost row whose `roundTripUnit` equals
   `"agent-run"`.
4. `[unit]` Emitting a `complete`-kind dispatch event, which declares no
   round-trip fields, records a cost row on which both `roundTrips` and
   `roundTripUnit` are absent rather than defaulted to `1`.
5. `[unit]` `buildDispatchErrorEvent` returns a `DispatchErrorEvent` whose `model`
   equals the model resolved by `modelAttribution()` for that dispatch.
6. `[unit]` Emitting a dispatch error event carrying `model:
   "anthropic/claude-sonnet-5"` records an error row whose `model` equals
   `"anthropic/claude-sonnet-5"`.
7. `[unit]` Emitting a dispatch error event carrying no model records an error row
   on which `model` is absent, rather than the string `"unknown"`.
8. `[unit]` Emitting a successful session-turn dispatch event whose `tokenUsage`
   is undefined and whose `exactCostUsd` is `0` records exactly one cost row.
9. `[unit]` That recorded row carries `usageMissing` equal to `true`.
10. `[unit]` That recorded row has no `tokens` field, rather than a `tokens` object
    with `input` and `output` both `0`.
11. `[unit]` Emitting a successful session-turn dispatch event that carries token
    usage records a cost row on which `usageMissing` is absent.
12. `[unit]` A cost row recorded from a session-turn dispatch event carries
    `schemaVersion` equal to `4`.
13. `[unit]` An error row recorded from a dispatch error event carries
    `schemaVersion` equal to `4`.

### US-002 — Review audit records verdict provenance

1. `[unit]` `toReviewDecisionPayload` called with an adversarial op output whose
   `modelPassed` is `true` returns a payload whose `modelPassed` is `true`.
2. `[unit]` `toReviewDecisionPayload` called with an adversarial op output whose
   `modelPassed` is `false` returns a payload whose `modelPassed` is `false`,
   rather than dropping the field as falsy.
3. `[unit]` `toReviewDecisionPayload` called with an op output carrying no
   `modelPassed` returns a payload on which `modelPassed` is absent.
4. `[unit]` `toReviewDecisionPayload` called with an op output whose `modelPassed`
   is the string `"yes"` returns a payload on which `modelPassed` is absent.
5. `[integration]` Driving the real `adversarialReviewOp.verify()` on an output
   whose model claimed a pass and then calling `emitReviewDecision` produces a
   `ReviewDecisionEvent` carrying `modelPassed`.
6. `[integration]` `emitReviewDecision` for an adversarial op output whose
   `modelPassed` is `false` produces a persisted review audit record whose
   `modelPassed` is `false`.
7. `[integration]` `emitReviewDecision` for an op output that failed to parse but
   carries `modelPassed` produces an audit record that preserves `modelPassed`,
   matching how `blockingThreshold` is read outside the parsed branch.

<!-- spec-writing: completed-through-phase-6 -->
