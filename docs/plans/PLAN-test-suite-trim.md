# PLAN — Trim the Test Suite (10,168 → ~6,500–7,500)

**Author:** William
**Date:** 2026-05-21 (revised)
**Owner:** Hand-off plan — designed to be executed by a cheaper model (e.g. Haiku 4.5 or Sonnet 4.6) one phase at a time, sequentially.
**Status:** Ready to execute

---

## Background

Audited 2026-05-21:

- **768** `.test.ts` files
- **10,168** total `test(...)` / `it(...)` cases
- **203,122** lines of test code
- **Full suite runs in 30–40s** (`bun run test`). Speed is NOT the problem.
- Only **38** usages of `test.each(...)` — heavy parametric duplication is the dominant smell.
- Only **4** files use snapshots — not the problem.

**Why trim if it's already fast?** Maintenance burden: 10k tests means slow LLM context loading when reviewing failures, high duplication, hard to onboard. Goal is **clarity and maintainability**, not runtime.

**Realistic goal:** Reduce to **~6,500–7,500 tests** (25–35% reduction) **without losing branch coverage**.

**Non-goals:**
- Speed optimization (already fast).
- Test tiering (`fast`/`slow` split — not needed at 30s).
- Aggressive deletion of edge-case tests.

---

## Realistic Reduction Budget (from actual test counts)

| Phase | Target files | Current tests | Folded estimate | Saved |
|:---|:---|---:|---:|---:|
| 1 — Prompt builders (top 6) | 6 files | 346 | ~120 | **~226** |
| 2 — Config/schema (top 5) | 5 files | 270 | ~110 | **~160** |
| 3 — Pipeline/autofix (top 5) | 5 files | 176 | ~90 | **~86** |
| 4 — Debate/review/verification (top 7) | 7 files | 235 | ~120 | **~115** |
| 5 — Mid-tier sweep (next 80 files, 15–40 tests each) | ~80 files | ~2,000 | ~1,400 | **~600** |
| 6 — Cross-file duplicate hunt | repo-wide | — | — | **~300–800** |
| **Total** | — | — | — | **~1,500–2,000** |

Final target: **~8,000 tests**. Stretch target with aggressive Phase 5/6: **~6,500–7,500**.

**Honest disclosure:** the top-23 files only contain ~1,200 tests total. Cutting them in half saves ~600. The bulk of the 10k lives in long-tail files (15–40 tests each). Phase 5 (mid-tier sweep) is where the real volume reduction happens.

---

## Guiding Principles (re-read before every phase)

1. **Coverage first, count second.** Capture baseline (`bun test --coverage`). Per-file coverage must not drop more than **1 percentage point absolute** (tolerance for noise). Global coverage must not drop.
2. **One file per commit.** Atomic commits: `refactor(test): fold X via test.each`. Bisectable.
3. **One phase per branch.** Each phase → its own branch → its own PR. If a later phase breaks something, only that phase is reverted.
4. **Sequential, not parallel.** Cheaper models tend to parallelize naively; do not. Process files one at a time.
5. **Fold, don't delete, when in doubt.** Only delete when a test is provably redundant (see "Redundant test" definition below).
6. **Keep edge-case labels.** `test.each` rows must have descriptive labels — never `"case 1"`, `"case 2"`.
7. **Never touch integration/E2E happy paths.** Out of scope: `test/integration/`, `test/ui/`, `test/contracts/`.
8. **Project rules apply.** See `.claude/rules/forbidden-patterns.md` and `.claude/rules/testing-commands.md`. In particular: always use `timeout 30 bun test <file> --timeout=5000` — never bare `bun test`.

### Definition of "redundant test"

A test is redundant **only if all four hold**:

1. Same test target (same function/class under test).
2. Same setup (same mocks, same fixtures, same input shape).
3. Same assertion shape (asserts the same property of the output).
4. Diff between test bodies, normalized for whitespace + test name, is < 40 chars.

If only 1–3 hold but inputs differ, it's a **fold candidate** (`test.each`), not a delete candidate.

---

## Verification Cadence

### After EVERY commit (mechanical, ~10s):

```bash
bun run typecheck
timeout 30 bun test <touched-file> --timeout=5000
```

If either fails: **revert the commit**. No "fix forward" — this is mechanical refactor work.

### After EVERY 5 commits OR at phase boundary (heavier):

```bash
bun run lint
bun run test           # full suite, 30–40s
```

### Before opening the phase PR:

```bash
bun run lint
bun run test:bail
bun run scripts/test-trim-progress.ts   # see Phase 0
```

