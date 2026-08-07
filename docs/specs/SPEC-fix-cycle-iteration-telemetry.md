# SPEC: Fix-cycle iteration telemetry

<!-- spec-writing: completed-through-phase-6 -->

## Summary

`runFixCycle` records every fix attempt as an `Iteration` and appends it to `cycle.iterations`, but only one of its four append sites emits a log record — and that record carries finding **counts** rather than finding identities. This spec extracts a single `recordIteration` helper, routes all four append sites through it so every iteration is logged, and widens the emitted payload with `findingKey` identities and the fix's target files and summaries.

Additive observability. No control-flow, classification, or budget behaviour changes inside nax. It does have one intended downstream effect: the curator plugin consumes this record, so it will begin collecting the iterations that are currently invisible — see Design § Downstream consumer.

## Motivation

From the 2026-08-07 rectification-lane analysis (F4), three defects in the same emitter:

**The terminal iteration of every exhausted cycle is invisible.** `src/findings/cycle.ts` appends an `Iteration` at four sites — `:348` (agent-gave-up), `:410` (lite-validate threw), `:436` (terminal lite-validate), `:550` (normal iteration). Only `:550` is followed by a `logger.info("findings.cycle", "iteration completed", …)`. The other three emit an *exit* message instead, so the last iteration of a cycle — the one that failed, the most diagnostically valuable — never appears as an iteration.

Roughly 370 cycles in the artifact corpus exit through those paths, so on-disk iteration counts undercount by exactly 1 for each. This is not hypothetical: it falsified the first pass of the F4 analysis itself, which reported "max cycle depth 6" against a true depth of 7 and drew a false conclusion about the per-strategy attempt cap before the artifact was re-read.

**The record cannot answer "same defect or different?".** The payload logs `findingsBefore`/`findingsAfter` as integers. Whether iteration N faced the same finding as iteration N-1 — the central question when diagnosing a non-converging story — is unanswerable from the telemetry, and had to be reconstructed by hand from `prompt-audit/` transcripts.

**Fix targets are computed and dropped.** `cycle.ts:302-303` populates `FixApplied.targetFiles` and `.summary` from each strategy's `extractApplied`. A repo-wide search finds no reader of either field. The work of recording what a fix touched is already done and then discarded.

## Design

### Integration

Verified against `repos/nax` @ `4520d7d2` (v0.77.0).

| Symbol | Location | Current shape |
|:---|:---|:---|
| `runFixCycle` | `src/findings/cycle.ts:149` | `(cycle, ctx, cycleName, _deps?) => Promise<FixCycleResult<F>>`; `_deps` already accepts `{ callOp?, now?, logger? }` |
| `Iteration<F>` | `src/findings/cycle-types.ts:35` | `{ iterationNum, findingsBefore, fixesApplied, findingsAfter, outcome, startedAt, finishedAt }` |
| `FixApplied` | `src/findings/cycle-types.ts:23` | `{ strategyName, op, targetFiles, summary, unresolved?, costUsd? }` |
| `findingKey` | `src/findings/types.ts:245` | `(f: Finding) => string` — `JSON.stringify([source, file, line, rule, message])`; already exported from the `src/findings` barrel |
| `Logger.info` | `src/logger/logger.ts:245` | `(stage: string, message: string, data?: Record<string, unknown>) => void` |
| `collectFixCycleIteration` | `src/plugins/builtin/curator/collect.ts:421` | The record's **only consumer**; dispatched from `collect.ts:510` on `stage === "findings.cycle" && message === "iteration completed"` |

**The four append sites**, all constructing the same seven-field object:

| Site | Exit path | Logs today? | `outcome` value |
|:---|:---|:---|:---|
| `cycle.ts:348` | agent-gave-up | no | hardcoded `"unchanged"` |
| `cycle.ts:410` | lite-validate threw | no | hardcoded `"unchanged"` |
| `cycle.ts:436` | terminal lite-validate | no | from `classifyOutcome` |
| `cycle.ts:550` | normal iteration | **yes** | from `classifyOutcome` |

The two hardcoded `"unchanged"` literals are **preserved verbatim**. They are correct for a purely additive change and become load-bearing only if the bail predicate is later re-keyed on outcome identity — that is a separate decision, listed in Out of Scope.

**New module.** `src/findings/cycle-iteration-log.ts`, exporting `recordIteration`, re-exported from the `src/findings` barrel per the project's barrel-import rule.

```typescript
export interface RecordIterationInput<F extends Finding> {
  findingsBefore: F[];
  findingsAfter: F[];
  fixesApplied: FixApplied[];
  outcome: IterationOutcome;
  startedAt: string;
  finishedAt: string;
}

export interface RecordIterationContext {
  storyId?: string;
  packageDir?: string;
  cycleName: string;
}

/** Append the iteration to `cycle.iterations` AND emit its record. One call, both effects. */
export function recordIteration<F extends Finding>(
  cycle: FixCycle<F>,
  input: RecordIterationInput<F>,
  ctx: RecordIterationContext,
  logger: Logger | null | undefined,
): Iteration<F>;
```

Coupling append and emit in one function is the point: the defect exists because the two were separable, and three call sites did one without the other.

