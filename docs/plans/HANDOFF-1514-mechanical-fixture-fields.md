# Handoff: mechanical fixture-field drain (#1514)

Written against `chore/1514-implicit-any-params` at `666b9e0a7`. Every number below was
measured on that tree with `bun x tsc --project tsconfig.test.json --noEmit`, not recalled.

**State at hand-off:** `test/` typecheck **1351**, casts **102**, `asAny` 1393,
`tsSuppress` 54, `ratchetAllow` 106, `absentValue` 17, `anyType` 1885, `looseCast` 2008.

---

## 1. Who this is for

This handoff is the **mechanical slice only**. It is written so a cheaper model can execute
it without design judgement. Read §5 (traps) before touching a file — every trap listed
there has already fired on this branch at least once.

**Do not extend the scope.** If a fix requires deciding what a type *should* be, it is not
in this handoff. Stop and escalate (§6).

---

## 2. Scope — exactly these three clusters

| Cluster | Errors | Files | Fix |
|:--|--:|--:|:--|
| A — `maxScanFiles` missing on `SmartTestRunnerConfig` | 12 | 5 | add `maxScanFiles: 200` |
| B — `workdir` missing on `AdversarialReviewInput` | 10 | 4 | add `workdir` |
| C — local spawn fakes not migrated to `makeSpawn` | 69 | 17 | replace with the existing helper |

**Total: 91 errors.** Nothing else. A and B are "the fixture omits a required field that
the production type declares" — the same class as `projectKey` (`1db22cbc1`) and
`estimatedCostUsd` (same commit), which are the worked examples to copy. C is a migration
to a helper that already exists.

### Cluster A — `maxScanFiles` (12)

```
test/unit/test-runners/resolver.test.ts                     8
test/unit/config/merge.test.ts                              1
test/unit/execution/plan-inputs-review-wiring.test.ts       1
test/integration/routing/routing-stage-greenfield.test.ts   1
test/integration/routing/routing-stage-final-state.test.ts  1
```

The value is **200** — the schema default at `src/config/schemas-execution.ts:114`
(`z.number().int().min(1).max(5000).default(200)`), repeated as a literal at line 120.
Do not invent a different number.

**One judgement call, and it is the only one in this cluster:** if a test asserts on
*truncation* behaviour (scanning stops after N files), 200 may be the wrong value for that
specific fixture. Check what each test asserts before defaulting. If a test looks like it
cares about the cap, escalate rather than guess.

### Cluster B — `workdir` (10)

```
test/unit/execution/build-plan-for-strategy-triage-assembly.test.ts    5
test/unit/execution/build-plan-for-strategy.test.ts                    2
test/unit/operations/timeout-resolvers.test.ts                         2
test/unit/execution/build-plan-for-strategy-triage-predicates.test.ts  1
```

All 10 are `AdversarialReviewInput`, and every one is the same literal shape — an
`adversarialReview: { story, adversarialConfig, mode }` that omits `workdir`. Use the
workdir value the surrounding test already uses: each of these files already sets
`workdir: "/tmp/test"` in its own story/context fixture. Match it; do not introduce a new
path convention.

**Piloted before writing this.** Adding `workdir: "/tmp/test"` to the two sites in
`build-plan-for-strategy.test.ts` took the total 1369 → **1367** — exactly −2, no unmask —
and the file stayed green (30 pass, 0 fail). The pilot was reverted; those two sites are
still yours to do. Expect the same 1:1 ratio for the rest of this cluster. **If the total
drops by less than the number of sites you fixed, you have hit an unmask** (TypeScript
reports the missing property *instead of* a second fault underneath); that is expected and
fine — see `HANDOFF-1514-dead-fixture-keys.md` §1 — but escalate if clearing it needs a
value you cannot derive.

### Cluster C — unmigrated spawn fakes (69)

```
test/unit/execution/checkpoint/resume-hydrate.test.ts                 15
test/unit/execution/pipeline-result-handler.test.ts                    9
test/unit/precheck/checks-blockers-agent.test.ts                       8
test/unit/execution/new-package-setup.test.ts                          7
test/unit/utils/git-auto-commit-block.test.ts                          7
test/unit/utils/git.test.ts                                            7
test/unit/plugins/builtin/otel-resource-git.test.ts                    5
test/unit/execution/build-plan-for-strategy-triage-predicates.test.ts  2
+ 5 files with 1 each
```

