# SPEC: Identity-keyed no-progress bail for the fix cycle

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Add a second, identity-keyed bail predicate to the story-orchestrator fix cycle. Where the existing
`withIncreasingFailuresBail` fires only when the finding *count* grows, the new `withNoProgressBail`
fires when N consecutive trailing iterations each resolve **nothing** — every `findingKey` present in
`findingsBefore` is still present in `findingsAfter`. The two bails are independent, flag-gated, and
OR'd together; the existing count predicate is not modified.

## Motivation

`withIncreasingFailuresBail` (`src/execution/story-orchestrator/run-phase.ts:428`) tests
`it.findingsAfter.length > it.findingsBefore.length`. Finding identity is never compared, so a cycle
that returns the same defect at a constant count never trips it and runs to the attempt cap.

Measured across the 2,473 `iteration completed` records on disk (all 8 projects, 2026-08-07):

| outcome | count-same | count-decreased | count-increased |
|:---|---:|---:|---:|
| `unchanged` | 177 | 1 | 1 |
| `regressed` | 164 | 121 | 100 |
| `regressed-different-source` | 103 | 129 | 79 |

Roughly 875 iterations made no progress; the count predicate can see only the 180 in the
`count-increased` column. **695 (79%) are invisible to the only bail that exists.**

Restricting the new predicate to `outcome === "unchanged"` would reach just 179 of those 695 (26%).
The dominant blind shape is a cycle whose finding set churns — findings appear and disappear — while
some defect is never resolved. Set-subset (`beforeKeys ⊆ afterKeys`) is the predicate that names it:
it is exactly "nothing was resolved this iteration", it strictly subsumes `unchanged` (which is set
*equality*), and it self-guards against the obvious false positive, because a cycle grinding five
findings down one at a time resolves a key every round and therefore never trips.

This is the R3 item from the 2026-08-07 rectification-lane gap analysis. The telemetry shipped in
#1496 (`findingKeysBefore`/`findingKeysAfter`) is what makes the effect measurable after the fact.

## Design

### Approach

