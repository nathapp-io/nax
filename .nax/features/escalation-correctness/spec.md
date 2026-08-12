# SPEC: Escalation Correctness

## Summary

Tier escalation currently does not do what its configuration says it does. The per-tier
attempt budgets in `autoMode.escalation.tierOrder` are never consulted (the function that
reads them has zero callers), runtime crashes escalate to a costlier model tier instead of
retrying the same one (the signal that would prevent it is never populated, and the outcome
that expresses it is never read), and every escalation observation records an empty source
tier, so the ladder cannot be audited. This spec wires the budgets with corrected defaults,
routes runtime crashes to a same-tier retry, and records the source tier — in that order, so
the telemetry that verifies the other two lands first.

## Motivation

Three defects, all confirmed against `0d92c460` and measured over run artifacts
(1101 story verdicts, 110 escalation events in `~/.nax/*/runs/*/observations.jsonl`):

**Per-tier budgets never bind (BUG-04).** `preIterationTierCheck`
(`src/execution/escalation/tier-escalation.ts:130`) implements the budget check correctly
but has no caller outside its own barrel re-export. `handleTierEscalation` instead compares
against `calculateMaxIterations` (`escalation.ts:66`), the *sum* of every rung, and resets
`attempts` to 0 on each tier change. Measured attempt distribution:

| attempts | 0 | 1 | 2 | 3 | 4 | 5+ |
|:---|---:|---:|---:|---:|---:|---:|
| stories | 132 | 865 | 90 | 10 | 4 | **0** |

No story has ever reached 5 attempts — the `fast` rung's shipped budget. 78.6% succeed on
the first attempt; only 14 (1.3%) exceed two. So the shipped `5/3/2` numbers have never been
in force and were never validated: wiring them as-is would add up to four extra iterations
at the weakest tier for stories that today escalate after a single failure. This spec ships
`2/2/2` instead, which makes the ladder bind without inflating low-value retries.

**Runtime crashes escalate instead of retrying (BUG-05).** `handleTierEscalation:346` exits
via `retry-same` only when `ctx.runtimeCrashResult` is set, but the sole production call site
(`src/execution/pipeline-result-handler.ts:368-384`) never passes that field, and it is
assigned nowhere in `src/`. Two further gaps found while grounding this spec: the crash
signal *does* already reach the call site under a different name —
`pipelineResult.context.tddFailureCategory === "runtime-crash"`, set at
`src/pipeline/stages/execution.ts:143` for `CALL_OP_NO_OUTPUT` / `CALL_OP_MAX_RETRIES` — and
the caller reads only `.prd` and `.prdDirty` from the result, never `.outcome`, so a
`retry-same` verdict would have no effect even once the signal is threaded. Both halves must
be fixed for the feature to work.

**Escalation telemetry records an empty source tier (BUG-63).** All 110 recorded escalation
events carry `payload.from: ""`. The cause is precise: `collectEscalation`
(`src/plugins/builtin/curator/collect.ts:404-419`) reads
`data.fromTier ?? data.from ?? data.currentTier`, but the log call it collects
(`tier-escalation.ts:408`) emits only `{ storyId, nextTier, retryAsLite }` — `nextTier` is
why `to` is populated and `from` is not. Consequently 47 of the 58 stories that reached
`powerful` have no `balanced` event, which is consistent with rung-skipping but unprovable:
an empty `from` cannot distinguish a skipped rung from a story that legitimately started
mid-ladder. Without this, BUG-04's fix cannot be verified after it ships.

A fourth, smaller finding from grounding: the pre-iteration budget path logs
`"Story exceeded tier budget, escalating"` (`tier-escalation.ts:174`), which the collector's
`message.includes("Escalating")` test at `collect.ts:508` does **not** match — case-sensitive.
So once BUG-04 is wired, its escalations would be invisible to the observation stream unless
the message is aligned.

## Design

### Integration

Existing symbols this feature modifies — all verified present at the cited lines:

