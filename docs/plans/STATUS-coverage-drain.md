# Coverage drain - status

The live doc for draining `scripts/baselines/coverage-per-file-baseline.json` to empty.
Successor in style to `STATUS-test-debt-drain.md`: **section 0 is the live state and is
re-measured, never carried forward. Section 8 is an append-only log** - each entry records
what was true when written and is not edited afterwards.

Written for handover: every step below is executable without re-deriving the analysis.

---

## 0. Current state - re-measured 2026-08-30, after the UI-tier drain

Gate scope is `test/unit/` + `test/integration/` + `test/ui/` in one invocation.

| Reading | Value | Gate |
|:--|--:|:--|
| Aggregate line coverage | **94.52%** | floor 80%, passing |
| Aggregate function coverage | **90.59%** | floor 80%, passing |
| Files below the 80% per-file floor | **1** | ratchet, passing |
| Entries recorded in the baseline file | **1** | `src/prompts/loader.ts`, see section 7 |
| Coverage run wall clock | ~47s | was ~20s under the unit-only scope |

The baseline is down to a single entry, and that entry is not untested code - see section 7.
**There is no drain work left.** Sections 3-6 are history; section 1's tiers remain the
standard a reviewer holds a new test PR to.

`bun run test:coverage` runs the three suites with coverage, parses `coverage/lcov.info`,
and fails when a file not in the baseline sits below 80%, when a baselined file drops below
its recorded number, or when a baselined file is missing from the report entirely while
still on disk. There is no tiering: one flat 80% floor.

For the record, the states this doc has passed through: 2026-08-30 at `36e20f266` (before
P0) 88.58% lines / 94 files below floor / 103 baseline entries, unit-only scope; after P0,
91.34% / 62 / 63; after tranches T1-T6, 94.28% / 5 / 5.

---

## 1. The coverage rules

These are the standing rules for this repo. Per the 2026-08-30 decision they are
**documented, not gated** - the gate keeps a single flat 80% per-file floor, and these tiers
are the standard a reviewer holds a test PR to.

| Tier | Target | What it covers |
|:--|:--|:--|
| Overall | 80% or better | Aggregate line and function coverage. Enforced by `scripts/check-coverage.ts`. |
| Critical paths | 90% or better | Business logic that decides what runs: `src/execution/`, `src/pipeline/`, `src/routing/`, `src/verification/`, `src/config/` (merge, path security, selectors). |
| Utility functions | 100% | Pure functions with no I/O: `src/utils/`, parsers under `src/review/*-parsing/`, `src/prd/types.ts`. A pure function with an untested branch is an untested branch, not an integration gap. |
| UI components | 80% or better | `src/tui/**`. **Revised 2026-08-30** - the old rule said below 80% was acceptable here. It was wrong: the four grandfathered files' uncovered lines were event handlers, a keyboard-action dispatcher and two pure formatters, not rendering, and a sibling hook (`usePipelineBusEvents.ts`) already sat at 89.7% on the same `ink-testing-library` + `act()` harness. All four now clear the floor. Genuine render-only churn can still be argued, but it needs its own row in section 7. |

Where these get written down: append a "Coverage tiers" subsection to
`.nax/rules/testing-commands.md` under the existing `## Coverage` heading. That file is the
canonical store; `.claude/rules/testing-commands.md` is generated.

**Traps when editing rules:** no emoji of any kind in `.nax/rules/*.md` (including a
variation-selector `warning sign`) - it breaks the canonical loader. Run `nax rules lint`
before **and** after `nax generate`, then `bun run check:rules-drift`.

---

## 2. Scope decision - the gate measures unit + integration + ui

**Landed.** Kept for the evidence, since it is what justifies the 103 -> 63 baseline drop.

The gate used to instrument `test/unit/` alone. That is why files like
`src/execution/runner.ts` scored 42% in the gate while `test/integration/` covered them
thoroughly.

**Probed on 2026-08-30 and it works.** One invocation:

```
AGENT=1 timeout 600 bun test test/unit/ test/integration/ test/ui/ \
  --coverage --coverage-reporter=lcov --timeout=60000
```

Result: **15,814 tests, 0 fail, 51.3s, exit 0**, and a single merged `coverage/lcov.info`.
The historical comment in `check-coverage.ts` saying Bun "cannot merge coverage across the
separate process-group invocations the wrapper uses" is true of `scripts/run-tests.ts`
phases; it is not true of one invocation given all three directories.