**`makeSpawn` already exists** — `test/helpers/spawn.ts`, exported from `@test/helpers`,
already used by 58 files. It holds the only two sanctioned casts for this shape, accepts
both `Bun.spawn` call forms (`(cmd, opts)` and a single options object), records every call,
and `makeSpawnResult` models `stdout`/`stderr`/`exitCode`/`pid`/`kill`/`hang`. These 17
files were simply never migrated: each still hand-rolls a local fake ending in
`as typeof _xDeps.spawn`.

The migration is: delete the local fake, call `makeSpawn(...)`, assign `.spawn`.

**Check the local fake's surface first.** If it models something `FakeProcSpec` does not
(a custom `kill` observer, a stdout that changes between calls, a stream that errors),
that file is out of scope — escalate rather than approximating. Read `test/helpers/spawn.ts`
before starting; it documents the intended usage.

---

## 3. The verification loop — run ALL of it, in this order

Per change (a cluster, or a file within one):

```bash
bun x tsc --project tsconfig.test.json --noEmit 2>&1 | grep -c "error TS"   # count went DOWN
bun test <the files you touched> --timeout=60000                            # green
```

Before **every** commit:

```bash
bun run lint:fix                          # biome; formatting is a gate
bun run test                              # full suite, all phases
bun run test:coverage                     # SEPARATE from check:all — see §5
bun run scripts/check-test-typecheck.ts --update-baseline
bun run check:all                         # every gate
```

Then commit. **The baseline update goes in the same commit as the fix it accounts for** —
otherwise the per-file gate fails at the intermediate commit.

### Definition of done

- `bun run check:all` green (every gate reports `[OK]`/`OK:`; 24 lines at the time of writing)
  and `bun run test` green **before** any baseline update.
- `bun run test:coverage` at or above floor, per-file ratchet **not worse**.
- `check:test-typecheck` baseline **lower**.
- `check:test-as-unknown-as` baseline **equal or lower** (must stay 102).
- `asAny`, `tsSuppress`, `ratchetAllow`, `absentValue`, `anyType`, `looseCast` **all equal
  or lower**. No change may trade one counter against another. A typecheck drop paired with
  an `anyType` rise is a failed change, not a partial success.

---

## 4. Commit convention

Conventional commits, one cluster per commit, tag `(#1514 mechanical-fixtures)`:

```
test(<area>): supply the required <field> on <Type> fixtures (#1514 mechanical-fixtures)

<why the field is required — cite the src line that declares it>

typecheck: <before> -> <after> (-N). No counter traded up.
```

Commit tags are **descriptive, never `phase N`** — the original #1514 plan already used
"phase 3a" for two different things.

---

## 5. Traps — every one of these has already fired on this branch

1. **Deleting or changing a fixture key can silently disarm the test.** A fixture may be
   *deliberately* wrong to exercise a legacy or negative path. On this branch a `ruleId` →
   `rule` rename gave a fixture a `source` field, which made `migrateSemanticVerdict` skip
   its migration branch — the suite stayed green and only the coverage ratchet caught it
   (`reviewFindingToFinding` fell to 0%). **Before changing a fixture, grep the code under
   test for how it branches on that field.**

2. **`bun run check:all` does NOT include the coverage ratchet.** `test:coverage` is a
   separate script. In CI it is a step inside the single `test` job, so a green `check:all`
   locally proves nothing about coverage. Run it separately, every time.

3. **Never insert a line after a single-line object literal.** Inserting
   `estimatedCostUsd: 0,` after `return { output: "x", tokenUsage: {...} };` lands *outside*
   the braces and produces a parse error. **Tell:** the typecheck total collapses to a
   single digit (tsc aborts at the first parse error). If the count drops by hundreds,
   you broke a file — do not update the baseline, find the `error TS1109`.

4. **Never regex over a nested object literal.** A non-greedy pattern matches the inner
   `JSON.stringify({…})` brace and shreds the file. Same tell as trap 3.

5. **The compiler's error list is not the full edit set.** tsc reports a subset of
   positions. On this branch, patching only the flagged positions left 8 of 21 source
   strings unrenamed in one file — it still typechecked, but the test's set-identity logic
   broke and two tests failed. After a rename, grep the file for the old token and expect
   **zero** hits.