Coverage check (run once at phase boundary, NOT per-commit):

```bash
bun test --coverage 2>&1 | tee coverage-after-phase-N.txt
diff coverage-baseline.txt coverage-after-phase-N.txt
```

---

## Phase 0 — Baseline & Tooling (1 PR, 1–2 commits)

**Output:**
1. `docs/plans/PLAN-test-suite-trim.baseline.md` — captured counts.
2. `scripts/test-trim-progress.ts` — prints current vs baseline counts.
3. Tag the starting commit: `git tag trim-baseline`.

**Steps:**

1. Capture baseline counts:
   ```bash
   {
     echo "# Baseline — $(date -I)"
     echo
     echo "## Files"; find test -name "*.test.ts" | wc -l
     echo "## Tests"; grep -rE "^\s*(test|it)\(" test --include="*.test.ts" | wc -l
     echo "## Lines"; find test -name "*.test.ts" -exec cat {} + | wc -l
     echo "## Top 100 by test count"
     grep -crE "^\s*(test|it)\(" test --include="*.test.ts" | sort -t: -k2 -rn | head -100
   } > docs/plans/PLAN-test-suite-trim.baseline.md
   ```

2. Capture coverage baseline:
   ```bash
   bun test --coverage 2>&1 | tee coverage-baseline.txt
   ```
   Commit `coverage-baseline.txt` to the plan dir.

3. Write `scripts/test-trim-progress.ts`:
   - Counts files, tests, lines.
   - Diffs against `docs/plans/PLAN-test-suite-trim.baseline.md`.
   - Prints `files: 768 → 760 (−8)`, `tests: 10168 → 9412 (−756, −7.4%)`.
   - **Keep it simple:** ~50 lines, no external deps.

4. Tag: `git tag trim-baseline`.

**Exit criteria:** baseline files committed, tag in place, progress script runs and prints zero deltas.

---

## Phase 1 — Prompt Builder Consolidation (6 files, ~226 tests saved)

**Targets (verified counts):**

| File | Tests |
|:---|---:|
| `test/unit/prd/schema.test.ts` | 82 |
| `test/unit/prompts/builders/plan-builder.test.ts` | 75 |
| `test/unit/debate/prompt-builder.test.ts` | 71 |
| `test/unit/prompts/builders/rectifier-builder.test.ts` | 65 |
| `test/unit/prompts/builder.test.ts` | 52 |
| `test/unit/prompts/acceptance-builder.test.ts` | 44 |

### Required structural audit BEFORE editing each file

Spend ≤ 5 minutes per file doing this audit. Skip the file if audit fails.

1. Open the file.
2. List every `describe` block and the count of `test(...)` inside.
3. For each `describe`, ask:
   - **Is the setup identical** across all tests in this block? (Same fixtures, same mocks, no per-test `beforeEach` divergence.)
   - **Are the assertions the same shape?** (e.g. all `expect(out.x).toContain(y)` with only `y` varying.)
4. If YES to both → block is a fold candidate.
5. If NO → leave the block alone, move to the next describe.

**Skip rule:** if fewer than 2 fold-able blocks exist in a file, **skip the file** — log it in the phase results doc as "no consolidation opportunity".

### Bun `test.each` syntax — validate first

Bun supports `test.each` (already used in `test/unit/prompts/builders/acceptance-builder-helpers.test.ts`). Before mass-folding, write **one validating fold** in Phase 1's first file and run it. If it fails, stop and ask for help.

```typescript
// Validated pattern
test.each([
  ["Step 1 — understand", "Step 1 — understand"],
  ["Step 2 — analyze", "Step 2 — analyze"],
])("prompt taskContext contains %s", (_label, marker) => {
  const out = builder.build(input);
  expect(out.taskContext).toContain(marker);
});
```

### Per-file procedure

1. Run audit (above). Skip if no candidates.
2. Fold qualifying blocks into `test.each`. Keep all other tests as-is.
3. Run verification: `bun run typecheck && timeout 30 bun test <file> --timeout=5000`.
4. If green: `git commit -m "refactor(test): fold <file-basename> assertions via test.each"`.
5. If red: `git checkout -- <file>` and move on. Log in results doc.

**Exit criteria:**
- All 6 files audited.
- ≥ 3 files refactored (lower bound — audit may skip some).
- Test count drop ≥ 150 (lower bound — original estimate was 226).
- Per-file coverage delta ≤ 1pp absolute.

---

## Phase 2 — Config & Schema Consolidation (5 files, ~160 tests saved)

**Targets:**

