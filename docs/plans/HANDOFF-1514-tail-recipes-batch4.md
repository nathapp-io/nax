# HANDOFF: #1514 tail recipes, batch 4 — the fixture-shape family

Written 2026-08-24 against `main` @ `aba3f9b84`. Every number below was measured on that
tree, and every recipe below was **executed on the live tree and reverted** before this
document was written. Nothing here is an estimate from reading code.

**State at hand-off (re-measured, not carried forward):**

| | value | baseline | slack |
|:--|--:|--:|--:|
| test typecheck | **245** | 245 | 0 |
| `as unknown as` | 102 | 102 | 0 |
| `asAny` / `tsSuppress` / `ratchetAllow` / `absentValue` | 1386 / 40 / 106 / 17 | same | 0 |
| `anyType` / `looseCast` / `asNever` / `nonNullAssert` | 1875 / 1923 / 615 / 827 | same | 0 |
| `tsc --noEmit` (src) | 0 | — | — |

The escape-hatch slack that re-opened in §32 and again in §38 of `STATUS-1514-drain.md` is
**closed** — every counter sits exactly at baseline. Do not spend it; there is none.

---

## 1. What this batch is

One family, two presentations:

- **F1 — a mock assigned into a typed function slot returns the wrong object shape.**
  Reported as `TS2322` with a target type that starts with `(`. 11 errors.
- **F2 — a fixture object is missing one required property.** Reported as `TS2741`,
  which *names the property for you*. 16 errors.

Both are fixed the same way: **make the fixture match the type it is already being assigned
to.** No cast, no `any`, no src change, no shared-helper edit.

**Expected: 245 → ~218.** That number is **soft** — it is 27 errors across ~20 files, not
one recipe applied 27 times, and some files carry a second masked error that will surface or
resolve as collateral. Do not chase the number; land what verifies and report the actual.

## 2. The recipe

### F2 (`TS2741`) — no discovery needed

tsc already tells you the property. Add it with an inert value, run the file, compare
`pass` / `fail` / `expect()` counts against before. Done.

### F1 (`TS2322` into a function slot) — one discovery step first

The error message is useless as printed, because `mock()` wraps the callback and tsc reports
the whole `Mock<…>` as unassignable without saying why:

```
Type 'Mock<() => Promise<{ passed: boolean; failed: number; output: string; }>>' is not
assignable to type '(input: FullSuiteGateInput, gateCtx: FullSuiteGateContext) => Promise<RunTestsResult>'.
```

**Discovery step — temporarily drop the `mock()` wrapper and annotate the return type.** The
slot type is always reachable through the dep bag, so you never need to import an unexported
result type (`RunTestsResult` is *not* exported; `FullSuiteGateDeps` is, and
`typeof _fullSuiteGateDeps.runTests` reaches it):

```ts
// temporary, for the diagnostic only
const stub: typeof _fullSuiteGateDeps.runTests = async () => ({
  passed: true, failed: 0, output: "all pass",
});
```

tsc now says exactly what is wrong, and it is one of two things:

```
Type '{ passed: true; failed: number; output: string; }' is missing the following
properties from type 'RunTestsResult': parsedSummary, timedOut          ← F1a: add the fields
Type 'string' is not assignable to type '"typescript" | "javascript" | …'  ← F1b: widening
```

- **F1a — missing fields.** Restore `mock(...)`, add the named fields with inert values.
  The annotation is then unnecessary; leave the minimal diff (verified: with the fields
  present, the bare `mock(...)` assignment typechecks).
- **F1b — literal widening.** Keep the annotation and stop. It is the whole fix — the
  literals get their union-member type. This is §38's cluster A1 recipe; it still has sites.

### After every edit

`bun run lint:fix`. Adding an annotation pushes lines past the formatter's width and
reorders imports; biome fails the file otherwise. (Seen on all four prototypes.)

## 3. Prototype log — what was actually run

Four sites, five errors, each applied, measured, and reverted. Test counts are before → after.

| Site | Shape | Fix | Errors | Tests |
|:--|:--|:--|--:|:--|
| `test/unit/tdd/orchestrator-totals.test.ts:40` | F1a `RunTestsResult` | add `parsedSummary`, `timedOut` | 245 → 244 | 3 pass / 7 expect → identical |
| `test/integration/tdd/story-orchestrator-failureCategory.test.ts:154` | F1a `RunTestsResult` | add `timedOut: false` | 245 → 244 | 6 pass / 6 expect → identical |
| `test/unit/review/semantic-agent-session.test.ts:60,73` | F1a `CompleteResult` | drop dead `costUsd`/`source`, add `tokenUsage`, `estimatedCostUsd` | 245 → **243** | 20 pass / 37 expect → identical |
| `test/unit/cli/plan.test.ts:578` | F1b `SourceRoot[]` | annotate `Promise<SourceRoot[]>` | 245 → 244 | 46 pass / 99 expect → identical |

