# Issue 737: Rectification Prompt — Demand Full-Suite Green

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the rectification prompt to explicitly demand agents run the full test suite, eliminating one avoidable cycle per cross-story regression.

**Architecture:** 
- **Phase 1 (PR 1):** Remove dead-code branches from `RectifierPromptBuilder` (two unused trigger types and their constants).
- **Phase 2 (PR 2):** Consolidate the two live triggers into a single static method `regressionFailure()` with sharper, unambiguous wording that explicitly demands the full test suite be run, not just the listed failures.
- **Phase 3 (PR 3, optional):** Annotate the Phase 5 spec to document why triggers were planned but never wired.

**Tech Stack:**
- TypeScript (Bun 1.3.7+)
- Test runner: `bun test`
- Pattern: builder static methods returning prompt strings
- Snapshot tests for prompt stability

**Why this order:**
1. Cleanup first (PR 1) reduces surface area for everything that follows
2. Validate wording on real runs (PR 2) before stacking more changes
3. PR 1 unblocks PR 2 (eliminates dead trigger branches)

---

## File Structure

### Modified Files

| File | Purpose | Changes |
|:-----|:--------|:--------|
| `src/prompts/builders/rectifier-builder.ts` | Prompt builder for rectification | PR 1: Remove 2 triggers + constants + switch. PR 2: Add `regressionFailure()` static, remove builder pattern. |
| `src/verification/rectification-loop.ts` | Post-verify rectification | PR 2: Switch from `for("verify-failure")...build()` to `regressionFailure(...)` |
| `src/tdd/rectification-gate.ts` | TDD full-suite gate | PR 2: Switch from `for("tdd-suite-failure")...build()` to `regressionFailure(...)` |
| `test/unit/prompts/rectifier-builder.test.ts` | Unit tests | PR 1: Remove ~12 test cases for dead triggers. PR 2: Update snapshots, add `regressionFailure()` tests. |

### Constants Removed (PR 1)

- `TDD_TEST_FAILURE_TASK` — used only by dead `tdd-test-failure` trigger
- `REVIEW_FINDINGS_TASK` — used only by dead `review-findings` trigger

### Methods Removed (PR 2)

- `RectifierPromptBuilder.for(trigger)` — constructor (replaced by static `regressionFailure()`)
- Instance methods: `constitution()`, `context()`, `story()`, `priorFailures()`, `findings()`, `testCommand()`, `isolation()`, `conventions()`, `task()`, `build()`
- Private fields: `acc`, `trigger`
- Private helper: `s(...)`

### Methods Retained (no change in PR 1 or PR 2)

- `firstAttemptDelta()` — autofix delta prompts
- `continuation()` — autofix retry prompts
- `noOpReprompt()` — agent produced no changes
- `escalated()` — escalation prompt
- `reviewRectification()` — review-findings path
- `semanticRectification()`, `adversarialRectification()`, `mechanicalRectification()`, `combinedLlmRectification()` — review subspecialties
- `testWriterRectification()` — test-writer fixes
- `swapHandoff()` — agent swap helper
- `formatCheckErrors()` — static utility

---

## Phase 1: Dead-Code Removal (PR 1)

### Task 1: Analyze and plan removals

**Files:**
- Read: `src/prompts/builders/rectifier-builder.ts` (lines 8–12, 45–49, 642–653, 655–720)
- Read: `test/unit/prompts/rectifier-builder.test.ts` (entire file)

- [ ] **Step 1: Verify no production callers for dead triggers**

Run:
```bash
cd /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax
grep -r "\"tdd-test-failure\"" --include="*.ts" src/
grep -r "\"review-findings\"" --include="*.ts" src/
```

Expected: No matches in `src/` (only in comments and the builder itself).

- [ ] **Step 2: List all test cases using dead triggers**

Run:
```bash
grep -n "tdd-test-failure\|review-findings" test/unit/prompts/rectifier-builder.test.ts | head -20
```

Expected: Matches at lines like 79, 82, 93, 107, 124, 139, 149, 174, 185, 229, 240, 251.

- [ ] **Step 3: Commit the analysis**

```bash
git add -A
git commit -m "chore: analyze dead-trigger removal scope (issue #737 PR 1)"
```

### Task 2: Remove RectifierTrigger union entries

**Files:**
- Modify: `src/prompts/builders/rectifier-builder.ts:45–49`

- [ ] **Step 1: Update the file docstring**

In `src/prompts/builders/rectifier-builder.ts`, lines 8–12, change:

```typescript
// BEFORE
/**
 * RectifierPromptBuilder — prompt builder for rectification sessions.
 *
 * Cross-domain: needs TDD context (story, isolation, role task) AND review context
 * (prior failures, findings). A dedicated builder avoids forcing rectification prompts
 * into either TddPromptBuilder or ReviewPromptBuilder.
 *
 * Four triggers cover all rectification entry points:
 *   tdd-test-failure  — implementer fixes tests written by the test-writer
 *   tdd-suite-failure — implementer fixes regressions after the full-suite gate
 *   verify-failure    — post-verify rectification loop (autofix)
 *   review-findings   — review surfaced critical findings; rectifier addresses them
 *
 * Replaces: buildImplementerRectificationPrompt / buildRectificationPrompt from src/tdd/prompts.ts
 */
```

```typescript
// AFTER
/**
 * RectifierPromptBuilder — prompt builder for rectification sessions.
 *
 * Cross-domain: needs TDD context (story, isolation, role task) AND review context
 * (prior failures, findings). A dedicated builder avoids forcing rectification prompts
 * into either TddPromptBuilder or ReviewPromptBuilder.
 *
 * Replaces: buildImplementerRectificationPrompt / buildRectificationPrompt from src/tdd/prompts.ts
 *
 * NOTE: This class is being deprecated in favor of static factory methods.
 * The old `for(trigger)` builder pattern is removed in ADR-018 / Issue #737 PR 2.
 * Remaining: static methods for review, autofix, and escalation prompts.
 */
```

- [ ] **Step 2: Remove RectifierTrigger union**

Remove lines 45–49 entirely:

```typescript
// DELETE THESE LINES
export type RectifierTrigger =
  | "tdd-test-failure" // tests written by test-writer fail; implementer rectifies
  | "tdd-suite-failure" // full suite fails after implementation
  | "verify-failure" // post-verify rectification (autofix loop)
  | "review-findings"; // review surfaced critical findings; rectifier addresses them
```

- [ ] **Step 3: Update type export**

Line 51, change from:

```typescript
export type { FailureRecord, ReviewFinding };
```

to:

```typescript
export type { FailureRecord, ReviewFinding };
// RectifierTrigger removed in PR 1 (dead triggers)
```

(The type is no longer exported since it's gone.)

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: TypeErrors pointing to `rectifierTaskFor()` switch and test imports.

- [ ] **Step 5: Commit**

```bash
git add src/prompts/builders/rectifier-builder.ts
git commit -m "refactor(#737): remove RectifierTrigger union type (PR 1 dead-code removal)"
```

### Task 3: Remove rectifierTaskFor() function and switch

**Files:**
- Modify: `src/prompts/builders/rectifier-builder.ts:642–653`

- [ ] **Step 1: Delete the entire switch function**

Remove lines 642–653:

```typescript
// DELETE THIS ENTIRE BLOCK
function rectifierTaskFor(trigger: RectifierTrigger): PromptSection {
  switch (trigger) {
    case "tdd-test-failure":
      return { id: "task", overridable: false, content: TDD_TEST_FAILURE_TASK };
    case "tdd-suite-failure":
      return { id: "task", overridable: false, content: TDD_SUITE_FAILURE_TASK };
    case "verify-failure":
      return { id: "task", overridable: false, content: VERIFY_FAILURE_TASK };
    case "review-findings":
      return { id: "task", overridable: false, content: REVIEW_FINDINGS_TASK };
  }
}
```

- [ ] **Step 2: Remove the function call from RectifierPromptBuilder.task()**

In the `task()` method (line 110–113), remove the entire method:

```typescript
// DELETE THESE LINES
  task(): this {
    this.acc.add(rectifierTaskFor(this.trigger));
    return this;
  }
```

- [ ] **Step 3: Run typecheck again**

```bash
bun run typecheck
```

Expected: Still errors for constants being unused.

- [ ] **Step 4: Commit**

```bash
git add src/prompts/builders/rectifier-builder.ts
git commit -m "refactor(#737): remove rectifierTaskFor() switch function (PR 1)"
```

### Task 4: Remove task constants

**Files:**
- Modify: `src/prompts/builders/rectifier-builder.ts:655–720`

- [ ] **Step 1: Delete TDD_TEST_FAILURE_TASK constant**

Remove lines 655–670:

```typescript
// DELETE THIS ENTIRE BLOCK
const TDD_TEST_FAILURE_TASK = `# Rectification Required
...
- Focus on fixing the source code to meet the test requirements.`;
```

- [ ] **Step 2: Delete VERIFY_FAILURE_TASK constant** (optional, since it will be recreated in PR 2)

Actually, **keep `TDD_SUITE_FAILURE_TASK` and `VERIFY_FAILURE_TASK`** for now — they'll be refactored in PR 2, not deleted in PR 1. Only delete the dead ones:

Remove lines 655–670 (TDD_TEST_FAILURE_TASK) and lines 706–720 (REVIEW_FINDINGS_TASK).

```typescript
// DELETE TDD_TEST_FAILURE_TASK (lines 655-670)
const TDD_TEST_FAILURE_TASK = `# Rectification Required
...`;

// DELETE REVIEW_FINDINGS_TASK (lines 706-720)
const REVIEW_FINDINGS_TASK = `# Rectification Required
...`;

// KEEP TDD_SUITE_FAILURE_TASK and VERIFY_FAILURE_TASK — PR 2 will refactor them
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors (constants now gone, task() method deleted, switch deleted).

- [ ] **Step 4: Commit**

```bash
git add src/prompts/builders/rectifier-builder.ts
git commit -m "refactor(#737): remove TDD_TEST_FAILURE_TASK and REVIEW_FINDINGS_TASK constants (PR 1)"
```

### Task 5: Remove dead test cases

**Files:**
- Modify: `test/unit/prompts/rectifier-builder.test.ts`

- [ ] **Step 1: Remove trigger from TRIGGERS array**

Line 78–83, change from:

```typescript
const TRIGGERS: RectifierTrigger[] = [
  "tdd-test-failure",
  "tdd-suite-failure",
  "verify-failure",
  "review-findings",
];
```

to:

```typescript
const TRIGGERS: ("tdd-suite-failure" | "verify-failure")[] = [
  "tdd-suite-failure",
  "verify-failure",
];
```

- [ ] **Step 2: Remove full build tests for dead triggers**

Remove lines 92–104 (tdd-test-failure full build):

```typescript
// DELETE THIS TEST
  test("tdd-test-failure — full build with failures and test command", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      ...
    expect(result).toMatchSnapshot();
  });