What the merge buys, before a single test is written:

- aggregate lines 88.58% -> **91.59%**
- files below floor 94 -> **62**
- **37 files leave the below-floor list for free** (for example `src/execution/runner.ts`
  42.2 -> 100.0, `src/plugins/loader.ts` 38.2 -> 94.8, `src/cli/plugins.ts` 3.4 -> 100.0,
  `src/tui/hooks/useLayout.ts` 20.0 -> 84.8)
- **5 files newly appear** because the ui suite instruments `.tsx` the unit suite never
  loads: `src/tui/App.tsx` 78.3, `src/tui/hooks/usePipelineEvents.ts` 61.5,
  `src/tui/hooks/useKeyboard.ts` 57.7, `src/tui/hooks/useAgentStreamEvents.ts` 17.9,
  `src/execution/lifecycle/precheck-runner.ts` 53.6

Cost: the CI "Coverage floor" step goes from about 20s to about 55s, and it now re-runs work
CI already did in three earlier steps. That is the price of measuring the truth.

---

## 3. P0 - do these before writing any test

### 3.1 The vanishing-file defect - GitHub #1779, GUARDED

**Done.** Kept here because it explains a permanent entry in the gate and a permanent
caveat on every number below.

`src/prompts/loader.ts` is recorded in the 2026-08-24 baseline at 77.27% and appears in
neither the unit-only nor the merged lcov - not at 0%, but absent, with no `SF:` record at
all. Its 16 tests pass in both runs and the module is imported for value, not as a type.

What the investigation established:

- **Not a race.** Three consecutive merged runs instrumented an identical set of 836 `src/`
  files - union equals intersection, zero drift. The omission is deterministic.
- **Not scale.** It survives a 747-file run and is dropped from a 675-file one.
- **Not `smol`.** Setting `smol = false` in `bunfig.toml` changes nothing.
- **It is an interaction between test files.** Bisected to a two-file reproduction:

  ```
  bun test test/unit/prompts/loader.test.ts \
           test/unit/execution/mutation-check-wiring.test.ts \
           --coverage --coverage-reporter=lcov
  # 29 pass, 0 fail - and no SF: record for src/prompts/loader.ts
  ```

  Pair `loader.test.ts` with any other test file tried and the record is present.

- **Blast radius today is exactly one file.** 73 `src/` files are absent from the full
  report; 34 of those are imported by some test, and all but `src/prompts/loader.ts` are
  imported with `import type`, which erases at runtime and so is legitimately absent.

The root cause is inside Bun's coverage recording and is not fixed here. What is fixed is
that the omission can no longer pass silently:

- `findMissingBaselined()` fails the gate on any baselined file absent from the report while
  still present on disk.
- `buildUpdatedBaseline()` carries such an entry forward at its recorded number instead of
  dropping it, so `--update-baseline` can no longer delete debt it merely failed to see.
- `UNMEASURABLE` in `scripts/check-coverage.ts` holds the one known instance with its reason
  and issue link. Every other absence fails. Verified end to end: emptying that map makes
  `bun run test:coverage` exit 1 naming `src/prompts/loader.ts` at its 77.27% baseline.

**The caveat this leaves.** `src/prompts/loader.ts` is not measured by the gate at all. It
is not drained and its entry must stay. If #1779 is ever fixed upstream, remove the
`UNMEASURABLE` entry and let the ratchet pick the file back up.

### 3.2 Widen the gate scope - DONE

`runCoverage()` now spawns `bun test` over `GATED_SUITES` = `test/unit/`,
`test/integration/`, `test/ui/`. The header's "Scope:" paragraph and the CI step's comment
were rewritten - the old claim that the suites "cannot be merged" and "add little source
coverage over the unit suite" was measurably false. `RUN_TIMEOUT_MS` stays at 300,000; a
merged run takes 38-55s.

**Trap for anyone editing `.nax/rules/`.** `nax generate` writes `CLAUDE.md`, `AGENTS.md`,
`codex.md` and `GEMINI.md`, but it does **not** sync `.claude/rules/` - that needs
`nax rules export --agent=claude`, and `bun run check:rules-drift` is what catches the
omission. Full sequence:

```
nax rules lint            # before
# edit .nax/rules/*.md
nax generate
nax rules export --agent=claude
bun run check:rules-drift
nax rules lint            # after
```

### 3.3 Re-baseline once, against the new scope - DONE