Counters were re-checked mid-prototype and did not move (`asAny=1386 … nonNullAssert=827`).
Removing an `as const` is counter-neutral: `looseCast` is `/\bas\s+[A-Z]\w*/` and `const` is
lowercase.

### Two hazards the prototypes exposed

- **A dead key can be carrying a value the test means to be read.** The `CompleteResult`
  mocks return `{ output, costUsd: cost, source: "mock" }`. `costUsd` and `source` are not
  on the type at all; `tokenUsage` and `estimatedCostUsd` are missing. Deleting `costUsd`
  and adding `estimatedCostUsd: cost` is the right fix **only because the `cost` parameter
  is plainly meant to reach the consumer** — mapping it to the wrong field, or dropping it,
  is a silent behaviour change that the type system cannot see. Carry the value across;
  never delete a dead key that holds a non-default value without checking what reads it.
- **The `TS2741` you can see may not be the file's only error.** `orchestrator-totals`
  had two (the F1a site and an unrelated `TS2353` dead key). Fixing one left the other, and
  the file's count went 2 → 1. Per-file counts, not the global total, are the honest unit.

## 4. In scope — the rows

### F1 — function-slot rows (11)

| File:line | Target | Sub-shape |
|:--|:--|:--|
| `unit/tdd/orchestrator-totals.test.ts:40` | `RunTestsResult` | F1a — **proven** |
| `integration/tdd/story-orchestrator-failureCategory.test.ts:154` | `RunTestsResult` | F1a — **proven** |
| `unit/review/semantic-agent-session.test.ts:60,73` | `CompleteResult` | F1a — **proven** |
| `unit/cli/plan.test.ts:578` | `SourceRoot[]` | F1b — **proven** |
| `unit/review/adversarial-threshold.test.ts:159` | `CompleteResult` | F1a — same `completeFn` literal |
| `unit/execution/lifecycle/acceptance-loop-routing.test.ts:54` | `CompleteResult` | F1a — `source: "exact"` variant |
| `unit/session/manager-phase-b-session.test.ts:316` | `TurnResult` | F1a |
| `unit/commands/replay.test.ts:438` | `NaxStatusFile` | run the discovery step — may be dead-key, not missing-field |
| `unit/execution/unified-executor-session-close.test.ts:126,143` | long-signature slot | heaviest two; do them last, and stop if the literal has to be rebuilt rather than extended |

### F2 — `TS2741` rows (16)

All 16 name their own property. `pb-004-migration.test.ts:153,166,364`
(`behavioralGuardrails`), `manager-credentials.test.ts:51` (`info`),
`manager-narrowed.test.ts:12` (`profile`), `run-completion-aggregator.test.ts:52`
(`totalExactCostUsd`), `report.test.ts:306,311` (`toJSON`), `verify-op.test.ts:251,282`
(`normalizedFindings`), `runner-retry.test.ts:15` + `subscribers/hooks.test.ts:7` (`hooks`),
`prd-get-next-story.test.ts:196` (`reasoning`),
`precheck-canonical-lint-orchestrator.test.ts:39` (`resetMode`),
`loader.test.ts:273` (`context`), `runtime.test.ts:103` (`exactCostUsd`).

`report.test.ts:306,311` want `toJSON`, which is a method, not an inert data field —
`TokenUsage` (`src/metrics/types.ts:24`) is deliberately declaration-merged as both an
interface and a class so it can carry one. **Do not stub the method.** Construct the class:
`new TokenUsage({ inputTokens: 10, outputTokens: 20 })`, the idiom already used in
`test/unit/metrics/types.test.ts`. One caveat to verify rather than assume: `toJSON` omits
the cache fields when they are zero, so if the assertion serializes the object, check the
`expect()` count and the snapshot rather than trusting that the swap is inert.

## 5. Out of scope — by name, with the reason

Do not touch these. Each was checked; none is an oversight.

- **`unit/operations/mutation-check-revert.test.ts:105`, `mutation-check-telemetry.test.ts:200`**
  — §38's A3. `status: "FAILURE"` is not a `VerificationStatus`, and "correcting" it to
  `"TEST_FAILURE"` changes what `classifyMutant` (`src/verification/mutation/classify.ts:14`)
  does: `"FAILURE"` hits the `default:` arm and throws, which may be the thing under test.
