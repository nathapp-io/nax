# Ledger and audit field truth — design

- **Opened:** 2026-09-08
- **Master plan:** `projects/nax/nax-harness-improvement-plan.md` items R15, R16 (R6 partially)
- **Base:** main `61ea65714`

## 1. Problem

Two records nax writes on every run — the cost row and the review audit record —
each drop a field that both sides of their seam already handle. The value is
produced correctly, the consumer would read it correctly, and the middleware in
between never copies it across.

This is not a new class of bug. It is the fourth confirmed instance of the same
seam defect:

| pass | fields dropped | fixed by |
|---|---|---|
| 1 | four fields in the review pipeline | `docs/findings/2026-08-01-review-pipeline-gap-analysis.md` |
| 2 | `acks` | #1907 |
| 3 | `blockingThreshold` | #1907 |
| 4 | `roundTrips`, `roundTripUnit`, `modelPassed` | this spec |

#1907 shipped a canary guard intended to make a fourth pass impossible. It did
not catch these, which is itself a finding this spec acts on.

### 1.1 Measured evidence

Cost rows, September 2026: 2 of 50 rows wire-exact (4%), against August's 44%;
5 rows with no model, no tokens and no cost.

Review audit records, all projects, 5,359 records:

| quantity | value |
|---|---:|
| adversarial records carrying `modelPassed` | **0 of 2,494** |
| Aug records with `passed:true` and non-empty findings | 353 |
| of those, at least one `error`-severity finding | **9** |
| Jul equivalent | 505 → **1** |
| Sep equivalent | 19 → **0** |

## 2. What is actually wrong

### 2.1 R15's stated target is unreachable, and its real defects are elsewhere

The master plan sets R15's verification at "wire-exact share > 90%". A row is
wire-exact only when `pricingSource === "wire"`, which `middleware/cost.ts:103`
stamps only when `exactCostUsd` is a finite number. The native adapter
deliberately never sets `exactCostUsd` — `native/adapter.ts:195-196`: "nax-ai
supplies rates and computes no cost, so nothing here is exact."

Therefore every native row is `confidence: "estimated"` by construction, and the
wire-exact share falls mechanically as native's share of calls grows. September's
44% → 4% is substantially the acpx-to-native migration, not an instrumentation
regression. Meeting the stated target would require inventing a wire cost that no
provider reported.

The defects underneath the metric are real, and they are these:

1. **Model-blind error rows.** `CostErrorEvent.model` is declared
   (`cost-aggregator.ts:101`) but never populated, because `DispatchErrorEvent`
   (`dispatch-events.ts:130-151`) carries no `model` field at all and
   `buildDispatchErrorEvent` (`manager-dispatch.ts:179-239`) never sets one. Every
   error row is unattributed regardless of what else is known about it.

2. **Silent drop.** `middleware/cost.ts:60` — `if (!tu && exactCostUsd === 0) return;`
   A successful dispatch whose adapter returned no `tokenUsage` and no cost writes
   **no row at all**, not even an error row. The call is invisible in the ledger,
   so run totals are a floor and the call count is wrong.

3. **Provenance is already recorded, but never read.** `confidence`
   (`cost.ts:56-58`) collapses to `estimated` for every native row, so a rate from
   nax-ai's own catalog looks identical to one from the generic `$3/$15` fallback
   card (`agents/cost/calculate.ts:150-159`). `pricingSource` already draws that
   distinction correctly, on every row, today. Nothing in this repo needs to
   change: the fix is that the analyzer must group by `pricingSource` instead of
   reporting a single wire-exact percentage. Recorded here because it is what
   replaces R15's metric, not because it is code work.

### 2.2 R16 is one line of forwarding, not an instrumentation project

`internalRoundTrips` already exists and already reaches the dispatch event:

- native counts LLM completions — `turn-loop.ts:161`, incremented `:339`,
  returned `:507`
- ACP counts delegated agent runs — `adapter.ts:409`, returned
  `adapter-output.ts:245`
- both flow through `AgentResult.internalRoundTrips` (`agents/types.ts:98`) into
  `manager-dispatch.ts:104-105`, which stamps **both** `roundTrips` and a
  `roundTripUnit` discriminator (`"model-call"` vs `"agent-run"`)
- `middleware/audit.ts:24-25` reads them; `prompt-auditor.ts:172-174` renders
  `ModelCalls:` / `AgentRuns:`

`middleware/cost.ts` builds its `CostEvent` off the same event and never reads
either field. The `audit-turn-ordinal` design (2026-09-04, line 235) put
"persisting or aggregating the round-trip counts beyond the audit record"
explicitly out of scope — this spec is that follow-up.

**The unit must travel with the count.** A `model-call` and an `agent-run` are not
comparable quantities; a consumer that averages them without the discriminator
produces a meaningless number. Emitting `roundTrips` alone would be worse than
emitting nothing.

### 2.3 R6's premise is mostly a counting artifact, and its residue is undiagnosable today

`analyze.py:194` computes the metric as
`sum(1 for d in rev if d.get("passed") and d["_findings"])`, with no severity
check, where `_findings` is `result.findings` — the *accepted* bucket, which
includes sub-threshold advisories.

But `passed` is already threshold-derived at both reviewers
(`semantic-review.ts:456` and `adversarial-review.ts:560`, identical):

