# Handoff: #1514 tail recipes, batch 3

Written 2026-08-24 against `chore/1514-tail-batch3-prep` @ `60cdf5ba2`.
Predecessor: `HANDOFF-1514-tail-recipes-batch2.md` (complete — see `STATUS-1514-drain.md` §34).

**Baseline at hand-off: test typecheck 299 across 157 files.** Every escape-hatch counter is
*at* its baseline (`asAny=1386, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1875,
looseCast=1923, asNever=619, nonNullAssert=827`) — the 4 points of slack §32 warned about were
reclaimed in `4723c7a7a`. **There is no headroom. A single new `as X` or `x!` fails the gate.**

Scope of this handoff: **clusters B and C, 19 errors, 12 files.** Expected landing **299 → 280**.
Cluster A is owner-only and is documented in §4 so it is not picked up by mistake.

---

## 1. The loop, per commit — non-negotiable

One file per commit. For each file:

1. `bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep '<file>'` — note the errors before.
2. Edit.
3. Same command — the named errors are gone and **no new ones appeared anywhere**
   (`bun run check:test-typecheck` total must be strictly lower).
4. `bun run check:test-escape-hatches` — **flat or lower on every counter.**
5. `bun test <file> --timeout=30000`, then `git stash` / same command / `git stash pop`, and
   **compare pass, fail, and `expect() calls` counts.** All three must match.
   §37 caught a silently-flipped assertion this way that typecheck could not see.
6. `bun run lint:fix` before committing (Biome will re-sort a new import and reflow a changed
   arrow — it is not optional, `check:all` runs `lint` first).

After the last commit: `bun run check:all` (25 gates), `bun run test` (full suite), then
`bun run scripts/check-test-typecheck.ts --update-baseline` and commit the baseline **last**.

**Bail rule, unchanged from batch 1: a reverted file is a good outcome; a silenced file is a
failed batch.** If a file needs `as any`, `as never`, `as unknown as`, a `!`, or a
`@ts-expect-error` to go green, revert it and write down why. Do not widen a `src/` type
(§21: `src/` is in scope for the owner, never for a delegate) — escalate instead.

---

## 2. Cluster B — `models:` fixtures still in the flat pre-per-agent shape (9 errors, 3 files)

### Why they fail

`src/config/schema-types.ts:29` declares `ModelsConfig = Record<string, Record<ModelTier,
ModelEntry>>` — keyed by **agent name first**, then tier. These fixtures still use the old flat
tier-keyed shape, so each tier key reports
`Type 'string' is not assignable to type 'DeepPartial<Record<ModelTier, ModelEntry>>'`.

### The recipe — proven on the live tree and reverted

Nest the tier map under the agent key. `test/unit/config/validate.test.ts` and
`test/unit/config/merge-agent-models-routing.test.ts` already use this shape; `claude` is the
conventional key there.

```ts
// before
models: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
// after
models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
```

Measured on `test/unit/execution/story-context.test.ts`: **299 → 296**, `4 pass / 0 fail /
9 expect() calls` identical before and after, zero counter movement. Reverted so the whole
cluster lands as one measurable batch.

### The sites

| File | Errors | Line |
|:--|--:|--:|
| `test/unit/execution/story-context.test.ts` | 3 | 43 |
| `test/integration/routing/routing-stage-greenfield.test.ts` | 3 | 60–62 |
| `test/integration/routing/routing-stage-final-state.test.ts` | 3 | 49–51 |

### The one check you must do per file

These fixtures are **inert today**: `resolveModelForAgent` (`schema-types.ts:112`) looks up
`models[agent]?.[tier]` and throws `MODEL_NOT_FOUND` when absent, so a flat map resolves nothing.
Nesting it under `claude` makes the entry *reachable* for the first time. Before editing, grep
the file for the model strings and for `defaultAgent` / `modelDef` / `resolveModel`:

- **No assertion references them** — safe, nest under `claude`. (Verified true for
  `routing-stage-greenfield.test.ts` and `story-context.test.ts`.)
- **An assertion does reference a resolved model, or the test sets a `defaultAgent` other than
  `claude`** — nest under *that* agent name, and expect the step-5 counts to change. If they
  change, **revert and escalate**: the fixture was load-bearing and the test's meaning is at
  stake.

`routing-stage-final-state.test.ts` has not been checked. Do it before editing.

---

## 3. Cluster C — imports naming symbols the barrel does not re-export (10 errors, 8 files)

### Why they fail

TS2305 / TS2724. In every case **the symbol exists in `src/`** — it is simply not re-exported
from the barrel the test imports from. The fix is to import it from the module that declares it.

**This is legal and gate-safe because these are all `import type`.**
`scripts/check-alias-internals.ts` exempts type-only imports from the barrel rule explicitly
(its header, exemption 1: erased at compile time, cannot affect runtime module wiring). **If a
site is not `import type`, do not convert it — revert and escalate.**