The no-progress test operates on `Iteration.findingsBefore` / `Iteration.findingsAfter`, which are
full `Finding[]` arrays on the stored iteration (they carry counts only in the *emitted log record* —
see #1496). Keys come from the existing `findingKey` helper.

```typescript
// src/execution/story-orchestrator/no-progress-bail.ts

/** True when the iteration resolved nothing: every key present before is still present after. */
function madeNoProgress(iteration: Iteration<Finding>): boolean {
  if (iteration.findingsBefore.length === 0) return false; // nothing to resolve — not a stall
  const after = new Set(iteration.findingsAfter.map(findingKey));
  return iteration.findingsBefore.every((f) => after.has(findingKey(f)));
}

export function withNoProgressBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
  consecutiveNoProgress: number,
): FixStrategy<Finding, unknown, unknown, unknown>[] { /* ... */ }
```

`findingKey` (`src/findings/types.ts:245`) is
`JSON.stringify([source, file, line, rule, message])`. It includes the message text, so any drift in
a finding's wording reads as a *different* key and the iteration reads as progress. The predicate
therefore under-detects rather than over-detects — the safe direction for a bail.

### Integration

Verified symbols and signatures:

| Symbol | Location | Shape |
|:---|:---|:---|
| `withIncreasingFailuresBail` | `src/execution/story-orchestrator/run-phase.ts:428` | `(strategies, enabled: boolean, consecutiveIncreases: number) => FixStrategy[]` — the wrapper contract to mirror |
| `FixStrategy.bailWhen` | `src/findings/cycle-types.ts:183` | `(priorIterations: Iteration<F>[]) => string \| null`; non-null exits with `exitReason: "bail-when"` |
| `findingKey` | `src/findings/types.ts:245` | `(f: Finding) => string` |
| `runRectification` | `src/execution/story-orchestrator/rectification.ts:211` | the production entry point; builds the `FixCycle` and applies the bail wrapper at line 288 |
| `RectificationPhaseOptions` | `src/execution/story-orchestrator/types.ts:22` | readonly options interface carrying `abortOnIncreasingFailures` / `consecutiveIncreasesToBail` |

Pattern to mirror: `withIncreasingFailuresBail` — same wrapper signature, same "user-supplied
`bailWhen` wins" composition, same early return of the unmodified array when disabled. The new module
is a sibling file rather than an addition to `run-phase.ts` (452 lines) or `cycle.ts` (584 lines,
already against the 600-line source limit), following the `cycle-iteration-log.ts` precedent from
#1496.

Composition at `rectification.ts:288` nests the two wrappers:

```typescript
strategies: withNoProgressBail(
  withIncreasingFailuresBail(base, rectification.abortOnIncreasingFailures, rectification.consecutiveIncreasesToBail ?? 1),
  rectification.abortOnNoProgress,
  rectification.consecutiveNoProgressToBail ?? 3,
),
```

Because the outer wrapper consults the inner one's `bailWhen` first and the inner returns the count
reason, precedence must be explicit: a user-supplied predicate wins, then no-progress, then
count-increase. No-progress outranks count-increase because it is the more specific diagnosis — an
iteration can satisfy both, and the operator-facing reason should name the stall, not the count.

### Config

Two new fields on `execution.rectification`:

| Field | Type | Default | Bounds |
|:---|:---|:---|:---|
| `abortOnNoProgress` | boolean | `true` | — |
| `consecutiveNoProgressToBail` | integer | `3` | min 1, max 10 |

The threshold is 3, one higher than the count bail's 2, because this predicate fires on a much wider
shape and the true coverage between 179 and 695 iterations cannot be measured until post-#1496
telemetry accrues.

**Both declaration sites are required.** `NaxConfigSchema` (`src/config/schemas.ts:113`) passes a
hand-maintained object literal to `ExecutionConfigSchema.default(...)`, and Zod does **not** fill in
a nested `.default()` for a key that literal omits. Verified against the real schema:
`NaxConfigSchema.parse({})` resolves exactly the ten `rectification` keys the literal lists. A field
added only to `schemas-execution.ts` therefore resolves to `undefined` — falsy — and the bail would
ship permanently dead for every user without an explicit `execution.rectification` block. AC-1.1 and
AC-1.2 pin this.

Full threading path: `src/config/schemas-execution.ts` (schema + bounds) → `src/config/schemas.ts`
(the default literal) → `src/config/runtime-types.ts` (interface) → `src/cli/config-descriptions.ts`
(descriptions) → `src/execution/plan-inputs.ts:426` (build `RectificationPhaseOptions`) →
`src/execution/story-orchestrator/types.ts` (option fields) → `rectification.ts:288` (apply).

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `abortOnNoProgress` is `false` | Return the strategy array unmodified — no wrapper, no allocation. |
| Fewer prior iterations than the threshold | Return `null` (continue); a stall cannot be established yet. |
| `findingsBefore` is empty on an iteration | Treated as **progress**, not a stall. The empty set is trivially a subset of anything, so without this guard a degenerate cycle would bail on vacuous evidence. |
| A user-supplied `bailWhen` returns non-null | The user reason wins and is returned unchanged; the no-progress predicate is not consulted. |
| Both no-progress and count-increase would fire | The no-progress reason is returned (more specific diagnosis). |

Exits reuse the existing `exitReason: "bail-when"`, with the predicate's string carried in
`FixCycleResult.bailDetail` (`src/findings/cycle-types.ts:105`). The reason string names the shape
and the persisting-key count, e.g.
`no finding resolved for 3 consecutive iteration(s); 2 finding(s) persisted`. The existing count
predicate's reason string is left untouched.

**Observability at the production entry point.** `runRectification` returns `RectificationResult`
(`src/execution/story-orchestrator/types.ts:255`), which carries only `rectificationExhausted`,
`unfixedFindings`, `liteScopeIncomplete` and `unresolvedDetail` — it does **not** surface
`exitReason` or `bailDetail`. Since `"bail-when"` is a member of `EXHAUSTED_EXIT_REASONS`
(`types.ts:6`), a bailed cycle holding findings returns `rectificationExhausted: true` with those
findings in `unfixedFindings`. The observable that distinguishes "the bail fired at the threshold"
from "the cycle ran on to `maxAttemptsTotal`" is therefore **how many times the cycle's validation
ran**, which is what AC-2.9 and AC-2.10 assert. `runRectification` already has a driving test
harness in `test/unit/execution/rectification-overrides.test.ts`.

## Out of Scope

- The R1 story-scoped attempt budget and decline ledger (the fix cycle's budget remains per-cycle) is deferred to a separate arc.
- The R4 oscillation circuit-breaker rework — counting oscillation at finding identity rather than at `source`, and reading the breaker mid-story rather than only on the story-failure path — is deferred; its 158/57 split must be re-probed after R1 lands before it can be sized.
- The R2 experiment of restating prior fix attempts explicitly in the fix prompt is deferred; its benefit is unproven and it is to be run as a measured experiment, not shipped as a fix.
- `src/verification/rectification.ts:32` is a separate legacy consumer of `abortOnIncreasingFailures` in the verification lane, comparing `currentFailures` against `initialFailures`. It is a different lane and is not modified by this spec.
- `withIncreasingFailuresBail` and its predicate, reason string, and existing tests are not modified; the count bail's behaviour is preserved exactly.
- `classifyOutcome` (`src/findings/cycle.ts:72`) is correct and is not modified. The new predicate reads finding arrays directly rather than branching on the `outcome` label.
- No change to reviewer prompts, finding classification, retirement, or cost/budget accounting.
- Retroactive measurement of how many historical iterations the new predicate would have caught is not possible from pre-#1496 records (which carry counts only) and is not attempted.

## Stories

**US-001 — Declare and thread the no-progress config fields**
Add `abortOnNoProgress` and `consecutiveNoProgressToBail` to the rectification config, at both
declaration sites, and carry them to `RectificationPhaseOptions`. No behaviour change on its own.
*Depends on:* nothing.

### Modifies

- **US-001** `src/config/schemas-execution.ts`, `src/config/schemas.ts`, `src/config/runtime-types.ts`, `src/cli/config-descriptions.ts`, `src/execution/plan-inputs.ts`, `src/execution/story-orchestrator/types.ts`
- **US-002** `src/execution/story-orchestrator/no-progress-bail.ts`, `src/execution/story-orchestrator/rectification.ts`, `src/execution/index.ts`

**Context Files (US-001):** `src/config/schemas-execution.ts`, `src/config/schemas.ts`,
`src/config/runtime-types.ts`, `src/execution/plan-inputs.ts`,
`src/execution/story-orchestrator/types.ts`

**US-002 — The no-progress bail predicate, wired into the rectification cycle**
Create `no-progress-bail.ts`, export `withNoProgressBail` from the `@/execution` barrel, and compose
it around `withIncreasingFailuresBail` in `runRectification`.
*Depends on:* US-001 (reads the config fields it threads).

**Context Files (US-002):** `src/execution/story-orchestrator/run-phase.ts`,
`src/execution/story-orchestrator/rectification.ts`, `src/findings/types.ts`,
`src/findings/cycle-types.ts`, `src/execution/index.ts`
**Creates (US-002):** `src/execution/story-orchestrator/no-progress-bail.ts`

### Seams

- US-002 introduces `withNoProgressBail` as a new externally-visible symbol (exported from
  `src/execution/index.ts`). Its consumer is `runRectification` in the same story. AC-2.9 is the seam
  invariant: it drives `runRectification` — the outermost production entry point, above the cycle
  construction at line 288 — and asserts the *outcome* (a stalled cycle is cut off at the threshold
  instead of running to `maxAttemptsTotal`), rather than asserting that the wrapper was called.
  AC-2.10 is its negative control on the same path.
- US-002 consumes `abortOnNoProgress` / `consecutiveNoProgressToBail` on
  `RectificationPhaseOptions`, declared by US-001. Both fields are declared on the producer contract
  in US-001's AC-1.4.

## Acceptance Criteria

### US-001 — Config fields

- **AC-1.1** `[unit]` Parsing an empty configuration object with `NaxConfigSchema` yields
  `execution.rectification.abortOnNoProgress` equal to `true`.
- **AC-1.2** `[unit]` Parsing an empty configuration object with `NaxConfigSchema` yields
  `execution.rectification.consecutiveNoProgressToBail` equal to `3`.
- **AC-1.3** `[unit]` Parsing a configuration whose `execution.rectification.consecutiveNoProgressToBail`
  is `0` fails validation, and parsing one where it is `11` also fails validation, while `1` and `10`
  both parse successfully.
- **AC-1.4** `[unit]` Building the rectification phase options from a config with
  `execution.rectification.enabled` true, `abortOnNoProgress` false and `consecutiveNoProgressToBail`
  `7` produces a `RectificationPhaseOptions` value whose `abortOnNoProgress` is `false` and whose
  `consecutiveNoProgressToBail` is `7`.
- **AC-1.5** `[unit]` Parsing a configuration that explicitly sets
  `execution.rectification.abortOnNoProgress` to `false` yields `false`, confirming the user value
  overrides the default rather than being replaced by it.

### US-002 — No-progress bail

- **AC-2.1** `[unit]` Given a strategy wrapped by `withNoProgressBail` — imported from the
  `@/execution` module entry point — with the flag enabled and a threshold of `3`, calling the wrapped
  strategy's `bailWhen` with three trailing iterations that each carry the identical single finding in
  `findingsBefore` and `findingsAfter` returns a non-null reason string.
- **AC-2.2** `[unit]` Calling the wrapped strategy's `bailWhen` with five iterations that each start
  from five findings and end with one of them removed — a different one each iteration — returns
  `null`, because every iteration resolved a finding.
- **AC-2.3** `[unit]` With a threshold of `3`, calling `bailWhen` with exactly two no-progress
  iterations returns `null`, and calling it with a third no-progress iteration appended returns a
  non-null reason.
- **AC-2.4** `[unit]` Calling `bailWhen` with three trailing iterations whose `findingsBefore` keys are
  all still present in `findingsAfter` but which also contain two additional new findings in
  `findingsAfter` returns a non-null reason, confirming the predicate fires on a growing-but-unresolved
  set and not only on exact set equality.
- **AC-2.5** `[unit]` Calling `withNoProgressBail` with the enabled flag set to `false` returns a
  strategy array whose entries are the same objects that were passed in, leaving each entry's
  `bailWhen` unchanged.
- **AC-2.6** `[unit]` When the input strategy already defines its own `bailWhen` that returns the
  string `"user-stop"`, the wrapped strategy's `bailWhen` returns `"user-stop"` for three no-progress
  iterations rather than the no-progress reason.
- **AC-2.7** `[unit]` Calling `bailWhen` with three trailing iterations whose `findingsBefore` is empty
  returns `null`, so an empty before-set is treated as progress rather than as a stall.
- **AC-2.8** `[unit]` The non-null reason returned for three no-progress iterations carrying two
  persisting findings reports both the iteration count `3` and the persisting-finding count `2`.
- **AC-2.9** `[integration]` Driving `runRectification` with rectification config
  `abortOnNoProgress` true, `consecutiveNoProgressToBail` `3` and `maxAttemptsTotal` `12`, where the
  cycle's validation returns the same two findings on every call, returns a `RectificationResult`
  whose `rectificationExhausted` is `true`, having dispatched the rectification strategy's fix
  operation exactly `3` times.
- **AC-2.10** `[integration]` Driving `runRectification` with the same always-identical validation
  findings and `maxAttemptsTotal` `12` but `abortOnNoProgress` set to `false` dispatches the
  rectification strategy's fix operation more than `3` times, confirming the new bail is genuinely
  gated by its flag on the production path.
- **AC-2.11** `[unit]` For three trailing iterations that are each simultaneously no-progress and
  count-increasing, a strategy wrapped by `withNoProgressBail` around `withIncreasingFailuresBail`
  (both enabled, both at threshold 3) returns the no-progress reason rather than the count-increase
  reason.
**Verification note (both stories):** type-level correctness of the new config fields and the new
export is enforced by the repository's static gate, `bun run typecheck`, not by an acceptance
criterion.