```
bun run test:coverage:update
bun run test:coverage        # exit 0
```

103 entries -> **63**, and the run reported one carried-forward entry:

```
[coverage] per-file baseline updated: 63 files below the 80% floor.
[coverage] 1 entry carried forward - the file exists but the report omitted it
(GitHub #1779), so its number is kept rather than dropped:
  src/prompts/loader.ts
```

That line is the 3.1 guard doing its job on its first real use. Without it the baseline
would read 62 and `src/prompts/loader.ts` would have been silently deleted at 77.27%.

63 = the 62 real targets in section 4, plus that one carried entry.

### 3.4 The structural blind spot - recorded, no code change

The ratchet can only see a file some test imports, so **an empty baseline will not mean
every `src/` file meets 80%.** This is now written into `.nax/rules/testing-commands.md`
so the finished state is not oversold.

Measured honestly, the hole is much smaller than this doc first claimed. 73 `src/` files
have no record in the report:

| Group | Count | Verdict |
|:--|--:|:--|
| Imported by a test with `import type` only | 33 | legitimate - type imports erase at runtime, there is nothing to instrument |
| Imported by a test for value, still absent | 1 | `src/prompts/loader.ts` - the #1779 defect, see 3.1 |
| Referenced by no test, type-only modules | 30 | legitimate - no runtime code |
| Referenced by no test, with runtime exports | **9** | the real hole, about **892 LOC** |

The nine: `src/commands/detect.ts` (279), `src/constitution/generator.ts` (158),
`src/execution/lifecycle/story-size-prompts.ts` (123), the five
`src/acceptance/templates/*.ts` (294 together), and `src/tui/index.tsx` (38).

An earlier revision of this doc put this at "30 non-type files, about 2,240 LOC". That was
an over-count: it swept in type-only modules and `src/prompts/loader.ts`, which is loaded,
merely unrecorded. Out of scope for this drain either way - worth its own issue.

---

## 4. Tranches

62 files, about 9,190 src LOC, grouped by cost. **One PR per tranche.** Ordered so the
cheapest coverage lands first and the instrument is exercised early.

These are the 62 real targets. The baseline holds 63 entries - the extra is
`src/prompts/loader.ts`, which is unmeasurable rather than untested (3.1) and is not a
tranche member.

### T1 - Last mile: 70-80 per cent (21 files, 3141 src LOC)

21 files that need a handful of branch cases each. Highest coverage-per-token in the whole drain. Do this first.

| merged now | LOC | file |
|--:|--:|:--|
| 79.2% | 120 | `src/routing/strategies/llm-parsing.ts` |
| 78.6% | 263 | `src/operations/finish-narrative.ts` |
| 78.6% | 21 | `src/utils/feature-name.ts` |
| 78.3% | 369 | `src/tui/App.tsx` - exempt, see section 7 |
| 78.1% | 285 | `src/test-runners/resolver.ts` |
| 77.6% | 236 | `src/execution/parallel-worker.ts` |
| 77.1% | 52 | `src/review/typecheck-parsing/parse.ts` |
| 76.7% | 64 | `src/debate/pre-phase/grounder.ts` |
| 76.7% | 101 | `src/operations/debate-plan.ts` |
| 76.5% | 60 | `src/routing/strategies/llm-cache.ts` |
| 75.0% | 8 | `src/cli/setup-llm.ts` |
| 74.3% | 67 | `src/errors.ts` |
| 72.9% | 434 | `src/cli/init.ts` |
| 72.0% | 264 | `src/utils/porcelain.ts` |
| 71.9% | 66 | `src/forge/deps.ts` |
| 71.6% | 140 | `src/execution/crash-heartbeat.ts` |
| 71.4% | 70 | `src/plan/strategies/write-prd.ts` |
| 71.4% | 16 | `src/review/categorization.ts` |
| 70.8% | 104 | `src/cli/plan-runtime.ts` |
| 70.2% | 193 | `src/commands/replay.ts` |
| 70.0% | 208 | `src/interaction/plugins/webhook-serve-compat.ts` |

### T2 - 60-70 per cent (7 files, 1488 src LOC)

Uncovered error paths and one or two whole helpers per file.