### The sites and their real homes

| File:line | Symbol | Import from |
|:--|:--|:--|
| `test/integration/execution/status-file-integration.test.ts:26,27` | `PlanOptions`, `PlanResult` | `@/agents/shared/types-extended` |
| `test/unit/execution/oscillation-breaker.test.ts:13` | `PipelineContext` | `@/pipeline/types` |
| `test/unit/execution/rectification-oscillation-circuit-breaker.test.ts:33` | `PipelineContext` | `@/pipeline/types` |
| `test/unit/pipeline/stages/execution-unified.test.ts:14` | `PipelineContext` | `@/pipeline/types` (the current specifier `@test/src/pipeline` is not a real alias — TS2307) |
| `test/unit/execution/rectification-budget-invariants.test.ts:33` | `DeterministicOperation` | `@/operations/types` |
| `test/unit/plugins/builtin/webhook-reporter.test.ts:3` | `PhaseStartEvent`, `PhaseCompleteEvent` | `@/plugins/extensions` |
| `test/unit/agents/acp/adapter-output-timedout.test.ts:2` | `InteractionExchange` | `@/agents/types` |
| `test/unit/operations/mutation-check-diff-scope.test.ts:236` | `GenerateMutantsInput` | `@/verification/mutation/mutator` |

**`PlanResult` is ambiguous** — two unrelated interfaces carry that name
(`src/plan/strategies/types.ts:69` and `src/agents/shared/types-extended.ts:72`). The file
imports it alongside `PlanOptions`, which exists only in `types-extended`, so that is the
intended one; confirm by reading how the test uses the value before committing.

Two of these sit in files that also carry unrelated errors. **Fix only the import error.** The
file's total must drop by exactly the number in the table; if it drops by more, you have masked
something — read what changed before keeping it.

---

## 4. NOT in scope — cluster A and the rest, with the evidence

Do not start these. They are recorded so nobody re-derives them.

- **A — `Mock` into a typed function slot (46 errors, ~30 files).** The largest thing left and
  the most dangerous: `as never` silences every one of them in one word. It is **not one
  recipe**. Three sub-families found so far, and only the first is mechanical:
  - **A1, literal widening — done, `60cdf5ba2`.** A mock's inferred `status: string` against a
    `VerificationStatus` union. Fixed by annotating the mock's return type
    (`mock(async (): Promise<VerificationResult> => …)`), no cast. Where the mock also reads
    `.mock.calls` off the dep slot (a consequent TS2339), hoist it to a typed local and assign
    the local. 303 → 299.
  - **A2, fixture missing required fields** (e.g. `orchestrator-totals.test.ts:40` — a
    `RunTestsResult` lacking `parsedSummary`, `timedOut`). Looks mechanical; is not verified.
  - **A3, the fixture is factually wrong and the wrongness is load-bearing.**
    `mutation-check-revert.test.ts:105` and `mutation-check-telemetry.test.ts:200` return
    `status: "FAILURE"`, which is not a `VerificationStatus` member. "Correcting" it to
    `"TEST_FAILURE"` is not inert: `classifyMutant` (`src/verification/mutation/classify.ts:14`)
    switches on `status`, and `"FAILURE"` currently falls to the `default:` arm and **throws**
    `MUTATION_UNHANDLED_STATUS`, while `"TEST_FAILURE"` returns `killed` or `errored` depending
    on the pass/fail counts. The test asserts the op continued and stopped after one mutant, so
    the throw may be exactly what it is measuring. **Owner-only.**
- **`pb-004-migration.test.ts:307,318` (2 × TS2307).** The test imports `@/tdd/prompts` and
  `@/execution/prompts` *in order to assert they were deleted*. The error is intrinsic to what
  the test proves. `@ts-expect-error` would raise `tsSuppress` past baseline. Owner-only —
  likely an accepted exception documented the way §8 documented the 102 casts.
- **D — TS2353 dead fixture keys (35 errors).** Genuinely scattered now: the most frequent key
  appears 3 times. Also subject to the `ts2353-baseline-is-a-floor` trap — one excess-property
  error is reported per literal, so stacked dead keys hide behind each other and a
  "total must drop by exactly N" rail inverts. Owner.
- **Everything else** — 87 TS2322, 30 TS2352, 25 TS2339, 22 TS2739, 19 TS2741, 19 TS2345,
  14 TS2349, 12 TS2554 and a tail below that. Unread. Re-run the histogram before picking one;
  per §37, earlier "no shared cause" verdicts did not survive per-site reading.

---

## 5. Reporting back

Report, in this order: the per-cluster error delta you measured (not estimated), every file you
reverted and why, every counter's before/after, and the `check:all` / full-suite result. A
cluster that lands short of its number with a written reason is a success; a cluster that hits
its number with a silenced file is not.