**Extraction is forced, not stylistic.** `src/findings/cycle.ts` is 581 lines against the 600-line hard limit in `.nax/rules/project-conventions.md`, and is **not** grandfathered in `scripts/baselines/file-sizes-baseline.json`. Adding three log calls in place breaches the limit; removing four inline nine-line constructions in favour of four call sites nets the file down to roughly 550.

### Log payload

Stage `findings.cycle`, message `iteration completed` — both unchanged, so existing queries keep matching. `storyId` stays the first key per the structured-logging rule.

| Key | Status | Value |
|:---|:---|:---|
| `storyId`, `packageDir`, `cycleName`, `iterationNum`, `strategiesRan`, `outcome` | unchanged | as today |
| `findingsBefore`, `findingsAfter` | **unchanged — remain integer counts** | existing consumers keep working |
| `findingKeysBefore`, `findingKeysAfter` | **new** | `findingKey(f)` per finding, in array order |
| `fixTargetFiles` | **new** | de-duplicated union of `fixesApplied[].targetFiles`, first-seen order |
| `fixSummaries` | **new** | one entry per `fixesApplied` entry |
| `costUsd` | unchanged | omitted when zero |

### Downstream consumer

The record's only consumer is the curator plugin: `collect.ts:510` dispatches on `stage === "findings.cycle" && message === "iteration completed"` into `collectFixCycleIteration` (`collect.ts:421`), which reads exactly five fields — `iterationNum`, `outcome`, `findingsBefore`, `findingsAfter`, `costUsd` — via `numberValue(…, 0)` and `optionalString`.

Two consequences, both intended:

- **The count fields must stay numeric.** `numberValue(data.findingsBefore, 0)` silently yields `0` for a non-number, so replacing the counts with arrays would zero the curator's data rather than fail loudly. This is why the payload table keeps `findingsBefore`/`findingsAfter` as integers and adds identities under new keys; US-002 AC4 and AC5 pin it. New keys are ignored by the consumer, which reads named fields only.
- **The curator will collect more iterations than before.** That is the fix working: the ~370 cycles whose terminal iteration is currently unlogged will start producing a `fix-cycle-iteration` observation. Because `collectFixCycleIteration` maps `status` to `passed` only when `outcome === "resolved"`, the two append sites that hardcode `"unchanged"` will contribute `failed` observations. Historical curator rollups are therefore not comparable across this change.

Identities are the **exact `findingKey` output**, not a digest or a reduced tuple, so the telemetry compares findings by precisely the same rule `classifyOutcome` uses (`cycle.ts:50-51`). Any other encoding could show two findings as identical while the classifier treated them as distinct, producing a record that cannot explain the outcome it reports. The cost is payload size — `findingKey` embeds the full message text.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `logger` is `null` / `undefined` | Append still happens; no throw. The `Iteration` is cycle state, not a logging side-effect. |
| A finding has `file` / `line` / `rule` undefined | `findingKey` yields a key containing `null` positions; logged as-is, no throw. |
| `fixesApplied` is empty (carry-forward iterations, per `cycle-types.ts:43-47`) | `fixTargetFiles` and `fixSummaries` are omitted rather than logged as empty arrays. |

## Out of Scope

- Making the fix-cycle attempt budget or decline ledger story-scoped rather than per-cycle is deferred; `runRectification` continues to construct each cycle with `iterations: []`.
- Re-keying the `withIncreasingFailuresBail` predicate on finding identity instead of finding count is deferred; it continues to fire only on a strict count increase.
- Changing the two hardcoded `outcome: "unchanged"` literals at the agent-gave-up and lite-validate-threw append sites is deferred; both are preserved exactly as they are today.
- Counting rectification oscillation at finding identity rather than at `Finding.source`, and reading the oscillation circuit-breaker mid-story rather than on the story-failure path, are both deferred.
- Passing prior-iteration history into the autofix prompts is deferred; every `FixStrategy.buildInput` continues to ignore its `prior` parameter.
- Stabilising `findingKey` against message rewording and line drift is deferred; this spec logs the key exactly as it exists today.
- No change to `classifyOutcome`, to any cycle exit reason, or to any control-flow decision in `runFixCycle`.

## Stories

Two stories. The split is required by the additive-plus-refactor rule: US-001 restructures existing code paths, US-002 adds new payload content on top of the result.

**US-001 — Route every iteration append through one recording helper**
Extract `recordIteration` into `src/findings/cycle-iteration-log.ts`, export it from the `src/findings` barrel, and replace all four inline append sites in `runFixCycle` with calls to it, so every appended iteration also emits its record.
*Depends on:* nothing.
*Context Files:* `src/findings/cycle.ts`, `src/findings/cycle-types.ts`, `src/findings/index.ts`, `src/findings/types.ts`, `test/unit/findings/cycle.test.ts`
*Creates:* `src/findings/cycle-iteration-log.ts`, `test/unit/findings/cycle-iteration-log.test.ts`