| merged now | LOC | file |
|--:|--:|:--|
| 69.1% | 112 | `src/cli/setup.ts` |
| 68.0% | 598 | `src/execution/post-run.ts` |
| 66.5% | 292 | `src/execution/story-context/index.ts` |
| 66.2% | 150 | `src/context/engine/manifest-purge.ts` |
| 64.2% | 178 | `src/cli/status-dispatch.ts` |
| 62.3% | 103 | `src/test-runners/detect/framework-configs-python.ts` |
| 61.5% | 55 | `src/tui/hooks/usePipelineEvents.ts` - exempt, see section 7 |

### T3 - 50-60 per cent (10 files, 1467 src LOC)

Roughly half the file is untested. Expect a real test file per source file, not an extension of one.

| merged now | LOC | file |
|--:|--:|:--|
| 58.8% | 75 | `src/cli/plan-helpers.ts` |
| 57.8% | 210 | `src/test-runners/detect/workspace.ts` |
| 57.7% | 165 | `src/tui/hooks/useKeyboard.ts` - exempt, see section 7 |
| 55.8% | 61 | `src/utils/command-argv.ts` |
| 55.6% | 99 | `src/routing/strategies/llm.ts` |
| 53.6% | 142 | `src/execution/lifecycle/precheck-runner.ts` |
| 53.3% | 150 | `src/execution/escalation/tier-outcome.ts` |
| 51.7% | 65 | `src/pipeline/stages/constitution.ts` |
| 51.5% | 234 | `src/commands/resume.ts` |
| 50.3% | 266 | `src/cli/generate.ts` |

### T4 - 30-50 per cent (10 files, 1627 src LOC)

Parsers, validators and config plumbing. Mostly pure logic, so table-driven tests apply well.

| merged now | LOC | file |
|--:|--:|:--|
| 49.7% | 283 | `src/context/injector.ts` |
| 48.2% | 151 | `src/verification/runners.ts` |
| 45.8% | 61 | `src/debate/utils.ts` |
| 45.8% | 299 | `src/commands/migrate.ts` |
| 40.7% | 347 | `src/interaction/plugins/cli.ts` |
| 37.5% | 69 | `src/agents/shared/validation.ts` |
| 34.6% | 188 | `src/debate/runner-stateful-helpers.ts` |
| 34.0% | 81 | `src/review/lint-parsing/strategies/ruff-annotated.ts` |
| 32.5% | 74 | `src/review/lint-parsing/strategies/eslint-json.ts` |
| 31.0% | 74 | `src/interaction/bridge-builder.ts` |

### T5 - 10-30 per cent (7 files, 1065 src LOC)

Largely untested modules. Read the module first and decide whether the untested part is dead code before writing a test for it.

| merged now | LOC | file |
|--:|--:|:--|
| 28.2% | 204 | `src/cli/prompts-main.ts` |
| 26.2% | 315 | `src/execution/iteration-runner.ts` |
| 25.0% | 29 | `src/utils/nax-project-root.ts` |
| 17.9% | 162 | `src/tui/hooks/useAgentStreamEvents.ts` - exempt, see section 7 |
| 17.6% | 225 | `src/cli/status-cost.ts` |
| 13.9% | 93 | `src/review/typecheck-parsing/strategies/text-block.ts` |
| 10.7% | 37 | `src/agents/acp/adapter-close-physical.ts` |

### T6 - 0-10 per cent (7 files, 398 src LOC)

Thin shells and prompt-section builders. Several are pure string or JSON producers that snapshot cleanly; check first whether the module is reachable at all.

| merged now | LOC | file |
|--:|--:|:--|
| 9.5% | 35 | `src/cli/setup-verify.ts` |
| 9.5% | 111 | `src/cli/accept.ts` |
| 4.4% | 88 | `src/cli/prompts-tdd.ts` |
| 0.0% | 41 | `src/acceptance/content-loader.ts` |
| 0.0% | 70 | `src/cli/prompts-shared.ts` |
| 0.0% | 29 | `src/prompts/core/sections/findings.ts` |
| 0.0% | 24 | `src/utils/jsonl-tail.ts` |

---

## 5. Per-tranche protocol

Run this exactly, for every tranche.