```

Remove lines 106–117 (review-findings full build):

```typescript
// DELETE THIS TEST
  test("review-findings — full build with findings", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      ...
    expect(result).toMatchSnapshot();
  });
```

- [ ] **Step 3: Remove fluent API tests using dead triggers**

Search for and remove any test using `"tdd-test-failure"` or `"review-findings"` in the names. Examples:

Line 124:
```typescript
// DELETE
    const builder = RectifierPromptBuilder.for("tdd-test-failure");
```

Line 149:
```typescript
// DELETE
    const builder = RectifierPromptBuilder.for("tdd-test-failure").story(STORY).task();
```

Line 185–193:
```typescript
// DELETE THIS ENTIRE TEST (uses tdd-test-failure)
  test("includes failure test names", async () => {
    const result = await RectifierPromptBuilder.for("tdd-test-failure")
      ...
  });
```

Lines 229–237:
```typescript
// DELETE THIS ENTIRE TEST (uses review-findings)
  test("includes finding descriptions", async () => {
    const result = await RectifierPromptBuilder.for("review-findings")
      ...
  });
```

And similar tests at lines 240–248, 251–258, 261–267, 283–289, 292–298, 304–308, 322–326.

- [ ] **Step 4: Keep tests for live triggers only**

After removal, test file should have:
- Snapshot tests for `tdd-suite-failure` and `verify-failure` only
- Fluent API tests using `verify-failure` and `tdd-suite-failure`
- Task section tests for both triggers
- Constitution/context tests using live triggers

- [ ] **Step 5: Update snapshot tests**

Lines 163–171 should only test live triggers:

```typescript
  test("includes story title", async () => {
    const result = await buildMinimal("tdd-suite-failure");
    expect(result).toContain(STORY.title);
  });

  test("includes story description", async () => {
    const result = await buildMinimal("verify-failure");
    expect(result).toContain(STORY.description);
  });

  test("includes acceptance criteria", async () => {
    const result = await buildMinimal("tdd-suite-failure");
    for (const ac of STORY.acceptanceCriteria) {
      expect(result).toContain(ac);
    }
  });
