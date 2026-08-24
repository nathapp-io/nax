# HANDOFF #1514 — the tail, by recipe (batch 2)

Successor to `HANDOFF-1514-tail-recipes.md`. Written against `main` @ `b552fce6a`.
Every number below was measured on that tree, and every recipe was applied to the live
tree and reverted — none is estimated.

**State at hand-off:** test typecheck **383** (186 files), casts **102**, and all eight
escape-hatch counters exactly at baseline (`asAny=1386 tsSuppress=40 ratchetAllow=106
absentValue=17 anyType=1877 looseCast=1925 asNever=619 nonNullAssert=827`). There is **no
slack left in any ratchet** — §32 reclaimed it. `src` tsc is 0.

Read `STATUS-1514-drain.md` §0 for live numbers and §33 for what the last round found.

---

## 0. The guards this handoff depends on

Same as batch 1's §0, plus one new one. All still enforced by `check:test-escape-hatches`:

- **G1 — the syntax guard.** After every edit, `bun x tsc -p tsconfig.test.json --noEmit`
  must print the ONE known pre-existing `TS1355` line and nothing else in that family. A
  botched multi-line replacement can still typecheck (§22 near-miss); this is what catches it.
- **G2 — never add a counter.** `as any`, `: any`, `as T`, `as never`, postfix `!`,
  `@ts-expect-error`, `ratchet-allow` are all counted, `as never` and `!` since §32. A
  typecheck drop paid for with a counter rise is a **failed** batch, not a partial win.
- **G3 — `src/` is out of scope for a delegate.** If the honest fix is in `src/`, stop and
  escalate. (§21 re-ruled this: `src/` is in scope for the owner, never for a delegate.)
- **G4 — one file per commit**, staged explicitly. Never `git add -A` (§30 swept 35 junk
  artifacts that way).
- **G5 — a shared helper is off-limits** even when the *file* is in scope. Extending a
  69-consumer fixture helper without asking is what §4a had to ratify after the fact.
- **G6 — NEW. Read the `src/` side AND the sibling tests before calling a cluster
  undelegable.** §4 of batch 1 escalated a cluster on a src-only read; the recipe was
  sitting in four sibling files. Reading `src/` is necessary, not sufficient.
  See `STATUS-1514-drain.md` §33.

---

## 1. The loop — every commit, no exceptions

```bash
# 1. edit the ONE file

# 2. syntax guard (G1) — the one known TS1355 line, nothing else
bun x tsc -p tsconfig.test.json --noEmit 2>&1 | grep TS1355

# 3. src must stay 0
bun run typecheck

# 4. total must move by the amount §3's per-file table gives for THIS file — which is
#    0 for verifier-pick.test.ts (§2B). Read the TS2353 warning in §5 before trusting
#    "no more, no less"; it is a floor, not a census.
bun x tsc -p tsconfig.test.json --noEmit 2>&1 | grep -cE '^[^(]+\([0-9]+,[0-9]+\): error TS'

# 5. formatting + import order on just this file (4ms, catches the import trap early)
bun x biome check --write <the-one-file>

# 6. the file's own tests
bun test <the-one-file> --timeout=30000

# 7. 25 gates, both ratchets included
bun run check:all

# 8. full suite
bun run test

# 9. baseline LAST, only when 2-8 all passed
bun run check:test-typecheck:update

# 10. commit — stage explicitly
git add <the-one-file> scripts/baselines/test-typecheck-baseline.json
```

### The bail rule

Unchanged and not optional: **a reverted file is a good outcome; a silenced file is a
failed batch.** If a fix wants a cast, an `as never`, a `!`, or a `src/` edit — revert the
file, leave its errors in the baseline, and say in the report what you saw. Three of the
six batches so far had at least one cluster whose stated cause was wrong (§29 twice, §31
three files, §4 once). The prior on any verdict in this document — including a
"delegable" one — is weak.

---

## 2. The clusters

Each was applied to the live tree at one representative site, measured, and reverted.
"Measured" below means the total moved by exactly that amount with nothing unmasked.