1. **Branch.** `git checkout -b test/coverage-drain-T<n>` off `main` (not master).
2. **Measure the starting point.** `bun run test:coverage:list > /tmp/before.txt`.
3. **For each file in the tranche:**
   - Read the source module in full before writing anything. A truncated read becomes a
     shipped defect.
   - Find the uncovered lines: the `DA:<line>,0` records for that file's `SF:` block in
     `coverage/lcov.info` are the exact untested lines.
   - Place the test at `test/unit/<mirror-of-src>/<name>.test.ts`. Tests mirror `src/`
     exactly. Never create a test outside `test/unit`, `test/integration`, `test/ui`,
     `test/e2e` - `bun run test` walks only those and a stray file silently never runs.
   - Extend the existing test file when there is one. Never create a bug-numbered or
     concern-suffixed twin unless the file would exceed 400 lines, and then split by
     describe block.
   - Import through the barrel (`@/config`) where the symbol is exported from it; reach for
     `@/config/compat-shims` style internals only when it is not. `@test/<dir>/<internal>`
     is forbidden - shared helpers come from `@test/helpers`.
   - Mock through the module's exported `_deps` object, never by mutating `Bun.spawn`
     globally. `docs/architecture/conventions.md` section 2 has the full table.
   - Temp dirs come from `makeTempDir()` / `withTempDir()` in `test/helpers/temp.ts`. Never
     `mkdtempSync` directly.
4. **Verify locally, in this order:**
   ```
   bun run typecheck
   bun run lint
   bun run check:all
   bun run test
   bun run test:coverage
   ```
5. **Shrink the baseline by exactly this tranche.** Run `bun run test:coverage:update`, then
   **`git diff` the baseline** and confirm the only removed keys are this tranche's files.
   Any other key moving is a bug in the tranche - or the vanishing-file defect from 3.1.
6. **One commit, one PR.** `test(coverage): drain T<n> - <subsystem> (<n> files)`. The PR
   body lists each file with its before and after percentage.

**Definition of done for a tranche:** every file in it is at or above 80% in the merged
report, its baseline entries are gone, and all five gates in step 4 are green.

---

## 6. Guardrails - what makes a drain PR a failed change

The ratchet is easy to satisfy dishonestly. These are rejections, not style notes.

- **Never lower a floor or widen an exemption to go green.** `PER_FILE_FLOOR` stays 0.8.
- **Never re-run `--update-baseline` to record a file at a *worse* number.** The command
  exists to remove drained files, not to absorb regressions. If a number went down,
  something broke - find it.
- **Never delete or skip a failing test to move a percentage.** Never `describe.skip` an
  existing test.
- **Never delete source code to raise a percentage** unless the deletion is the actual point
  and is argued in the PR body on its own merits.
- **A test that asserts nothing does not count.** No `expect(true).toBe(true)`, no test whose
  only assertion is that a call did not throw when the function's contract says more.
- **Assert outcomes, not internal call shapes.** A test that only checks "the mock was called
  with these arguments" pins the implementation and will be deleted at the next refactor.
- **The escape-hatch ratchets are at their floors and must not move.** `as unknown as` is
  baselined at **0** and any nonzero reading is a regression to fix at the site.
  `tsSuppress` is **0**. `ratchetAllow` is **25** and that is its floor. Clearing a typecheck
  error by raising `looseCast` is a failed change, not partial progress. The counters are a
  closed system: no change may trade one against another. Note the ratchet regexes match
  inside comments, so even a comment mentioning a cast can trip them.
- **The file-size gate refuses any growth over the limit.** `SRC_LIMIT` 600, `TEST_LIMIT`
  800. Biome's re-wrap can make a "shorter" edit longer, so run `wc -l` before sizing an
  edit and budget a split up front rather than discovering it at the gate.
- **`bun run check:test-mocks` (`--strict`) rejects inline mocks** that belong in a helper.
- **Every gate must pass on the tree you are committing.** If work was split across agents or
  worktrees, each one gated only its own tree state - re-run the gates yourself on the union
  before committing.

---

## 7. Files that stay in the baseline, with a reason

Do not spend tokens on these; record them here instead, and keep the ratchet holding their
current number so they cannot get worse.

| File | Now | Why it stays |
|:--|--:|:--|
| `src/prompts/loader.ts` | 77.27% | Not untested: **100% under `FULL=1`**. The only uncovered lines are its `catch` (the unreadable-file path), reached solely by the two `fullTest`-gated tests in `test/unit/prompts/loader.test.ts`, which chmod a file to `0o000`. The coverage gate does not set `FULL=1`, so those lines never execute under it. Leave the entry: un-gating them would break any environment that runs the suite as root, where `chmod 0o000` does not deny the owner. |

### Retired exemptions