| Symbol | Location | Change |
|:---|:---|:---|
| `preIterationTierCheck` | `src/execution/escalation/tier-escalation.ts:130` | No signature change; gains production callers |
| `handleTierEscalation` | `src/execution/escalation/tier-escalation.ts:342` | Logger routed through `_tierEscalationDeps`; emits source tier |
| `shouldRetrySameTier` | `src/execution/escalation/tier-escalation.ts:325` | Unchanged predicate; its input starts being populated |
| `EscalationHandlerResult.outcome` | `src/execution/escalation/tier-escalation.ts:311` | Existing union; caller starts reading it |
| `collectObservations` | `src/plugins/builtin/curator/collect.ts:527` | Unchanged; the escalation entries it reads gain the missing field. Its private `collectEscalation` helper (`:404`) needs no change — it already falls back through `fromTier ?? from ?? currentTier` |
| `NaxConfigSchema` escalation defaults | `src/config/schemas.ts:87-90` | `5/3/2` → `2/2/2` |
| `handlePipelineFailure` escalate branch | `src/execution/pipeline-result-handler.ts:368-384` | Passes crash signal; honours `retry-same` |
| Sequential dispatch | `src/execution/unified-executor.ts:565` | `preIterationTierCheck` before `runIteration` |
| Batch dispatch | `src/execution/unified-executor.ts:223-251` | Same check per story before batch dispatch |

Patterns to follow:

- **Dependency injection** — `_tierEscalationDeps` (`tier-escalation.ts:332`) already exports
  `savePRD` and `getSafeLogger`. `preIterationTierCheck:142` resolves its logger through it;
  `handleTierEscalation:343` calls the imported `getSafeLogger()` directly. That asymmetry is
  why the escalation log line is currently untestable, so US-001 routes `handleTierEscalation`
  through `_tierEscalationDeps.getSafeLogger` as well.
- **Executor seam** — `_unifiedExecutorDeps.runIteration` (`unified-executor.ts:565`) is the
  established injection point for the sequential dispatch; the new pre-iteration call is added
  to the same deps object so tests can stub it without `mock.module()`.
- **Config defaults** — per `.nax/rules/config-patterns.md`, defaults live in the Zod schema
  and `DEFAULT_CONFIG` is derived via `NaxConfigSchema.parse({})`. Change the schema only.

### Approach

The crash signal is **not** given new plumbing. `tddFailureCategory === "runtime-crash"`
already reaches the escalation call site, so `handlePipelineFailure` derives
`runtimeCrashResult` from it rather than threading a parallel field from the verify layer.
`shouldRetrySameTier`'s `{ status: "RUNTIME_CRASH" }` shape is preserved so the existing
predicate and its tests stay valid.

Budget enforcement reuses `preIterationTierCheck` as written — it already handles
agent-qualified rungs, missing rungs, and the escalation-disabled case. This feature supplies
callers, not a reimplementation.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Story's current rung absent from `tierOrder` | Budget is unbounded for that story; warn and proceed (existing `tier-escalation.ts:151-158`) |
| `autoMode.escalation.enabled` is `false` | Budget exhaustion does not escalate; the iteration proceeds |
| Runtime crash detected | Same tier retried; story tier and `attempts` unchanged |
| Escalation log missing a source tier | Observation records `from: ""` — the collector's fallback chain is unchanged; the fix lands at the emit site, which starts supplying the field |

## Out of Scope

- Concurrent `savePRD` writes from simultaneous escalations in parallel/batch mode — the existing single-writer contract is unchanged by this feature.
- `escalateEntireBatch` semantics — whether a batch escalates as a unit is unchanged.
- `resetMode` semantics — how routing resets on escalation is unchanged.
- Retuning the `2/2/2` budget values after measurement — this feature ships the corrected defaults, not a follow-up tuning pass.
- Provider capacity errors and transient adapter failures (BUG-62 / BUG-20) — a separate transient-failure taxonomy, not part of tier escalation.
- Agent unavailability persisting for a whole run after one transient failure (BUG-52).
- Backfilling `payload.from` on escalation observations already written to disk by earlier runs.
- US-003 only: retuning `maxIterations` or `execution.rectification.maxAttemptsTotal` to match the new per-rung budgets.

## Stories

1. **US-001: Escalation telemetry records the source tier** — no dependencies
2. **US-002: Runtime crashes retry the same tier** — depends on US-001
3. **US-003: Per-tier attempt budgets bind** — depends on US-002