6. **Count errors by the property message, not by neighbouring file lines.** A `TS2741`
   puts `Property 'X' is missing` on the error's *head* line; a `TS2322` nests it two lines
   below. So `grep -B2 "Property 'X' is missing" | <file>` mixes in the file names of
   unrelated adjacent errors. The reliable count is
   `grep -c "Property 'X' is missing"`, and for the per-file split, attribute each match to
   the nearest preceding line matching `^<file>(<line>,<col>): error TS`. **This trap fired
   on the first draft of this very handoff** — it reported one cluster as 4 files with a
   9/2/2/2 split when the truth was 5 files at 8/1/1/1/1, and omitted a file entirely.

7. **A grep-based negative is not proof.** A `\b` word boundary silently fails on a quoted
   key (`"on-story-complete"`); a plain substring over-matches (`getAll` "hits"
   `getAllAgents`). Use two independent greps before concluding something is unused.
   **Fired again in `666b9e0a7`:** `grep -c "mock("` returned 0, so `mock` was dropped from
   an import — but the file used it as `mock.restore()`, and 14 tests died with
   `ReferenceError: mock is not defined`. When checking whether an identifier is unused,
   search the bare name, not a name plus a following character.

8. **`check:file-sizes` rejects line-adding fixes to grandfathered files.**
   `story-orchestrator.test.ts` is capped at 2006 lines; fixes there must be line-neutral.
   Neither cluster in §2 touches it, but the gate will tell you if that changes.

9. **Do not widen a `src/` type to fit a fixture.** If the fixture cannot satisfy the type,
   the fixture is wrong, or the work is out of scope. Never make a required field optional
   to clear an error.

10. **Do not fix anything with `: any`, `as any`, or `@ts-expect-error`.** The `anyType`,
   `asAny`, and `tsSuppress` counters exist precisely to make that impossible to land
   quietly, and they are checked on every commit.

---

## 6. Escalation — stop and ask when

- Supplying the field requires **inventing a value** whose correctness you cannot derive
  from the schema default, the surrounding fixture, or the assertion. (On this branch, the
  `makeFinding` factory was an approved escalation, not an improvised one.)
- The unmask exceeds ~2 sites with no existing factory to supply them.
- A test fails after your change and the fix is not obviously in your own edit.
- Any counter in §3 would rise.
- The change would touch `src/`.

Escalating costs nothing. Guessing a value that makes a test green while asserting nothing
is the failure mode this whole issue exists to prevent.

---

## 7. What is NOT in this handoff

The residue at `d83fff7f9` is **1369 errors**, and the overwhelming majority is design work,
not mechanical work. Recorded here so nobody mistakes the list for a queue:

| Cluster | Errors | Why it is not delegable |
|:--|--:|:--|
| `as unknown as`-shaped (TS2352) | 190 | Concentrated in 6 files (`parallel-batch` 31, `schemas` 21, `verify-op-normalized-findings` 15). Each needs a per-file seam design. |
| `ConfigSelector<Pick<…>>` variance | 32 | A generics/variance problem. The `callop-seam` phase is the precedent: prefer typing the seam monomorphically over containing a cast. |
| `CompleteOperation` vs `RunOperation` (`session`) | 15 | Looks like a missing field in the error text; it is actually a union-assignability failure. **Do not treat it as mechanical.** |
| Dead config keys (`defaultAgent`, `defaultTier`, `timeout`) | ~30 | Deletions need per-key judgement — see `HANDOFF-1514-dead-fixture-keys.md` for the method and the escalation bar. |

**The honest ratio: 91 of 1351 errors are mechanical.** The rest is engineering.

**Correction to an earlier draft of this handoff.** It claimed a fetch helper and a spawn
helper still had to be designed. Both already existed — `mockFetch`
(`test/helpers/mock-fetch.ts`, 8 files) and `makeSpawn` (`test/helpers/spawn.ts`, 58 files).
The fetch cluster has since been done (`666b9e0a7`): the helper's own cast was removed and
all 17 telegram sites migrated. The spawn cluster is Cluster C above. **Grep
`test/helpers/` for an existing helper before building one** — that draft nearly added a
duplicate `makeFetchMock` alongside `mockFetch`.

---

## 8. Doc map

| Doc | Holds |
|:--|:--|
| `PROPOSAL-1514-phase2-typecheck-drain.md` | root-cause analysis, per-phase status |
| `STATUS-1514-drain.md` | where the work stands, next actions |
| `HANDOFF-1514-dead-fixture-keys.md` | the deletion method + per-key verdicts (worked example) |
| `HANDOFF-1514-config-slices.md` | `makeConfigSlice` |
| `HANDOFF-1514-callop-seam.md` | monomorphic dep bags — the "fix the type, not the cast" precedent |