```

- [ ] **Step 6: Run tests**

```bash
timeout 30 bun test test/unit/prompts/rectifier-builder.test.ts --timeout=5000
```

Expected: Several snapshot tests fail (old snapshots still have 4 triggers, now we have 2).

- [ ] **Step 7: Update snapshots**

```bash
timeout 30 bun test test/unit/prompts/rectifier-builder.test.ts -u --timeout=5000
```

- [ ] **Step 8: Run tests again to verify**

```bash
timeout 30 bun test test/unit/prompts/rectifier-builder.test.ts --timeout=5000
```

Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add test/unit/prompts/rectifier-builder.test.ts
git commit -m "test(#737): remove test cases for dead triggers, update snapshots (PR 1)"
```

### Task 6: Final PR 1 validation

- [ ] **Step 1: Run full test suite**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Run lint**

```bash
bun run lint
```

Expected: No errors.

- [ ] **Step 4: Verify no production usage of removed triggers**

```bash
grep -r "tdd-test-failure\|review-findings" --include="*.ts" src/ test/ || echo "✓ No matches (expected)"
```

Expected: No matches in source code (only in commit messages or docs).

- [ ] **Step 5: Create summary of changes**

Create a file `PR1_SUMMARY.txt`:

```
PR 1: Dead-Code Removal (Issue #737)

Changes:
- Removed RectifierTrigger union type (2 dead triggers)
- Removed TDD_TEST_FAILURE_TASK constant (655 lines)
- Removed REVIEW_FINDINGS_TASK constant (720 lines)
- Removed rectifierTaskFor() switch function (642-653 lines)
- Removed RectifierPromptBuilder.task() instance method (110-113 lines)
- Removed ~15 test cases for dead triggers

Files modified:
- src/prompts/builders/rectifier-builder.ts (~50 lines removed)
- test/unit/prompts/rectifier-builder.test.ts (~60 lines removed)

Total: ~110 lines removed

Risk: Very low — no production callsite touched, dead code only
Test impact: Snapshot tests updated for 2 remaining triggers only
```

- [ ] **Step 6: Final commit message**

```bash
git log --oneline -5
```

Expected: 5 commits for PR 1 (analyze, union removal, switch removal, constant removal, test removal).

---

## Phase 2: Consolidate + Sharpen Wording (PR 2)

### Task 7: Design the regressionFailure() signature and prompt body

**Files:**
- Design: `src/prompts/builders/rectifier-builder.ts`

- [ ] **Step 1: Write the new static method signature**

Create a new static method in `RectifierPromptBuilder`:

```typescript
/**
 * Prompt for implementing rectification when tests fail after implementation.
 *
 * Used when the full test suite reveals failures — either during the TDD
 * full-suite gate (rectification-gate.ts) or post-verify rectification
 * (rectification-loop.ts). Demand is explicit: agents must run the FULL
 * test command, not just the listed failures.
 *
 * Covers both semantic scenarios:
 *   - tdd-suite-failure — implementation's changes broke existing tests
 *   - verify-failure — post-verify rectification caught cross-story regressions
 *
 * Issue #737 consolidates both into this single method (removed separate
 * trigger-based branching in PR 2).
 */
static regressionFailure(opts: {
  story: UserStory;
  failures: FailureRecord[];
  testCommand: string;
  conventions?: boolean;
  isolation?: "strict" | "lite";
  constitution?: string;
  context?: string;
  promptPrefix?: string;
}): string {
  // Implementation in next steps
}
```

- [ ] **Step 2: Write the prompt body**

The new prompt replaces both `TDD_SUITE_FAILURE_TASK` and `VERIFY_FAILURE_TASK`. Key changes from the old wording:

**Old (ambiguous):**
```
4. Run the test command shown above to verify your fixes.
5. Ensure ALL tests pass before completing.
```

**New (explicit):**
```
3. After your fix, run the FULL repo test suite — the EXACT command below:

   `<testCommand>`

   The verifier will replay this same command. If you only run the failing
   tests in isolation, you may have introduced cross-story regressions you
   won't see. There is no benefit to skipping this — the verifier WILL catch
   anything you miss, and you'll just be back here in another cycle.

4. Do not declare done until step 3 shows 0 failures.
```

- [ ] **Step 3: Sketch the method body**

The method assembles sections in order:
1. Constitution (if provided)
2. Context (if provided)
3. Story section
4. Prior failures section
5. Test command section
6. Isolation (if provided)
7. Conventions (if provided)
8. Task section (the new wording)

This mirrors the old builder pattern but is non-fluent (assembles and returns synchronously).

---

### Task 8: Implement regressionFailure() method

**Files:**
- Modify: `src/prompts/builders/rectifier-builder.ts`