| File | Tests |
|:---|---:|
| `test/unit/cli/init-detect.test.ts` | 60 |
| `test/unit/config/merge.test.ts` | 47 |
| `test/unit/project/detector.test.ts` | 44 |
| `test/unit/config/schemas.test.ts` | 37 |

(Note: `prd/schema.test.ts` was moved to Phase 1.)

**Fold patterns:**
- `merge.test.ts` — likely fold by precedence layer: `test.each([[layer, key, expected], ...])`.
- `detector.test.ts` / `init-detect.test.ts` — fold by `[fixturePath, expectedLang]`.
- `schemas.test.ts` — keep error-path tests standalone (different code path); fold only default-value tests.

Apply same audit + verification pattern as Phase 1.

**Exit criteria:** ≥ 100 tests saved. Coverage delta ≤ 1pp.

---

## Phase 3 — Pipeline Stages & Autofix (5 files, ~86 tests saved)

**Targets:**

| File | Tests |
|:---|---:|
| `test/unit/pipeline/stages/autofix-adversarial.test.ts` | 55 |
| `test/unit/findings/cycle.test.ts` | 40 |
| `test/unit/pipeline/stages/autofix-core.test.ts` | 33 |
| `test/unit/pipeline/stages/autofix-cycle.test.ts` | 29 |
| `test/unit/pipeline/stages/review.test.ts` | 19 |

**Be careful:** autofix tests often have unique mock setups (different agent responses, different stages). The 5-minute audit will likely reject many `describe` blocks. **Expect lower yield here than Phases 1–2.**

**Additional opportunity:** these files are all large in LINES (700–800), suggesting copy-pasted mock setup. Consider extracting shared helpers to `test/helpers/autofix-fixtures.ts` — but **only if it reduces lines by > 30% and does not change test count semantics**. Helper extraction does NOT count toward the test-reduction target; it's a maintainability bonus.

**Exit criteria:** ≥ 50 tests saved. No coverage regression.

---

## Phase 4 — Debate, Review, Verification (7 files, ~115 tests saved)

**Targets:**

| File | Tests |
|:---|---:|
| `test/unit/review/dialogue.test.ts` | 54 |
| `test/unit/verification/tdd-verdict.test.ts` | 40 |
| `test/unit/verification/smart-runner.test.ts` | 39 |
| `test/unit/prompts/sections/role-task.test.ts` | 39 |
| `test/unit/review/dialogue-re-review.test.ts` | 37 |
| `test/unit/debate/runner-plan.test.ts` | 26 |
| `test/unit/verification/rectification-loop.test.ts` | 20 |

Apply audit + fold pattern. `runner-plan.test.ts` and `rectification-loop.test.ts` are long by lines but have few tests — focus on helper extraction here, not folding.

**Exit criteria:** ≥ 70 tests saved.

---

## Phase 5 — Mid-Tier Sweep (~80 files, ~600 tests saved)

**This is the highest-volume phase.** The plan up to here only touches 23 files. The remaining ~700 files own the majority of tests.

**Target:** every file in `test/unit/` with **15–40 `test()` cases** (the "mid-tier"). These are the most likely to harbor parametric duplication that hasn't been folded yet.

**Procedure:**

1. Generate the mid-tier list:
   ```bash
   grep -crE "^\s*(test|it)\(" test/unit --include="*.test.ts" \
     | awk -F: '$2 >= 15 && $2 <= 40 {print $0}' \
     | sort -t: -k2 -rn > /tmp/midtier.txt
   wc -l /tmp/midtier.txt   # expect ~80–120 files
   ```

2. For each file in `/tmp/midtier.txt`:
   - Run the 5-minute structural audit (same as Phase 1).
   - If no fold candidate → mark "skipped" in results, move on.
   - If fold candidate → fold, verify, commit.

3. **Budget gate:** if after 20 files the cumulative saving is < 50 tests, **stop the phase** and re-plan. The mid-tier may not be as parametric as expected.

**Exit criteria:**
- All mid-tier files audited (or budget gate triggered).
- ≥ 300 tests saved (lower bound — original estimate 600).

---

## Phase 6 — Cross-File Duplicate Hunt (~300–800 tests saved)

**Goal:** find tests across DIFFERENT files that assert the same behavior.

**Concrete heuristic (no AST hashing required):**

1. Extract every test name + first assertion line:
   ```bash
   # Generates: <file>:<line>:<test-name>:<first-expect>
   grep -rE "^\s*(test|it)\(['\"]" test/unit --include="*.test.ts" \
     | head -10000 > /tmp/test-index.txt
   ```