The four `src/tui/**` rows that stood here until 2026-08-30 are gone - drained, not excused.
See log entry 8.4. The reasoning that put them here ("UI tier, verified by eye") did not
survive reading the uncovered lines.

---

## 8. Log

Append one entry per landed PR. Do not edit earlier entries.

### 8.0 - 2026-08-30 - analysis, before any change

Measured at `36e20f266`. Aggregate 88.58% lines / 87.92% functions under the unit-only gate;
94 files below the per-file floor against 103 baseline entries. Probed the merged scope: one
`bun test test/unit/ test/integration/ test/ui/ --coverage` invocation, 15,814 tests, 0 fail,
51.3s, exit 0, aggregate 91.59% lines, 62 files below floor. Found the vanishing-file defect
in 3.1 while reconciling the two reports, filed as #1779. No code changed.

### 8.1 - 2026-08-30 - the #1779 guard

Root-caused the vanishing file to a deterministic interaction between test files, not a race
(3 identical runs), not scale (survives 747, dropped at 675), not `smol`. Minimal repro is
two test files. Blast radius today is exactly one file - the other 33 test-imported absentees
are all `import type`. Added `findMissingBaselined()` and `buildUpdatedBaseline()` to
`scripts/check-coverage.ts` with an `UNMEASURABLE` map holding the one known instance, plus
`test/unit/scripts/check-coverage.test.ts`. Proved the guard fires by emptying the map and
watching the gate exit 1 naming the file. All five gates green.

### 8.2 - 2026-08-30 - P0 complete

Widened the gate to `test/unit/` + `test/integration/` + `test/ui/` in one invocation and
re-baselined against it. 103 entries -> 63; aggregate 88.58% -> **91.34%** lines, 87.92% ->
**88.66%** functions; files below the per-file floor 94 -> **62**. No test was written for
any of it - the change is of instrument, not of coverage. Coverage run went from ~20s to
~38-55s, and the CI step's comment now says why it cannot reuse the three suite steps above
it.

The 3.1 guard paid for itself on first real use: `--update-baseline` reported one entry
carried forward (`src/prompts/loader.ts` at 77.27%) instead of deleting it, which is exactly
the silent deletion the old code would have performed.

Corrected 3.4 while re-measuring: the structural blind spot is **9 files / 892 LOC**, not the
30 files / 2,240 LOC an earlier revision claimed. The old figure swept in type-only modules
and `loader.ts`.

Also learned: `nax generate` does not sync `.claude/rules/` - that needs
`nax rules export --agent=claude`, and `bun run check:rules-drift` is what catches it.

All five gates green. Tranche T1 is now unblocked.

### 8.3 - 2026-08-30 - drain complete, T1-T6

All six tranches landed as six commits on `test/coverage-drain-T1`, off `main`:
`0c43a0d26` (T1, 20 files), `dc7888846` (T2, 6 files), `cbd6b157e` (T3, 9 files),
`bc79369dc` (T4, 10 files), `d237d379b` (T5, 6 files), `bd6df76f5` (T6, 6 files).
57 of the 62 real targets needed dedicated work; 5 (`src/pipeline/stages/constitution.ts`,
`src/cli/status-cost.ts`, `src/review/typecheck-parsing/strategies/text-block.ts`,
`src/cli/prompts-shared.ts`, plus one more) crossed the floor for free as incidental
side effects of earlier tranches exercising shared code paths, and needed no new tests
by the time their tranche started.

Final state, verified independently after all six tranches: `bun run test:coverage` exits
0, aggregate **94.28%** lines / **90.49%** functions, and the per-file baseline holds
exactly **5 entries** - all of them the documented permanent exemptions, none a drain
target:

```json
{
  "src/prompts/loader.ts": 0.7727,
  "src/tui/App.tsx": 0.7833,
  "src/tui/hooks/useAgentStreamEvents.ts": 0.1789,
  "src/tui/hooks/useKeyboard.ts": 0.5769,
  "src/tui/hooks/usePipelineEvents.ts": 0.6154
}
```

`src/prompts/loader.ts` is the #1779 unmeasurable carry-forward (3.1) - not drained, not
draggable, kept until the upstream Bun defect is fixed. The four `src/tui/**` entries are
the UI-tier grandfathered files from section 7. Every other file in section 4's original
62-file list is now at or above the 80% per-file floor.