- **`unit/session/manager-early-protocol-ids.test.ts:45,48`,
  `manager-run-in-session.test.ts:54,55,198`** — the *source* returns the named `AgentResult`
  and the *slot* is an anonymous structural clone of it. The wrong side is `src/`. Per §40,
  loosening or re-pointing a src type requires grepping `docs/adr/` first — "0 src errors
  when I change it" proves tolerance, not intent. **Escalate, do not fix.**
- **`integration/plugins/plugins-registry.test.ts:22`** — the fixture models a retired
  `PromptOptimizerResult` contract (`optimizedPrompt`/`tokensSaved`/`appliedStrategies` vs
  today's `prompt`/`originalTokens`/`optimizedTokens`/`savings`/`appliedRules`). A wholesale
  rename, not a field addition. Owner.
- **`unit/execution/story-orchestrator-no-progress-bail.test.ts:188,218`** — `CallOpFn`
  tier-3 residue, an accepted exception (`PLAN-1514-callop-seam.md`): those modules really
  are polymorphic.
- **`unit/precheck/precheck-run-story-size-gate-routing.test.ts:177,211`** — the known
  config-slice annotation residue (`_c: NaxConfig` vs `PrecheckConfig`), recorded in the
  phase-2 actuals table.
- **`unit/operations/call-op-retry.test.ts:320,390`, `unit/debate/verifiers/plan-checklist.test.ts:92`,
  `unit/precheck/checks-language-tools.test.ts:16,20`, `unit/execution/non-blocking-fix.test.ts:105`,
  `unit/cli/plan-callop.test.ts:217`** — parameter-type and return-type mismatches, not
  fixture shape. Each needs its own analysis; they are not this recipe.
- **All 12 `TS2352` rows** (`runner-parallel-metrics*.test.ts` ×4,
  `parallel-batch-rectification-context.test.ts` ×4, `run-regression*.test.ts` ×2,
  `quality/runner.test.ts:138`, `call-run-counter.test.ts:44`) — these sites **already carry
  an `as` cast**. Editing them can move `looseCast` / `asNever`, and there is zero slack.
  Separate batch.
- **`integration/prompts/pb-004-migration.test.ts`'s 2 × `TS2307`** (lines 307, 318) —
  intrinsic: the test `await import()`s `@/tdd/prompts` and `@/execution/prompts` inside
  `try/catch` and asserts each one rejects, i.e. the unresolvable module *is* the assertion.
  `@ts-expect-error` would breach `tsSuppress`. This is an accepted exception awaiting the §8 write-up, not debt.
  (Its three `TS2741` rows above *are* in scope — different errors, same file.)

## 6. Definition of done — per commit, not per batch

One file per commit. For each:

1. `bun x tsc --project tsconfig.test.json --noEmit` — the file's own count is lower and
   **no other file's count rose**.
2. `bun test <the file> --timeout=60000` — `pass` / `fail` / `expect()` counts **identical**
   to before the edit. A changed `expect()` count means the fixture was not inert; revert
   and escalate rather than updating the assertion.
3. `bun run lint:fix`, then `bun run lint`.
4. Commit. Tag: `#1514 tail batch 4`.

Before opening the PR:

- `bun run check:all` — 25/25 green.
- `bun run test` — full suite green.
- Per-file typecheck gate: no file worse, no new file with errors.
- `check:test-typecheck` baseline lower; **`as unknown as` and all eight escape-hatch
  counters equal or lower**. No batch may trade one counter against another — a typecheck
  drop paired with an `anyType` rise is a failed batch, not a partial success.
- **Re-baseline every counter you lowered, in the same PR.** The gate only fails on growth,
  so a counter left below its baseline silently re-opens slack for the next batch. This leak
  has recurred three times (§32, §38, §40).

## 7. Hard bars

- **`test/helpers/**` is off-limits.** Not "out of scope" — off-limits. The mechanical-fixtures
  executor extended `FakeProcSpec`, a 69-consumer helper, without escalating (§4a). If a fix
  seems to need a shared helper change, stop and escalate.
- **No new cast, no `any`, no `@ts-expect-error`, no `as never`.** All are counted and all
  are at their floor.
- **Never widen a `src/` type to fit a fixture.** If the wrong side looks like `src/`,
  escalate — §40 has one case where that was right and one where it was wrong, and only an
  ADR grep told them apart.
- **Escalate rather than guess.** Two escalations in batch 3 were worth more than the errors
  they blocked.