2. Look for tests with **identical or near-identical names** across files:
   ```bash
   grep -hoE "test\(['\"]([^'\"]+)['\"]" test/unit -r --include="*.test.ts" \
     | sort | uniq -c | sort -rn | awk '$1 >= 3' \
     > /tmp/dup-names.txt
   ```
   Names appearing ≥ 3 times across files are inspection candidates.

3. For each candidate, manually open the files and check the "redundant test" definition (4 conditions in Guiding Principles).

4. When a duplicate is confirmed:
   - Keep the test in the file **closest to the source under test** (unit test of helper beats integration test of caller-of-helper).
   - Delete the other.
   - Commit: `refactor(test): remove duplicate <test-name>, kept in <file>`.

**Budget gate:** if after 30 candidates fewer than 10 are confirmed duplicates, stop — duplication is lower than expected.

**Exit criteria:**
- Top 50 duplicate-name candidates inspected.
- ≥ 100 tests removed (lower bound).
- No coverage regression.

---

## Phase 7 — Final Verification (1 PR, 1 commit)

1. Run `bun run scripts/test-trim-progress.ts` — confirm reduction.
2. Run `bun run lint`.
3. Run `bun run test:bail` end-to-end — must pass in < 60s.
4. Run `bun test --coverage`, diff vs `coverage-baseline.txt`:
   - Global coverage drop must be ≤ 0.5pp.
   - No source file may drop > 1pp.
5. Write `docs/plans/PLAN-test-suite-trim.results.md`:
   - Before/after counts (files, tests, lines, wall-clock time).
   - Per-phase savings.
   - Coverage delta per top-level `src/` directory.
   - List of files skipped per phase (with reason).
   - Open follow-ups (e.g. files that needed human review).

**Done condition:** all phases merged, full suite green, coverage within tolerance.

---

## Rollback Procedure

If a phase causes mysterious flakiness later:

1. Each phase ships as its own PR with a clear title. Identify the offending PR.
2. `git revert <merge-commit>` — phase reverts cleanly because phases are sequential, not interleaved.
3. Log the issue in `docs/plans/PLAN-test-suite-trim.results.md` under "Reverted phases".

If a SINGLE commit within a phase causes issues:

1. `git revert <commit-sha>` — atomic per-file commits make this safe.
2. The file returns to its pre-fold state; other folds in the phase remain.

---

## Anti-Patterns to Avoid

- ❌ Folding tests with different mock setups into one `test.each` — hides bugs.
- ❌ Deleting "looks redundant" tests without applying the 4-condition definition.
- ❌ Renaming tests to lose intent (`"case 1"`, `"variant 2"` — bad).
- ❌ Skipping the verification loop ("it'll be fine").
- ❌ Parallelizing file work across multiple agents — process sequentially.
- ❌ Touching `test/integration/`, `test/ui/`, `test/contracts/` — out of scope.
- ❌ Touching tests whose filename contains `bug`, `regression`, `issue-<n>` without explicit human review.
- ❌ Helper extraction that changes test count semantics (a helper that wraps `test()` calls is forbidden — too clever).
- ❌ Bundling multiple phases into one PR — un-revertable.

---

## Hand-Off Notes for Executor Model

- **Start with Phase 0.** Tag `trim-baseline`. Then proceed sequentially.
- **One file at a time.** Never parallelize across files.
- **Run typecheck + touched-file test after every commit** (~10s, cheap).
- **Run full lint + suite every 5 commits or at phase boundary** (~40s).
- **When in doubt, leave the test alone.** A lost test catching a real bug later is far worse than 50 redundant tests staying.
- **5-minute audit gate is mandatory.** Do not skip it. If audit shows no fold candidates, skip the file and log it.
- **Use `timeout 30 bun test <file> --timeout=5000`** for inner loop — never bare `bun test` (PreToolUse hook blocks it).
- **If `test.each` validation fails in Phase 1 first commit, stop and ask.** Do not mass-fold against unverified syntax.
- **Each phase = one branch = one PR.** Title: `refactor(test): phase N — <name>`.
- **Log every skipped file** in the phase's results section with a one-line reason.

---

## Open Questions (resolved)

| Question | Answer |
|:---|:---|
| Integration tests in scope? | **No** — `test/unit/` only. |
| Coverage threshold? | **Global drop ≤ 0.5pp, per-file drop ≤ 1pp.** |
| Speed goal? | **None** — suite is already 30–40s. Goal is maintainability. |
| Bug-named files? | **Skip without explicit human approval.** |
| CI changes? | **None planned** — `.github/workflows/ci.yml` stays as-is. |
| `slowTest` helper / test tiering? | **Dropped** — not needed. |