- [ ] **Step 1: Add the new static method**

Add after the existing static methods (after `swapHandoff()`, before closing brace):

```typescript
  /**
   * Prompt for rectification when tests fail after implementation.
   *
   * Used by TDD full-suite gate and post-verify rectification. Unambiguously
   * demands the agent run the FULL test command to catch cross-story regressions.
   *
   * @param opts.story — the story context
   * @param opts.failures — test failures to display
   * @param opts.testCommand — the full-suite test command to run
   * @param opts.conventions — whether to include conventions section (default: true)
   * @param opts.isolation — isolation mode ("strict" | "lite"), if any
   * @param opts.constitution — constitution text, if any
   * @param opts.context — context markdown, if any
   * @param opts.promptPrefix — diagnostic prefix (e.g., from debate stage), if any
   * @returns fully assembled prompt string
   */
  static regressionFailure(opts: {
    story: UserStory;
    failures: FailureRecord[];
    testCommand: string;
    conventions?: boolean;
    isolation?: "strict" | "lite";
    constitution?: string;
    context?: string;
    promptPrefix?: string;
  }): string {
    const parts: string[] = [];

    if (opts.promptPrefix) {
      parts.push(opts.promptPrefix);
      parts.push("\n");
    }

    if (opts.constitution) {
      parts.push(universalConstitutionSection(opts.constitution).content);
      parts.push("\n");
    }

    if (opts.context) {
      parts.push(universalContextSection(opts.context).content);
      parts.push("\n");
    }

    parts.push(buildStorySection(opts.story));
    parts.push("\n");

    parts.push(priorFailuresSection(opts.failures).content);
    parts.push("\n");

    parts.push(`# TEST COMMAND\n\n\`${opts.testCommand}\``);
    parts.push("\n\n");

    if (opts.isolation) {
      parts.push(buildIsolationSection("implementer", opts.isolation, undefined));
      parts.push("\n");
    }

    if (opts.conventions !== false) {
      parts.push(buildConventionsSection());
      parts.push("\n");
    }

    // Task section with explicit full-suite demand
    parts.push(`# Rectification Required

Tests are failing. Fix the source so all tests pass — not just the ones listed.

## Instructions

1. Review the failures above and identify the root cause of each.
2. Fix the source code WITHOUT loosening test assertions or removing tests.
3. After your fix, run the FULL repo test suite — the EXACT command below:

   \`${opts.testCommand}\`

   The verifier will replay this same command. If you only run the failing
   tests in isolation, you may have introduced cross-story regressions you
   won't see. There is no benefit to skipping this — the verifier WILL catch
   anything you miss, and you'll just be back here in another cycle.

4. Do not declare done until step 3 shows 0 failures.

**IMPORTANT:**
- Do NOT modify test files unless there is a legitimate bug in the test itself.
- Do NOT loosen assertions to mask implementation bugs.
- Focus on fixing the source code to meet the test requirements.`);

    return parts.join("");
  }
```

- [ ] **Step 2: Test the method in isolation**

Create a temporary test file `test-regression-failure.ts` in the test directory:

```typescript
import { RectifierPromptBuilder } from "../src/prompts";
import type { UserStory, FailureRecord } from "../src/prd";