| # | Cluster | Errors | Files | State | Measured |
|:--|:--|--:|--:|:--|:--|
| A | `durationMs` → `runElapsedMs` | 7 | 4 | DELEGABLE | **−7**, all sites |
| B | dead `models: {}` in debate selectors | 4 sites, **3 errors** | 4 | DELEGABLE, read the warning in §2B | **−3**, all sites |
| C | otel `logs` fixture field | 4 | 4 | DELEGABLE | **−4**, all sites |
| D | `untrackedBefore` on `InspectionOptions` | 4 | 3 | DELEGABLE | **−4**, all sites |
| E | `failedTestFiles` on `DeferredRegressionResult` | 5 | 1 | DELEGABLE | **−5**, all sites |
| F | `featureName` on `TriggerContext` | 4 | 1 | DELEGABLE, read §2F first | **−4**, all sites |
| G | precheck config fixtures | ≥11 | 5 | **OWNER — see §5** | −2 on one file, after 3 wrong attempts |

Clusters A–F are **28 edits worth 27 errors across 17 files, 383 → 356**. Cluster G is not
in that number.

> **The "measured" column is a whole-batch measurement, not six single-site ones.** The
> first draft of this handoff sized each cluster from one representative site and published
> 355. Applying all 28 edits together landed **356**: cluster B has 4 sites but yields 3
> errors, because one of them is masked (§2B). **A single-site measurement does not
> generalize to its cluster** — that is the same floor effect §5 describes, appearing inside
> a cluster marked delegable. Multi-site files were otherwise additive (events-writer 5→3,
> hooks 4→2, reporters 3→1, post-run-isolation 2→0, lifecycle-completion 5→0).
>
> Verified on the full batch before reverting: **258 tests across the 22 touched files, 0
> fail**, and all eight counters plus `as unknown as` flat.

### 2A. `durationMs` → `runElapsedMs` (7 errors, 4 files)

`StoryCompletedEvent` (`src/pipeline/event-bus.ts:51`) declares **`runElapsedMs: number`**,
and the production emitter (`src/pipeline/stages/completion.ts:167`) sets it from
`storyMetric?.durationMs`. The fixtures use the metric's name, not the event's. No subscriber
reads either field off `story:completed` (`reporters.ts:144`, `events-writer.ts:95`,
`hooks.ts:72`), and no assertion touches the value — these are emit fixtures.

Rename in place. Sites:

```
test/unit/pipeline/event-bus.test.ts(12,5)
test/unit/pipeline/subscribers/events-writer.test.ts(128,7) (179,7)
test/unit/pipeline/subscribers/hooks.test.ts(58,9) (80,9)
test/unit/pipeline/subscribers/reporters.test.ts(71,7) (144,9)
```

> **TRAP — do not sed.** `durationMs` is a **real, required** field on three *other* event
> types emitted in these same files: `run:completed`, `story:phase:completed`,
> `postrun:phase:completed`. `reporters.test.ts` alone has 9 legitimate `durationMs` lines
> and 2 wrong ones, and `reporters.test.ts:235` **asserts on** a legitimate one. Rename only
> the 7 sites listed above — the ones inside a `type: "story:completed"` literal.

### 2B. dead `models: {}` in the debate selectors (4 errors, 4 files)

`SelectorContext["config"]` is `DebateConfig` = the `Pick<NaxConfig, "agent" | "debate">`
slice (`src/debate/selectors/types.ts:15` → `src/config/selectors.ts:154`). `models` is not
in the slice, and **nothing under `src/debate/` reads `.models`** (grep is empty). It is a
dead key. Delete the line.

```
test/unit/debate/selectors/judge.test.ts(37,3)      majority.test.ts(34,3)
test/unit/debate/selectors/synthesis.test.ts(37,3)  verifier-pick.test.ts(52,7)
```

Measured on `judge.test.ts`: 383 → 382, file clean, nothing unmasked.

> **`verifier-pick.test.ts` yields ZERO — and it is still the right edit.** That file carries
> four other errors, and its `models` line sits inside a context literal whose own `TS2322`
> (line 28) masks it. Deleting the dead key there is correct and changes the total by
> **nothing**. Expect it, make the edit anyway, and say so in the commit — do **not** treat
> the flat total as a failed edit and revert it, and do **not** go hunting for a second thing
> to fix in that file to make the arithmetic come out. The other three sites are −1 each.