### US-001 — Context Files

- `src/execution/escalation/tier-escalation.ts` — the escalation log call at `:408` and the `_tierEscalationDeps` object at `:332`
- `src/plugins/builtin/curator/collect.ts` — `collectEscalation` at `:404` and the stage/message dispatch at `:508`
- `src/plugins/builtin/curator/types.ts` — `EscalationObservation` shape at `:107`
- `test/unit/execution/escalation/tier-escalation.test.ts` — existing `_tierEscalationDeps` stubbing patterns

### US-002 — Context Files

- `src/execution/escalation/tier-escalation.ts` — `shouldRetrySameTier` at `:325`, `handleTierEscalation` at `:342`
- `src/execution/pipeline-result-handler.ts` — the `case "escalate"` branch at `:368-384`
- `src/pipeline/stages/execution.ts` — `RUNTIME_CRASH_CODES` at `:36` and the category assignment at `:143`
- `test/unit/execution/escalation/tier-escalation.test.ts` — existing escalation-outcome assertions

### US-003 — Context Files

- `src/execution/escalation/tier-escalation.ts` — `preIterationTierCheck` at `:130`
- `src/execution/escalation/escalation.ts` — `getTierConfig` at `:57`, `calculateMaxIterations` at `:66`
- `src/config/schemas.ts` — escalation defaults at `:87-90`
- `src/execution/unified-executor.ts` — sequential dispatch at `:565`, batch dispatch at `:223-251`
- `test/unit/execution/escalation/escalation.test.ts` — tier-ladder test patterns

### Seams

**Seam-path status — read this before writing the seam tests.** None of the call paths
below exist in the current code; each seam AC describes wiring its own story creates, not a
path to be discovered. `preIterationTierCheck` has zero callers today (only the barrel
re-export at `escalation/index.ts:8`), so S1–S3 fail until US-003 adds the call. The
`handlePipelineFailure` → `handleTierEscalation` path in S4 *does* exist
(`pipeline-result-handler.ts:368`), but the caller reads only `.prd` and `.prdDirty` and
never `.outcome`, so the `retry-same` behaviour S4 asserts is created by US-002.

- **S1 (US-003):** stub `preIterationTierCheck`; run the sequential executor dispatch; assert it is invoked with the selected story before `runIteration` is called. *(Path created by US-003.)*
- **S2 (US-003):** stub `preIterationTierCheck` to report budget exhaustion; run the sequential executor dispatch; assert `runIteration` is not invoked for that story. *(Path created by US-003.)*
- **S3 (US-003):** stub `preIterationTierCheck`; run the batch executor dispatch; assert it is invoked once per story in the batch before the batch is dispatched. *(Path created by US-003.)*
- **S4 (US-002):** drive `handlePipelineFailure` with an escalate action and a runtime-crash failure category; assert the story's `routing.modelTier` is unchanged after the call. *(Call path exists; the outcome-honouring behaviour is created by US-002.)*

### Modifies

None. The default-ladder change in US-003 was swept against the test tree: every escalation
test supplies its own `tierOrder` rather than deriving one from `DEFAULT_CONFIG`, the
config-merge assertion at `test/integration/config/merger.test.ts:311` pins a project
override rather than the default, and `test/unit/config/schemas.test.ts:455` depends only on
the ladder's tier *names*, which do not change. No existing closed-world assertion breaks
under `2/2/2`, so no story needs modification authorisation.

## Acceptance Criteria

### US-001: Escalation telemetry records the source tier

- [unit] `handleTierEscalation` resolves its logger through `_tierEscalationDeps.getSafeLogger`, so a test that replaces that dependency observes the escalation log call.
- [unit] when `handleTierEscalation` escalates a story from `fast` to `balanced`, it logs at stage `escalation` with a data object whose `fromTier` equals `"fast"`.
- [unit] the same log call's data object continues to carry `nextTier` equal to `"balanced"`.
- [integration] `collectObservations` run over a log file containing one escalation entry whose data carries `fromTier` of `"fast"` and `nextTier` of `"balanced"` returns one observation of kind `escalation` with `payload.from` equal to `"fast"`.
- [integration] `collectObservations` run over a log file whose escalation entry omits `fromTier` but carries `currentTier` of `"fast"` returns an observation with `payload.from` equal to `"fast"`.
- [integration] `collectObservations` run over a log file containing the entry `handleTierEscalation` writes when escalating returns exactly one observation of kind `escalation`.
- [integration] `collectObservations` run over a log file containing the entry `preIterationTierCheck` writes when a story exceeds its rung budget also returns one observation of kind `escalation`.
- [integration] `collectObservations` run over a log file containing one escalation entry returns an observation whose `payload.from` is a non-empty string.