**US-002 — Carry finding identities and fix targets in the record**
Widen the emitted payload with `findingKeysBefore`, `findingKeysAfter`, `fixTargetFiles` and `fixSummaries`, leaving the existing count fields and message intact.
*Depends on:* US-001.
*Context Files:* `src/findings/cycle-iteration-log.ts` — created by US-001, extended here; `src/findings/types.ts`, `src/findings/cycle-types.ts`, `test/unit/findings/cycle-iteration-log.test.ts` — created by US-001, extended here
*Creates:* none.

### Seams

`recordIteration` is a new externally-visible symbol (exported from the `src/findings` barrel) whose sole production consumer is `runFixCycle`. The seam invariant is declared in US-001's own ACs: each of the four exit paths is driven through `runFixCycle` — the module's outermost entry point — with an injected logger, asserting the record appears. Driving `recordIteration` directly would test the helper, not the wiring that was broken.

`test/unit/findings/cycle.test.ts` already injects a logger via `runFixCycle(cycle, ctx, name, { callOp, logger })` (`cycle.test.ts:504`), so the seam needs no new test infrastructure.

### Modifies

**US-001**
- `src/findings/cycle.ts` — replace the four inline `cycle.iterations.push(...)` constructions and the inline log call with `recordIteration` calls
- `src/findings/index.ts` — re-export `recordIteration` and its input types from the barrel
- `test/unit/findings/cycle.test.ts` — extend with the four exit-path seam assertions

**US-002**
- `src/findings/cycle-iteration-log.ts` — widen the emitted payload with identity and fix-target keys
- `test/unit/findings/cycle-iteration-log.test.ts` — extend with payload-content assertions

## Acceptance Criteria

### US-001 — Route every iteration append through one recording helper

1. `[unit]` Referencing `recordIteration` imported from the `src/findings` barrel succeeds and `recordIteration` is usable as a function.
2. `[unit]` Calling `recordIteration` with a cycle whose `iterations` is empty returns an `Iteration` whose `iterationNum` is `1`.
3. `[unit]` After calling `recordIteration`, the last element of `cycle.iterations` is the returned `Iteration`.
4. `[unit]` A second `recordIteration` call on the same cycle returns an `Iteration` whose `iterationNum` is `2`.
5. `[unit]` Calling `recordIteration` with a capturing logger emits exactly one record whose stage is `findings.cycle` and whose message is `iteration completed`.
6. `[unit]` In the record emitted by `recordIteration`, the first key of the data object is `storyId`.
7. `[unit]` Calling `recordIteration` with `logger` as `null` leaves `cycle.iterations` holding the returned `Iteration` as its last element.
8. `[unit]` Running `runFixCycle` with a strategy whose fix op reports `unresolved`, so the cycle exits with reason `agent-gave-up`, emits one `iteration completed` record whose `iterationNum` is `1`.
9. `[unit]` Running `runFixCycle` so that its terminal lite-validate returns no findings, exiting with reason `resolved`, emits one `iteration completed` record.
10. `[unit]` Running `runFixCycle` so that its terminal lite-validate reports a short-circuit, exiting with reason `validate-short-circuit`, emits one `iteration completed` record.
11. `[unit]` Running `runFixCycle` whose terminal lite-validate throws, exiting with reason `max-attempts-per-strategy`, emits one `iteration completed` record.
12. `[unit]` Running `runFixCycle` through a single normal iteration that resolves emits exactly one `iteration completed` record.
13. `[unit]` Running `runFixCycle` through two normal iterations before a terminal exit emits records whose `iterationNum` values appear in the order `1`, `2`, `3`.
14. `[unit]` In the record emitted for a cycle exiting via `agent-gave-up`, `outcome` is `unchanged`.

### US-002 — Carry finding identities and fix targets in the record

1. `[unit]` For an iteration whose `findingsBefore` holds two findings, the record's `findingKeysBefore` equals the result of applying `findingKey` to each of those findings, in the same order.
2. `[unit]` For an iteration whose `findingsAfter` holds one finding, the record's `findingKeysAfter` equals a single-element list holding `findingKey` of that finding.
3. `[unit]` When the same finding object is present in both `findingsBefore` and `findingsAfter`, its key value appears in both `findingKeysBefore` and `findingKeysAfter` in the emitted record.
4. `[unit]` When `findingsBefore` holds two findings, the record's `findingsBefore` is the number `2`.
5. `[unit]` When `findingsAfter` holds one finding, the record's `findingsAfter` is the number `1`.
6. `[unit]` For an iteration whose `fixesApplied` holds two entries with overlapping `targetFiles`, the record's `fixTargetFiles` lists each distinct path once, in first-seen order.
7. `[unit]` For an iteration whose `fixesApplied` holds two entries, the record's `fixSummaries` holds those entries' `summary` values in the same order.
8. `[unit]` For an iteration whose `fixesApplied` is empty, the record contains no `fixTargetFiles` key.
9. `[unit]` For an iteration whose `fixesApplied` is empty, the record contains no `fixSummaries` key.
10. `[unit]` For a finding whose `file`, `line` and `rule` are all undefined, the record's `findingKeysBefore` entry equals `findingKey` of that finding.
11. `[unit]` For an iteration whose `fixesApplied` entries all report a `costUsd` of zero, the record contains no `costUsd` key.