This is the **fourth sighting** of the `models` rename (§8, §31, batch 1 §5). It is finally
just a dead key; do not go looking for a wider migration behind it.

### 2C. otel `logs` fixture field (4 errors, 4 files)

`OtelReporterConfigSchema` (`src/config/schemas-reporters.ts:36-41`) gained
`logs: { enabled, level }` with the default `{ enabled: false, level: "info" }`
(line 53). Four fixtures predate it. Add exactly the schema default:

```ts
logs: { enabled: false, level: "info" },
```

```
test/unit/plugins/builtin/otel-reporter-lifecycle.test.ts(16,7)
test/unit/plugins/builtin/otel-reporter-logs-lifecycle.test.ts(44,7)
test/unit/plugins/builtin/otel-resource-adoption.test.ts(338,9)
test/unit/plugins/builtin/otel-resource-git.test.ts(17,7)
```

Note `otel-reporter-logs-lifecycle.test.ts` is the file that *tests* logs — its `baseCfg`
still wants the disabled default; the file already has a `makeLogsOn()` helper for the
enabled cases (line 97). Do not "helpfully" set `enabled: true` there.

### 2D. `untrackedBefore` on `InspectionOptions` (4 errors, 3 files)

`src/execution/post-run.ts:52` declares `untrackedBefore: string[] | null`, required, and
`post-run.ts:494` passes it straight to `rollbackToRef`. The fixtures already pass the
sibling field `initialRef`. Add `untrackedBefore: null` — the same value the production
non-TDD path uses (`src/pipeline/stages/execution.ts:146` yields `null` when `tddMode` is
false, and every one of these fixtures sets `tddMode.rollbackEnabled: false`).

```
test/integration/execution/scratch-per-role.test.ts(32,53)
test/integration/execution/verdict-cleanup.test.ts(29,51)
test/unit/execution/post-run-isolation.test.ts(35,58) (70,58)
```

### 2E. `failedTestFiles` on `DeferredRegressionResult` (5 errors, 1 file)

`src/execution/lifecycle/run-regression.ts:116` declares `failedTestFiles: string[]`,
required. `run-regression.ts:212`, `:252` and `run-regression-triage.ts:142` all default it
to `[]`. Add `failedTestFiles: []` at all five sites in
`test/unit/execution/lifecycle-completion.test.ts` (128, 149, 191, 311, 486).

Do **not** reach for `failedTests` — it is a separate `number` field, and
`run-completion.ts:214` assigns `failedTests: regressionResult.failedTestFiles`, which is
confusing but is `src/` behaviour and not yours to change (G3).

### 2F. `featureName` on `TriggerContext` (4 errors, 1 file)

`src/interaction/triggers.ts:13` requires `featureName: string`. The four failing calls are
in the `substituteTemplate (BUG-43)` describe block of
`test/unit/interaction/triggers.test.ts` (258, 268, 274, 286) and pass minimal literals.
Add `featureName: "f"`.

> Check the assertion each time. These tests are about **template-key escaping**, so the
> context's key set is the thing under test. Adding `featureName` is safe only because none
> of the four templates contains `{{featureName}}` and each asserts an exact output string —
> verify that before each edit rather than assuming it.

**Recorded, not fixed:** `substituteTemplate` is a pure string helper that only indexes keys,
so arguably its parameter should be `Record<string, unknown>` rather than the full
`TriggerContext`. That is a `src/` signature change — G3 — and adding the field is honest in
the meantime, since every production caller does have a `featureName`.

---

## 3. Expected landing

**28 edits worth 27 errors across 17 files, in 17 commits — 383 → 356.**

Per file, the expected drop is:

| file | drop |
|:--|--:|
| `pipeline/event-bus` | −1 |
| `pipeline/subscribers/events-writer` | −2 |
| `pipeline/subscribers/hooks` | −2 |
| `pipeline/subscribers/reporters` | −2 |
| `debate/selectors/judge`, `majority`, `synthesis` | −1 each |
| `debate/selectors/verifier-pick` | **0 — see §2B** |
| the four `plugins/builtin/otel-*` | −1 each |
| `execution/post-run-isolation` | −2 |
| `integration/execution/scratch-per-role`, `verdict-cleanup` | −1 each |
| `execution/lifecycle-completion` | −5 |
| `interaction/triggers` | −4 |

