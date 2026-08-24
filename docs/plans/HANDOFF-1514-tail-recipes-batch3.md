# Handoff: #1514 tail recipes, batch 3

Written 2026-08-24 against `chore/1514-tail-batch3-prep` @ `d5016b4e6`.
Predecessor: `HANDOFF-1514-tail-recipes-batch2.md` (complete — see `STATUS-1514-drain.md` §34).

**Baseline at hand-off: test typecheck 289 across 150 files.** Every escape-hatch counter is
*at* its baseline (`asAny=1386, tsSuppress=40, ratchetAllow=106, absentValue=17, anyType=1875,
looseCast=1923, asNever=619, nonNullAssert=827`) — the 4 points of slack §32 warned about were
reclaimed in `4723c7a7a`. **There is no headroom. A single new `as X` or `x!` fails the gate.**

Scope of this handoff: **clusters B and E, 38 errors, ~28 files.** Expected landing
**289 → ~251**, with E's number soft (see §3). Clusters A and C are owner work and are
recorded in §4 so they are not picked up by mistake.

> **This doc was revised after a review pass.** Its first draft also handed off cluster C
> (missing barrel re-exports, "10 mechanical 30-second lookups"). Attempting to *verify* that
> claim is what drained it — and 2 of the 8 rows in the table were wrong. §4 keeps the record;
> the lesson is in `STATUS-1514-drain.md` §39.

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

## 3. Cluster E — fixtures missing required properties (29 errors, ~25 files)

### Why they fail

`Type 'X' is missing the following properties from type 'Y': …`. A hand-rolled partial object
is passed where a full interface is required. This is the same family
`HANDOFF-1514-mechanical-fixture-fields.md` drained successfully (91 errors) — read that doc
before starting, including its failure (§4a: the executor extended a 69-consumer shared helper
instead of escalating).

### The recipe, in priority order

1. **A `test/helpers/` factory already exists — use it.** Fifty-odd `makeX` factories are
   exported from `@test/helpers`; `bun run scripts/…` is not needed, just
   `grep "export function make" test/helpers/*.ts`. Several were *built for exactly this*:
   `makeLogger` (`test/helpers/mock-logger.ts`) documents in its header that `Logger` is a
   class, so no four-method object can ever satisfy it structurally, and the factory contains
   the one cast so consumers need none.
2. **No factory, and the missing fields are inert** — add them with obvious values. Confirm
   inertness the same way every other batch has: identical pass / fail / `expect() calls`.
3. **No factory and the fields are load-bearing** — revert and escalate. Do **not** write a new
   shared factory, and do **not** widen an existing one.

**The hard bar, and it is the reason this cluster is delegable at all:** the shared helpers in
`test/helpers/` are **off-limits to edit**. `makeLogger` has dozens of consumers;
`FakeProcSpec` had 69 when batch 1's executor quietly extended it. Using a helper is the
recipe; changing one is an escalation, every time, even when it looks like a one-field
addition.

### The sites, grouped

| Target type | Errors | Files | Factory available? |
|:--|--:|:--|:--|
| `ICostAggregator` | 4 | `runtime/runtime.test.ts` (223, 228, 269, 284) | no — check `test/helpers/runtime.ts` first |
| `CostEvent` | 3 | `integration/runtime/runtime-middleware.test.ts` (28, 86, 140) | no |
| `AgentAdapter` | 3 | `status-file-integration.test.ts:69`, `reporter-lifecycle-basic.test.ts:124`, `reporter-lifecycle-resilience.test.ts:104` | **yes** — `makeAgentAdapter` (`test/helpers/mock-agent-adapter.ts`) |
| otel reporter config literal | 3 | `plugins/builtin/otel-reporter.test.ts` (6, 153), `plugins/loader-reporters.test.ts:29` | no |
| `Logger` | 3 | `analyze/scanner.test.ts:167`, `utils/git.test.ts` (476, 507) | **yes** — `makeLogger`, but see the warning below |
| `Pick<NaxConfig, "agent"\|"execution"\|"profile">` | 2 | `agents/retry/hop-retry-policy.test.ts` (48, 54) | **yes** — `makeConfigSlice` (§config-slices) |
| `StoryRouting` | 2 | `escalation/tier-escalation-source-tier.test.ts:85`, `prd/prd-queue-actions.test.ts:37` | no |
| singletons | 11 | `AdversarialReviewInput`, `SemanticReviewInput`, `AgentCapabilities`, `ISessionManager`, `PackageRegistry`, `RunCompletionOptions`, `RunCompletionResult`, `SessionHandle`, `Record<ModelTier, ModelEntry>` | mixed — `makeSessionManager`, `makePluginRegistry` exist |