```ts
const passed = blocking.length === 0 && (parsed.passed || accepted.length > 0);
```

So `passed:true` alongside advisory findings is the intended state, and is
exactly what #1908 restored on purpose. 97.5% of August's 353 cases are
`warning`/`info` only. Driving the metric to zero would suppress correct
behaviour.

Ten records across July and August do carry an `error`-severity finding beside
`passed:true`. All ten are `adversarial`; none is semantic. None is explained by
the paths that legitimately pass despite an error finding — all have
`acDropped: 0`, `failOpen: false`, and no `passReason`. The last is dated
2026-08-29; September shows none, on 19 candidate records, which is too small a
sample to call it fixed.

**The fix cannot be specified yet.** Distinguishing "the model claimed the pass"
from "`verify()` computed the verdict wrongly" requires `modelPassed`, and
`modelPassed` is dropped on 100% of records. Specifying a fix now means guessing
which of two different bugs to repair, and a wrong guess written into an
acceptance criterion gets implemented literally. This spec therefore makes R6
diagnosable and leaves the repair to a follow-up.

## 3. Scope

### US-001 — The cost ledger records what it already knows

Files: `src/runtime/middleware/cost.ts`, `src/runtime/cost-aggregator.ts`,
`src/runtime/dispatch-events.ts`, `src/agents/manager-dispatch.ts`.

1. `CostEvent` gains `roundTrips?: number` and `roundTripUnit?: "model-call" | "agent-run"`,
   copied from the dispatch event. Both absent together when the event carries
   neither; never one without the other.
2. `DispatchErrorEvent` gains `model?: string`; `buildDispatchErrorEvent`
   populates it from the same `modelAttribution()` source the success path uses
   (`manager-dispatch.ts:45-56`). `CostErrorEvent.model` stops being permanently
   null.
3. The silent drop at `cost.ts:60` is replaced. A dispatch with no usage and no
   cost records a row carrying `usageMissing: true` rather than vanishing.
   `tokens` stays **undefined**, not zeroed — the existing comment on the error
   path is explicit that a zeroed `tokens` object recreates the "failed versus
   cost-zero" ambiguity, and that reasoning applies here unchanged.
4. `COST_ROW_SCHEMA_VERSION` 3 → 4, with the doc comment above it extended to
   describe what a v4 row guarantees, matching the convention already established
   for the v2/v3 boundary.

### US-002 — The review audit records verdict provenance

Files: `src/execution/story-orchestrator/review-decision.ts`,
`src/review/review-audit.ts`.

1. `toReviewDecisionPayload` (`review-decision.ts:13`) reads `modelPassed` off the
   op record, and `emitReviewDecision` forwards it, following the precedent
   `blockingThreshold` set at `:112-118` — read from both branches, not gated
   behind `parsed`, since a fail-open verdict's provenance matters most.
2. The audit writer persists it.
3. #1907's canary guard is extended to cover this route. The guard's present
   failure to catch `modelPassed` is the defect being fixed, so the story is not
   complete until the guard fails against the pre-fix emitter.

### Out of scope

- **The adversarial verdict bug itself.** Needs the data US-002 produces. Filed
  as a follow-up, not fixed here.
- **`analyze.py`.** It lives in `~/.claude/skills/nax-run-telemetry/`, outside this
  repo. No change in this repo can reach it. Its updates — reading the new fields,
  and adding R6's missing severity check — are a manual follow-up.
- **Backfilling historical rows.** v3 rows stay v3; the schema version is how a
  consumer tells them apart.
- **Native `exactCostUsd`.** Native has no wire cost to report. Not a defect.

## 4. Verification anchors

Behavioural, at the seam, not grep assertions:

1. A dispatch event carrying `roundTrips: 7, roundTripUnit: "model-call"` produces
   a cost row carrying both values.
2. A dispatch event carrying neither produces a row carrying neither — not a
   defaulted `1`.
3. A failed dispatch produces an error row whose `model` matches the model the
   dispatch resolved.
4. A successful dispatch with `tokenUsage: undefined` and zero cost produces
   exactly one row, marked `usageMissing: true`, with `tokens` undefined.
5. Every row written carries `schemaVersion: 4`.
6. An op output carrying `modelPassed: true` produces an audit record carrying
   `modelPassed: true`.
7. An op output whose verdict was fail-open still carries its `modelPassed`
   through to the record.
8. The extended canary guard fails when run against an emitter with the
   `modelPassed` forwarding removed.

## 5. Plan-document consequences

R15's verification line is rewritten. "Wire-exact > 90%" is replaced by three
signals this work can actually satisfy:

- zero cost rows with a null or `"unknown"` model
- zero dispatches that write no row (measured as calls dispatched versus rows
  written)
- a rate-provenance breakdown by `pricingSource`, replacing the single wire-exact
  percentage (an analyzer change, not a repo change)

The changelog records why the original line was unachievable, so it is not
re-raised.

R16 closes on anchor 1, with the analyzer half noted as an out-of-repo follow-up.

R6 stays open, re-scoped from "88 → 0" to "diagnose the 10 adversarial cases once
`modelPassed` is observable", and its baseline metric is corrected to count only
findings at or above the record's `blockingThreshold`.