const story: UserStory = {
  id: "US-042",
  title: "Add rate limiter",
  description: "Implement rate limiting.",
  acceptanceCriteria: ["Rate limit returns 429"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 1,
};

const failures: FailureRecord[] = [
  {
    test: "returns 429",
    file: "test/unit/rate-limiter.test.ts",
    message: "Expected 429, received 200",
  },
];

const prompt = RectifierPromptBuilder.regressionFailure({
  story,
  failures,
  testCommand: "bun test",
});

console.log(prompt);
console.log("\n✓ Method compiles and produces output");
```

Run:
```bash
bun test-regression-failure.ts
```

Expected: Output prints the full prompt without errors.

Delete the test file:
```bash
rm test-regression-failure.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/prompts/builders/rectifier-builder.ts
git commit -m "feat(#737): add RectifierPromptBuilder.regressionFailure() static method (PR 2)"
```

### Task 9: Remove old builder pattern (RectifierPromptBuilder class methods)

**Files:**
- Modify: `src/prompts/builders/rectifier-builder.ts:53–140`

- [ ] **Step 1: Delete the constructor and old instance methods**

Remove the constructor and all instance methods:

```typescript
// DELETE ENTIRE SECTION

  private acc = new SectionAccumulator();
  private trigger: RectifierTrigger;

  private constructor(trigger: RectifierTrigger) {
    this.trigger = trigger;
  }

  static for(trigger: RectifierTrigger): RectifierPromptBuilder {
    return new RectifierPromptBuilder(trigger);
  }

  constitution(c: string | undefined): this { ... }
  context(md: string | undefined): this { ... }
  story(s: UserStory): this { ... }
  priorFailures(failures: FailureRecord[]): this { ... }
  findings(fs: ReviewFinding[]): this { ... }
  testCommand(cmd: string | undefined): this { ... }
  isolation(mode?: "strict" | "lite"): this { ... }
  conventions(): this { ... }
  task(): this { ... }
  build(): Promise<string> { ... }

  private s(id: string, content: string): PromptSection { ... }
```

Keep the class declaration but make it just container for static methods now.

- [ ] **Step 2: Delete remaining task constants**

Remove lines with `TDD_SUITE_FAILURE_TASK` and `VERIFY_FAILURE_TASK` constants (now embedded in the method).

- [ ] **Step 3: Clean up the class**

The `RectifierPromptBuilder` class should now only have:
- File docstring
- Type exports (FailureRecord, ReviewFinding)
- Static methods (all the `static` ones, including the new `regressionFailure()`)
- No instance fields or methods (except private helpers)

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors (RectifierTrigger gone, for() removed).

- [ ] **Step 5: Commit**

```bash
git add src/prompts/builders/rectifier-builder.ts
git commit -m "refactor(#737): remove RectifierPromptBuilder builder pattern (PR 2 consolidation)"
```

### Task 10: Update rectification-loop.ts to use regressionFailure()

**Files:**
- Modify: `src/verification/rectification-loop.ts:238`

- [ ] **Step 1: Locate the old call**

Find the line building the verify-failure prompt:

```bash
grep -n "verify-failure" src/verification/rectification-loop.ts
```

Expected: Match at line ~238 (verify the exact line).

- [ ] **Step 2: Read the surrounding context**

Read lines 230–250 of rectification-loop.ts to understand the context.

- [ ] **Step 3: Replace the old builder call**

Old code:
```typescript
const rectPromise = RectifierPromptBuilder.for("verify-failure")
  .constitution(constitution)
  .context(ctxMd)
  .story(story)
  .priorFailures(failures)
  .testCommand(testCommand)
  .isolation(isolationMode)
  .conventions()
  .task()
  .build();
```

New code:
```typescript
const rectPrompt = RectifierPromptBuilder.regressionFailure({
  story,
  failures,
  testCommand,
  constitution,
  context: ctxMd,
  isolation: isolationMode,
  conventions: true,
});
const rectPromise = Promise.resolve(rectPrompt);
```

(The old code returned a Promise; the new method returns a string directly, so we wrap it.)

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors in rectification-loop.ts.

- [ ] **Step 5: Commit**

```bash
git add src/verification/rectification-loop.ts
git commit -m "refactor(#737): use regressionFailure() in rectification-loop (PR 2)"
```

### Task 11: Update rectification-gate.ts to use regressionFailure()

**Files:**
- Modify: `src/tdd/rectification-gate.ts:269` (approximate line)

- [ ] **Step 1: Locate the old call**

Find the line building the tdd-suite-failure prompt:

```bash
grep -n "tdd-suite-failure" src/tdd/rectification-gate.ts
```

Expected: Match at line ~269.

- [ ] **Step 2: Read the surrounding context**

Read lines 260–280 to understand the context and variables available.

- [ ] **Step 3: Replace the old builder call**

Old code (similar pattern to rectification-loop):
```typescript
return RectifierPromptBuilder.for("tdd-suite-failure")
  .constitution(...)
  .context(...)
  .story(story)
  .priorFailures(failures)
  .testCommand(testCommand)
  .isolation("strict")
  .conventions()
  .task()
  .build();
```

New code:
```typescript
return RectifierPromptBuilder.regressionFailure({
  story,
  failures,
  testCommand,
  constitution: ...,
  context: ...,
  isolation: "strict",
  conventions: true,
});
```

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors in rectification-gate.ts.

- [ ] **Step 5: Commit**

```bash
git add src/tdd/rectification-gate.ts
git commit -m "refactor(#737): use regressionFailure() in rectification-gate (PR 2)"
```

### Task 12: Update and run tests

**Files:**
- Modify: `test/unit/prompts/rectifier-builder.test.ts`

- [ ] **Step 1: Remove remaining test cases for old builder pattern**

Remove any test cases that use `RectifierPromptBuilder.for(trigger)...build()` pattern. After PR 1, only 2 triggers remain; remove all.

Actually, **refactor tests to use the new `regressionFailure()` method** instead of `for()...build()`.

Replace:
```typescript
test("some test", async () => {
  const result = await RectifierPromptBuilder.for("verify-failure")
    .story(STORY)
    .priorFailures(FAILURES)
    .testCommand(TEST_CMD)
    .task()
    .build();
  expect(result).toContain("...");
});
```

With:
```typescript
test("some test", () => {
  const result = RectifierPromptBuilder.regressionFailure({
    story: STORY,
    failures: FAILURES,
    testCommand: TEST_CMD,
  });
  expect(result).toContain("...");
});
```

- [ ] **Step 2: Add new tests for regressionFailure()**

Add a new describe block:

```typescript
describe("RectifierPromptBuilder.regressionFailure()", () => {
  test("includes story title and description", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain(STORY.title);
    expect(result).toContain(STORY.description);
  });

  test("includes acceptance criteria", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    for (const ac of STORY.acceptanceCriteria) {
      expect(result).toContain(ac);
    }
  });

  test("includes failure messages", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    for (const f of FAILURES) {
      expect(result).toContain(f.message);
    }
  });

  test("includes test command", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain(TEST_CMD);
  });

  test("demands FULL test suite explicitly", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
    });
    expect(result).toContain("FULL repo test suite");
    expect(result).toContain("EXACT command");
    expect(result).toContain("cross-story regressions");
  });

  test("includes conventions when enabled", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      conventions: true,
    });
    expect(result).toContain("conventions");
  });

  test("omits conventions when disabled", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      conventions: false,
    });
    // Conventions should not be present (or be minimal)
  });

  test("includes isolation when provided", () => {
    const result = RectifierPromptBuilder.regressionFailure({
      story: STORY,
      failures: FAILURES,
      testCommand: TEST_CMD,
      isolation: "strict",
    });
    expect(result).toContain("isolation") || expect(result).toContain("Isolation");
  });
});
```

- [ ] **Step 3: Update snapshots**

Run tests:
```bash
timeout 30 bun test test/unit/prompts/rectifier-builder.test.ts --timeout=5000
```

Expected: Snapshot tests fail (old format).

Update:
```bash
timeout 30 bun test test/unit/prompts/rectifier-builder.test.ts -u --timeout=5000
```

- [ ] **Step 4: Re-run tests**

```bash
timeout 30 bun test test/unit/prompts/rectifier-builder.test.ts --timeout=5000
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add test/unit/prompts/rectifier-builder.test.ts
git commit -m "test(#737): refactor to test regressionFailure(), remove old builder tests (PR 2)"
```

### Task 13: Final PR 2 validation

- [ ] **Step 1: Run full test suite**

```bash
bun run test
```

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors.

- [ ] **Step 3: Run lint**

```bash
bun run lint
```

Expected: No errors.

- [ ] **Step 4: Verify before/after prompt rendering**

Create a test to render both the new regressionFailure() prompt and visually inspect:

```bash
cat > test-prompt-render.ts << 'EOF'
import { RectifierPromptBuilder } from "./src/prompts";
import type { UserStory, FailureRecord } from "./src/prd";