A total *below* 356 means something in §1 did not hold, most likely G1 or an unmasking you
did not name: say so in the report rather than adjusting the baseline to match. A total
above 356 means a file was reverted; name it and say what you saw.

Every counter must be flat or lower at the end. Verified counter-flat across the whole
batch, so a rise is your edit, not the recipe.

Also run the touched files' own tests: **258 tests across the 22 touched files, 0 fail** on
the full batch.

---

## 4. Not in this batch

- **`TS2769` "no overload matches this call" (23).** Carried over from batch 1 §5. Still
  scattered, still no shared cause found.
- **`TS7024` implicit-`any` recursive return (9).** Needs a real return type worked out per
  function — cheap to get wrong, invisible when wrong.
- **`TS2352` → `Record<string, unknown>` (7 errors, 7 files).** Looks like the cluster §22
  drained, and may well be another dead-cast group, but **it was not verified for this
  handoff** — neither the `src/` side nor the siblings were read. Do not treat the
  resemblance as a recipe; measure it first.
- **`DispatchContext` (3)** and the rest of the long tail: per-site.

---

## 5. Cluster G — precheck config fixtures — **OWNER, and here is why**

5 errors are visible (`resetMode` missing, one per file). **The visible count is wrong**, and
the reason generalises beyond this cluster:

> **TS2353 reports at most ONE excess property per object literal.** A fixture with six dead
> keys shows one error. Fix it and the next appears. The 383 baseline is a **floor**, not a
> census, wherever dead fixture keys are stacked.

Measured on `test/unit/precheck/precheck-checks-tier1-blockers.test.ts`, whose baseline is
2 errors:

| attempt | result |
|:--|:--|
| add `resetMode: "initial"` | total **unchanged** — unmasked `defaultAgent` (ADR-012 removed it) |
| also delete `defaultAgent`, `requireExplicitContextFiles` | total unchanged — unmasked `preflightExpectedFilesEnabled`, `fallbackOrder` |
| `makeConfigSlice("execution" / "autoMode", …)` | 383 → 376 — unmasked a top-level `rectification` that belongs under `execution` |
| whole fixture → `makeNaxConfig({ … })` | **383 → 375, file clean, 30 pass / 3 skip / 0 fail** |

So the fix exists and is good — `createMockConfig` becomes `makeNaxConfig({...})`, which is
what the file's own `quality`/`tdd` lines were already reaching for via `makeConfigSlice`
(G6's sibling check, satisfied *inside the same file*). It is marked owner-only for three
reasons, any one of which is enough:

1. **The loop's step 4 does not work here.** "Total must go down by exactly the number of
   errors this file had" is the delegate's main safety rail, and on a cascading literal the
   correct intermediate result is *no movement at all*. A delegate following the rule bails;
   a delegate ignoring it has no rail left.
2. **Rewriting the fixture to `makeNaxConfig` swaps sparse hand-written values for real
   schema defaults**, which changes what every test in the file exercises. On
   `tier1-blockers` that was fine — verified by running it — but it is a judgement call per
   file, not a mechanical substitution.
3. **The remaining four files are unmeasured.** `precheck-checks-tier2-warnings.test.ts`
   carries 5 baseline errors of its own, and the two `test/integration/cli/` files show 1
   each — which, given the point above, tells you nothing about how many are behind them.

Worked example to copy, plus the three dead-end attempts, are above; the conversion applied
and reverted cleanly on `chore/1514-tail-recipes-batch2`.

**The wider finding is the valuable part: any cluster whose errors are TS2353 needs its
expected yield measured, not counted from the baseline — and measured across the whole
cluster, not at one site.** Clusters A–F are TS2353/TS2741 too, and sizing them from one
representative site each gave 355 when the true figure is 356: `verifier-pick.test.ts`'s
`models` line is masked by a sibling error in the same file. One masked site in six clusters
is the error rate you should assume for the counts in this document.