### US-002: Runtime crashes retry the same tier

- [unit] `shouldRetrySameTier` returns `true` when given a result whose `status` is `"RUNTIME_CRASH"`.
- [unit] `shouldRetrySameTier` returns `false` when given `undefined`.
- [unit] `shouldRetrySameTier` returns `false` when given a result whose `status` is `"TEST_FAILURE"`.
- [unit] `handleTierEscalation` returns an outcome of `"retry-same"` when its context carries a runtime-crash result.
- [unit] `handleTierEscalation` returning `"retry-same"` reports `prdDirty` of `false` and returns the PRD it was given, unmodified.
- [unit] `handleTierEscalation` given a `tddFailureCategory` other than `"runtime-crash"` returns an outcome of `"escalated"` and advances the story's `routing.modelTier` by one rung.
- [integration] `handlePipelineFailure` handling an escalate action derives a runtime-crash result from `pipelineResult.context.tddFailureCategory` equal to `"runtime-crash"` and passes it to `handleTierEscalation`.
- [integration] after `handlePipelineFailure` handles an escalate action for a runtime-crash failure, the story's `routing.modelTier` is unchanged from its value before the call.
- [integration] after that same call, the story's `attempts` is not reset to `0`.
- [integration] `handlePipelineFailure` handling an escalate action for a non-crash failure still advances the story's `routing.modelTier` by one rung.

### US-003: Per-tier attempt budgets bind

- [unit] parsing an empty configuration object with `NaxConfigSchema` yields `autoMode.escalation.tierOrder` equal to a three-rung ladder of `fast`, `balanced`, `powerful`, each with `attempts` of `2`.
- [unit] `calculateMaxIterations` applied to that default ladder returns `6`.
- [unit] `preIterationTierCheck` reports `shouldSkipIteration` of `false` for a story whose `attempts` is `1` against a current rung whose `attempts` budget is `2`.
- [unit] `preIterationTierCheck` reports `shouldSkipIteration` of `true` for a story whose `attempts` is `2` against a current rung whose `attempts` budget is `2`.
- [unit] when `preIterationTierCheck` reports `shouldSkipIteration` of `true`, the story in its returned PRD has `routing.modelTier` advanced to the next rung.
- [unit] when `preIterationTierCheck` reports `shouldSkipIteration` of `true`, the story in its returned PRD has `attempts` reset to `0`.
- [unit] `preIterationTierCheck` reports `shouldSkipIteration` of `false` for a story whose current tier is absent from `tierOrder`, regardless of its `attempts` value.
- [unit] `preIterationTierCheck` reports `shouldSkipIteration` of `false` when `autoMode.escalation.enabled` is `false` and the story's `attempts` equals its rung budget.
- [integration] stubbing `preIterationTierCheck` and running the sequential executor dispatch invokes it once with the selected story before `runIteration` is invoked *(seam S1)*.
- [integration] stubbing `preIterationTierCheck` to report `shouldSkipIteration` of `true` and running the sequential executor dispatch results in `runIteration` not being invoked for that story *(seam S2)*.
- [integration] stubbing `preIterationTierCheck` and running the batch executor dispatch invokes it once for each story in the batch before the batch is dispatched *(seam S3)*.
- [integration] a story failing twice at the `fast` rung under the default ladder reaches the `balanced` rung and not the `powerful` rung.

**Out of scope:** concurrent-write atomicity on the PRD when two stories in a batch escalate simultaneously — the existing single-writer contract is unchanged and this feature adds no new writer.

<!-- spec-writing: completed-through-phase-6 -->