**The `Logger` warning — do not treat this row as a drop-in swap.** All three sites build an
ad-hoc logger *and assert against a local capture array* (`git.test.ts:475` pushes into
`errorCalls`). `makeLogger` exposes `.calls` instead, so adopting it means rewriting the
assertions. That is legitimate and probably an improvement, but it is a behaviour-visible edit:
the step-5 `expect() calls` count will move. **When a count moves for a reason you understand
and can write down, that is not automatically a failure — but it must be in the commit message,
and if you cannot explain the delta exactly, revert.**

### Why E's number is soft

29 errors, but they are 9 groups and a tail of singletons. Groups of 1–4 sharing a target type
are not the same thing as one recipe applied 29 times. **Land the grouped rows first and report
the measured total**; the singletons may each cost as much as a group.

## 4. NOT in scope — with the evidence

Do not start these. They are recorded so nobody re-derives them.

- **C — imports naming symbols their barrel does not re-export. DONE, `d5016b4e6`, 299 → 289.**
  Kept here because the *first draft of this handoff got it wrong twice*, and only doing the
  work surfaced it. `mutation-check-diff-scope.test.ts:236` was not an import at all — a
  namespace-qualified type on an `import * as`; and `status-file-integration.test.ts` was
  importing from `@/agents/types`, not from a barrel. Five of the eight also needed a mixed
  import split, which the draft never mentioned. The one claim that did hold: type-only imports
  from an internal path are exempt from `check-alias-internals` (its header, exemption 1), and
  the total fell by exactly 10 with no unmasking.
- **A — `Mock` into a typed function slot (~43 errors, ~30 files).** The largest thing left and
  the most dangerous: `as never` silences every one of them in one word. **Not one recipe:**
  - **A1, literal widening — done, `60cdf5ba2`.** A mock's inferred `status: string` against a
    `VerificationStatus` union. Fixed by annotating the mock's return type
    (`mock(async (): Promise<VerificationResult> => …)`), no cast. Where the mock also read
    `.mock.calls` off the dep slot (a consequent TS2339), hoist it to a typed local and assign
    the local. 303 → 299.
  - **A3, the fixture is factually wrong and the wrongness is load-bearing.**
    `mutation-check-revert.test.ts:105` and `mutation-check-telemetry.test.ts:200` return
    `status: "FAILURE"`, which is not a `VerificationStatus` member. "Correcting" it to
    `"TEST_FAILURE"` is not inert: `classifyMutant` (`src/verification/mutation/classify.ts:14`)
    switches on `status`, `"FAILURE"` falls to the `default:` arm and **throws**
    `MUTATION_UNHANDLED_STATUS`, and `"TEST_FAILURE"` returns `killed` or `errored` depending on
    the counts. The test asserts the op continued and stopped after one mutant, so the throw may
    be what it measures. **Owner-only.**
  - The remainder is unread. Cluster E overlaps it slightly — where a function-slot error is
    *caused* by a missing property, E's recipe applies; where it is caused by variance or arity,
    it does not.
- **`pb-004-migration.test.ts:307,318` (2 × TS2307).** The test imports `@/tdd/prompts` and
  `@/execution/prompts` *in order to assert they were deleted*. The error is intrinsic to what
  the test proves, and `@ts-expect-error` would raise `tsSuppress` past baseline. Owner-only —
  an accepted exception awaiting the §8 treatment, not debt.
- **D — TS2353 dead fixture keys (35 errors).** Genuinely scattered: the most frequent key
  appears 3 times. Subject to the `ts2353-baseline-is-a-floor` trap — one excess-property error
  is reported per literal, so stacked dead keys hide behind each other and a "total must drop by
  exactly N" rail inverts. Owner.
- **Everything else** — ~180 errors. Unread. Re-run the histogram before picking one; per §37,
  earlier "no shared cause" verdicts did not survive per-site reading.

## 5. Reporting back

Report, in this order: the per-cluster error delta you measured (not estimated), every file you
reverted and why, every counter's before/after, and the `check:all` / full-suite result. A
cluster that lands short of its number with a written reason is a success; a cluster that hits
its number with a silenced file is not.