One correctness finding surfaced along the way, documented rather than fixed as out of
scope for a coverage-only drain: `acceptCommand()` in `src/cli/accept.ts` passes
`findProjectDir()`'s result (already the `.nax` directory) into `featureDir()`, which
appends `.nax` again, producing a real path of `<root>/.nax/.nax/features/<feature>/prd.json`.
Pinned as current behavior in `accept.test.ts`; worth its own issue.

Each tranche's own commit body has the full before/after percentage table per file. This
doc's job (draining the baseline to empty) is done; the tiering standard in section 1
remains the living reference for what a reviewer holds new test PRs to.

### 8.4 - 2026-08-30 - the UI tier drained, and the exemption refuted

The five entries 8.3 signed off as "documented permanent exemptions" were not all permanent.
Four of them were `src/tui/**`, exempted under section 1's UI tier on the grounds that TUI
rendering is verified behaviourally and by eye. Reading the uncovered lines refuted that:

| File | Uncovered lines were | Before | After |
|:--|:--|--:|--:|
| `src/tui/hooks/useAgentStreamEvents.ts` | the whole stream-event `switch` and the 150ms drain effect | 17.89% | **100.00%** |
| `src/tui/hooks/usePipelineEvents.ts` | both `stage:enter` / `stage:exit` handler bodies | 61.54% | **100.00%** |
| `src/tui/hooks/useKeyboard.ts` | the character-shortcut branches, the Ctrl guard, `disabled` | 57.69% | **98.08%** |
| `src/tui/App.tsx` | `dispatchKeyboardAction`, the confirm-dialog handler, `formatTokens` | 78.33% | **99.17%** |

None of that is rendering. `formatTokens` is a pure function, which section 1's own rules put
at 100%, not exempt. The decisive evidence was already in the tree: `usePipelineBusEvents.ts`
- a sibling hook of the same shape, in the same directory - has sat at 89.7% since it was
written, covered by one `test/ui/*.test.tsx` on the `ink-testing-library` + `act()` harness.
The pattern was proven; the exemption was habit.

Four new test files, 59 tests, no production code changed:
`test/ui/usePipelineEvents.test.tsx`, `test/ui/useKeyboard.test.tsx`,
`test/ui/useAgentStreamEvents.test.tsx`, `test/ui/tui-keyboard-actions.test.tsx`.

Aggregate 94.28% -> **94.52%** lines, 90.49% -> **90.59%** functions. Baseline **5 -> 1**.

**Two defects surfaced, both pinned rather than fixed:**

1. **The Agent panel has no working way out.** `useKeyboard`'s escape hatch tests
   `key.ctrl && input === "]"`, but Ink reports a real Ctrl+] (0x1d) as input `"\x1d"` with
   `key.ctrl === false` - it only synthesises `ctrl` for codes 1-26, and `]` is 29. So
   `ESCAPE_AGENT` is unreachable from the keyboard, and once focus moves to the Agent panel
   every shortcut is ignored with no way back. Probed directly against Ink, then asserted as
   observed behaviour in `useKeyboard.test.tsx`. This is also the entire reason the two files
   stop short of 100%: `useKeyboard.ts:104` and `App.tsx:146-147` are the dead binding and
   the `ESCAPE_AGENT` case it can never reach. Fix is one condition; it wants its own issue
   and its own test flip.

2. **A floating assertion in an existing test.** `test/unit/prompts/loader.test.ts:205` has
   `expect(loadOverride(...)).rejects.toThrow()` with no `await` - the assertion never runs.
   It is `fullTest`-gated so CI never executes it either way.

**And one stale claim corrected.** 8.3 recorded `src/prompts/loader.ts` as the #1779
unmeasurable carry-forward - "not drained, not draggable". Both halves are now wrong:

- Under **Bun 1.4.0** (the baseline in 8.3 was measured on 1.3.13) the file *does* get an
  `SF:` record in the gated run, at exactly its recorded 77.27%. The `UNMEASURABLE` entry in
  `scripts/check-coverage.ts` is therefore inert, and while it stands a genuine future
  disappearance would pass silently. The underlying Bun defect is NOT fixed - the two-file
  repro from 3.1 still produces no record on 1.4.0 - so removing the entry trades a silent
  hole for a loud, possibly surprising, CI failure. Left in place, flagged here.
- The 77.27% was never the defect's doing. The file is **100% under `FULL=1`**; its only
  uncovered lines are the `catch` block, reached solely by the two `fullTest`-gated tests
  that chmod a file to `0o000`. Recorded properly in section 7.