const story: UserStory = {
  id: "US-001",
  title: "Add authentication",
  description: "Implement user authentication.",
  acceptanceCriteria: [
    "Users can log in with credentials",
    "Sessions persist across page reloads"
  ],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 2,
};

const failures: FailureRecord[] = [
  {
    test: "should log in user",
    file: "test/unit/auth.test.ts",
    message: "Expected token, received null",
  },
];

const prompt = RectifierPromptBuilder.regressionFailure({
  story,
  failures,
  testCommand: "bun run test",
  constitution: "You are a senior engineer. Fix only what is broken.",
});

console.log("=== NEW REGRESSION FAILURE PROMPT ===\n");
console.log(prompt);
console.log("\n=== PROMPT CHARACTER COUNT ===");
console.log(`Total: ${prompt.length} chars`);
console.log("\n✓ Prompt rendered successfully");
EOF

bun test-prompt-render.ts
rm test-prompt-render.ts
```

Expected: Prompt renders correctly, includes the new wording about full test suite.

- [ ] **Step 5: Create summary of PR 2 changes**

Create a file `PR2_SUMMARY.txt`:

```
PR 2: Consolidate + Sharpen Wording (Issue #737)

Changes:
- Added RectifierPromptBuilder.regressionFailure() static method
  - Consolidates tdd-suite-failure and verify-failure
  - New wording explicitly demands FULL test suite run
  - Uses options object instead of fluent builder pattern
- Removed RectifierPromptBuilder.for() constructor
- Removed all instance methods (constitution, context, story, etc.)
- Removed TDD_SUITE_FAILURE_TASK and VERIFY_FAILURE_TASK constants
- Updated src/verification/rectification-loop.ts to use new method
- Updated src/tdd/rectification-gate.ts to use new method
- Refactored test cases to test new static method

Files modified:
- src/prompts/builders/rectifier-builder.ts (~120 net)
- src/verification/rectification-loop.ts (~5 lines)
- src/tdd/rectification-gate.ts (~5 lines)
- test/unit/prompts/rectifier-builder.test.ts (~80 net)

Total: ~120 LOC net change

Key prompt change:
OLD: "Ensure ALL tests pass before completing."
NEW: "After your fix, run the FULL repo test suite — the EXACT command below:
      ... The verifier will replay this same command. If you only run the
      failing tests in isolation, you may have introduced cross-story
      regressions you won't see..."

Risk: Low–medium
- Prompt change affects every rectification cycle
- Wording is clearer and more explicit, should improve compliance
- Test coverage updated to reflect new behavior
```

- [ ] **Step 6: Final commit summary**

```bash
git log --oneline -10
```

Expected: Last 5 commits are PR 2 (method add, pattern removal, rectification-loop update, rectification-gate update, test updates).

---

## Phase 3: Spec Annotation (PR 3, optional)

### Task 14: Annotate Phase 5 spec (optional)

**Files:**
- Modify: `docs/specs/prompt-builder-phase5.md`

This task is **optional** — do it only if you have time or want to improve documentation.

- [ ] **Step 1: Locate the spec**

```bash
ls -la docs/specs/prompt-builder-phase5.md
```

- [ ] **Step 2: Find the section describing the four triggers**

Search for a table or section listing `tdd-test-failure`, `tdd-suite-failure`, etc.

- [ ] **Step 3: Add an annotation note**

After that section, add:

```markdown
### Execution Status

Three of the four triggers planned in Phase 5 were wired:
- `tdd-suite-failure` ✓ Wired in `src/tdd/rectification-gate.ts`
- `verify-failure` ✓ Wired in `src/verification/rectification-loop.ts`

Two were never wired:
- `tdd-test-failure` — TDD implementer session continues in-place after test-writer;
  no fresh-prompt callsite (see `src/tdd/session-runner.ts:207-211`)
- `review-findings` — Review findings flow through `RectifierPromptBuilder.reviewRectification()`
  static method instead, with semantic/adversarial/mechanical/combined sub-paths

**Cleanup:** Issue #737 PR 1 + PR 2 removed the dead triggers and consolidated the
two live ones into `RectifierPromptBuilder.regressionFailure()`. See [#737](https://github.com/nathapp-io/nax/issues/737).
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/prompt-builder-phase5.md
git commit -m "docs(#737): annotate Phase 5 triggers (dead vs wired), reference PR 3"
```

---

## Testing & Verification

### Full suite

After each PR:

```bash
bun run test
bun run typecheck
bun run lint
```

### Key test files

- `test/unit/prompts/rectifier-builder.test.ts` — builder behavior
- `test/unit/verification/rectification-loop.test.ts` — loop behavior (if exists)
- `test/unit/tdd/rectification-gate.test.ts` — gate behavior (if exists)

### Integration check

Verify the new prompt is produced correctly:

```bash
grep -A 20 "FULL repo test suite" src/prompts/builders/rectifier-builder.ts
```

Expected: New wording appears in the `regressionFailure()` method body.

---

## Summary

**PR 1:** Removes dead code (tdd-test-failure, review-findings triggers) — ~110 LOC
**PR 2:** Consolidates live triggers and sharpens wording — ~120 LOC net
**PR 3:** Optional documentation update — ~10 LOC

**Total:** ~240 LOC net change, split into 3 reviewable pieces

**Impact:** Agents now receive an unambiguous prompt demanding the full test suite, eliminating one avoidable rectification cycle per cross-story regression (Issue #737 symptom: US-001 prompted twice in 14 minutes with a cross-story regression that would have been caught in cycle 1 if the agent had run the full suite).
