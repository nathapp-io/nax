# Coverage drain - status

The live doc for draining `scripts/baselines/coverage-per-file-baseline.json` to empty.
Successor in style to `STATUS-test-debt-drain.md`: **section 0 is the live state and is
re-measured, never carried forward. Section 8 is an append-only log** - each entry records
what was true when written and is not edited afterwards.

Written for handover: every step below is executable without re-deriving the analysis.

---

## 0. Current state - measured 2026-08-30 at `36e20f266`

| Reading | Value | Gate |
|:--|--:|:--|
| Aggregate line coverage (`test/unit` only, today's gate scope) | **88.58%** | floor 80%, passing |
| Aggregate function coverage (`test/unit` only) | **87.92%** | floor 80%, passing |
| Files below the 80% per-file floor (`test/unit` only) | **94** | ratchet, passing |
| Entries recorded in the baseline file | 103 | 8 genuinely stale, 1 anomaly - see 3.1 |
| Aggregate line coverage (unit + integration + ui, measured) | **91.59%** | - |
| Files below the 80% per-file floor (unit + integration + ui) | **62** | - |

The aggregate 80% rule is already met and is not the work. **The work is the per-file
ratchet.**

`bun run test:coverage` re-runs `test/unit/` (about 20s), parses `coverage/lcov.info`, and
fails when a file not in the baseline sits below 80%, or a baselined file drops below its
recorded number. There is no tiering: one flat 80% floor.

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
| UI components | Below 80% is acceptable | `src/tui/**`. TUI rendering is verified by `test/ui/` behaviour tests and by eye; chasing line coverage there buys snapshot brittleness. These files stay grandfathered in the baseline with a reason (section 7). |

Where these get written down: append a "Coverage tiers" subsection to
`.nax/rules/testing-commands.md` under the existing `## Coverage` heading. That file is the
canonical store; `.claude/rules/testing-commands.md` is generated.

**Traps when editing rules:** no emoji of any kind in `.nax/rules/*.md` (including a
variation-selector `warning sign`) - it breaks the canonical loader. Run `nax rules lint`
before **and** after `nax generate`, then `bun run check:rules-drift`.

---

## 2. Scope decision - the gate should measure unit + integration + ui

Today the gate instruments `test/unit/` alone. That is why files like
`src/execution/runner.ts` score 42% in the gate while `test/integration/` covers them
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

### 3.2 Widen the gate scope

In `scripts/check-coverage.ts`, `runCoverage()` currently spawns `bun test test/unit/`.
Change the argument list to `test/unit/`, `test/integration/`, `test/ui/`. Update the
"Scope:" paragraph in the file header - the claim that the suites "cannot be merged" and
"add little source coverage over the unit suite" is now measurably false (37 files). Update
the `## Coverage` section of `.nax/rules/testing-commands.md` to match, then `nax generate`.

`RUN_TIMEOUT_MS` at 300,000 is still ample for a 55s run; leave it.

### 3.3 Re-baseline once, against the new scope

```
bun run test:coverage:update    # 103 entries -> 62
bun run test:coverage           # must exit 0
```

Commit 3.2 and 3.3 together as one PR: `test(coverage): measure the ratchet across unit,
integration and ui`. This PR writes **no tests** and its diff is one script, one rules file,
one baseline. That makes the 103 -> 62 drop reviewable as what it is - a change of
instrument, not progress.

### 3.4 Record the structural blind spot (no code change)

30 non-type `src/` files, about 2,240 LOC, are loaded by **no suite at all** and so are
invisible to the per-file ratchet - it can only see files some test imports. The largest are
`src/plugins/extensions.ts` (473), `src/commands/detect.ts` (279),
`src/execution/lifecycle/story-size-prompts.ts` (123),
`src/constitution/generator.ts` (158), `src/agents/shared/types-extended.ts` (162).

Draining the baseline to empty does **not** mean every file meets 80%. Note this in the
rules text so the finished state is not oversold, and file a follow-up issue. It is out of
scope for this drain.

---

## 4. Tranches

62 files, about 9,190 src LOC, grouped by cost. **One PR per tranche.** Ordered so the
cheapest coverage lands first and the instrument is exercised early.

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
| `src/tui/App.tsx` | 78.3% | UI tier. Covered behaviourally by `test/ui/`. |
| `src/tui/hooks/usePipelineEvents.ts` | 61.5% | UI tier. |
| `src/tui/hooks/useKeyboard.ts` | 57.7% | UI tier. |
| `src/tui/hooks/useAgentStreamEvents.ts` | 17.9% | UI tier, and the lowest of them - worth a look in T5 before accepting it. |

Every other file in section 4 is a real target. If a tranche turns up another genuine
exemption, add a row here with its reason in the same PR - an exemption without a written
reason rots into an excuse.

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
