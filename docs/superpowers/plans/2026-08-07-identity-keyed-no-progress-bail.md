# Identity-Keyed No-Progress Bail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `withNoProgressBail`, export it from `@/execution`, and compose it ahead of the existing increasing-failures bail in story rectification.

**Architecture:** A focused sibling module in `src/execution/story-orchestrator/no-progress-bail.ts` will inspect stored `Iteration.findingsBefore` and `findingsAfter` using the existing `findingKey` helper. It preserves disabled strategy identity and user-supplied bail precedence; rectification will apply the no-progress wrapper first to the raw strategies, then the count wrapper to that result so no-progress is evaluated first while user predicates remain authoritative.

**Tech Stack:** TypeScript strict, Bun, `bun:test`, Biome.

---

### Task 1: Add unit coverage for the no-progress wrapper

**Files:**
- Create: `test/unit/execution/story-orchestrator-no-progress-bail.test.ts`
- Reference: `test/unit/execution/story-orchestrator-bail.test.ts`
- Reference: `src/findings/types.ts` (`findingKey`)
- Reference: `src/findings/cycle-types.ts` (`Iteration`, `FixStrategy`)

- [ ] **Step 1: Write failing tests**

Create fixtures for stable findings, iterations with explicit before/after arrays, and a minimal strategy. Import `withNoProgressBail` from `@/execution`. Cover these runtime behaviors with separate `US-002` tests:

```ts
import { describe, expect, test } from "bun:test";
import { withNoProgressBail } from "@/execution";
import type { Finding, FixStrategy, Iteration } from "@/findings";

const finding = (message: string): Finding => ({
  severity: "error",
  category: "test",
  source: "tdd-verifier",
  message,
});

const iteration = (before: Finding[], after: Finding[], iterationNum: number): Iteration<Finding> => ({
  iterationNum,
  findingsBefore: before,
  findingsAfter: after,
  fixesApplied: [{ strategyName: "s", op: "noop", targetFiles: [], summary: "" }],
  outcome: "unchanged",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:01.000Z",
});

const strategy = (): FixStrategy<Finding, unknown, unknown, unknown> => ({
  name: "s",
  appliesTo: () => true,
  fixOp: { name: "noop" } as FixStrategy<Finding, unknown, unknown, unknown>["fixOp"],
  buildInput: () => ({}),
  maxAttempts: 12,
});

const bail = (enabled: boolean, threshold: number, base = strategy()) => {
  const wrapped = withNoProgressBail([base], enabled, threshold)[0];
  if (!wrapped?.bailWhen) throw new Error("expected bailWhen");
  return wrapped.bailWhen;
};

test("US-002 AC1/AC4: bails after three trailing identical findings", () => {
  const f = finding("same");
  expect(bail(true, 3)([
    iteration([f], [f], 1),
    iteration([f], [f], 2),
    iteration([f], [f], 3),
  ])).toContain("3 consecutive");
});

test("US-002 AC2: returns null when each iteration removes a finding", () => {
  const findings = [1, 2, 3, 4, 5].map((n) => finding(String(n)));
  const iterations = findings.map((_, index) => iteration(findings, findings.slice(index + 1), index + 1));
  expect(bail(true, 3)(iterations)).toBeNull();
});

test("US-002 AC3: returns null before the threshold", () => {
  const f = finding("same");
  expect(bail(true, 3)([iteration([f], [f], 1), iteration([f], [f], 2)])).toBeNull();
});

test("US-002 AC5/AC10/AC11: counts trailing iterations and persisted findings", () => {
  const findings = [finding("one"), finding("two")];
  const reason = bail(true, 3)([1, 2, 3].map((n) => iteration(findings, [...findings, finding(`extra-${n}`)], n)));
  expect(reason).toContain("3 consecutive iteration(s)");
  expect(reason).toContain("2 finding(s) persisted");
});

test("US-002 AC6/AC7: disabled wrapper preserves strategy and bailWhen", () => {
  const userBail = () => "user-stop";
  const original = { ...strategy(), bailWhen: userBail };
  const [returned] = withNoProgressBail([original], false, 3);
  expect(returned).toBe(original);
  expect(returned?.bailWhen).toBe(userBail);
});

test("US-002 AC8: user bail reason wins without consulting no-progress", () => {
  const base = { ...strategy(), bailWhen: () => "user-stop" };
  expect(bail(true, 3, base)([])).toBe("user-stop");
});

test("US-002 AC9: empty before findings count as progress", () => {
  expect(bail(true, 3)([1, 2, 3].map((n) => iteration([], [finding(`after-${n}`)], n)))).toBeNull();
});
```

Add a test for additional after findings still bailing (included above), and a composition-precedence test using `withIncreasingFailuresBail`: wrap the count-wrapped strategy with no-progress and assert the returned reason contains `no finding resolved`, not `failure count increased`.

- [ ] **Step 2: Run the new test to verify RED**

Run:

```bash
bun test test/unit/execution/story-orchestrator-no-progress-bail.test.ts --timeout=30000
```

Expected: assertion/import failure because `withNoProgressBail` is not yet exported; fix only test setup errors until the test reaches behavioral assertions.

---

### Task 2: Implement and export `withNoProgressBail`

**Files:**
- Create: `src/execution/story-orchestrator/no-progress-bail.ts`
- Modify: `src/execution/story-orchestrator/index.ts`
- Modify: `src/execution/index.ts`
- Reference: `src/findings/types.ts`, `src/findings/cycle-types.ts`

- [ ] **Step 1: Implement the minimal wrapper**

Use this implementation shape, with no comments added beyond the required exported API documentation:

```ts
import type { Finding, FixStrategy, Iteration, findingKey } from "@/findings";
import { findingKey } from "@/findings";

function madeNoProgress(iteration: Iteration<Finding>): boolean {
  if (iteration.findingsBefore.length === 0) return false;
  const after = new Set(iteration.findingsAfter.map(findingKey));
  return iteration.findingsBefore.every((finding) => after.has(findingKey(finding)));
}

export function withNoProgressBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
  consecutiveNoProgress: number,
): FixStrategy<Finding, unknown, unknown, unknown>[] {
  if (!enabled) return strategies;
  const threshold = Math.max(1, consecutiveNoProgress);
  return strategies.map((strategy) => ({
    ...strategy,
    bailWhen: (iterations: Iteration<Finding>[]): string | null => {
      const userReason = strategy.bailWhen?.(iterations) ?? null;
      if (userReason !== null) return userReason;
      if (iterations.length < threshold) return null;
      const trailing = iterations.slice(-threshold);
      if (!trailing.every(madeNoProgress)) return null;
      const persisted = new Set(trailing.at(-1)?.findingsAfter.map(findingKey));
      const persistedCount = trailing.at(-1)?.findingsBefore.filter((finding) => persisted.has(findingKey(finding))).length ?? 0;
      return `no finding resolved for ${threshold} consecutive iteration(s); ${persistedCount} finding(s) persisted`;
    },
  }));
}
```

Use the project’s actual import syntax and type-only import conventions. The persisted count must reflect the final trailing iteration’s before keys present in its after set, including when after contains additional findings.

- [ ] **Step 2: Export through both barrels**

Add `withNoProgressBail` to the story-orchestrator barrel and the public execution barrel, matching the existing `withIncreasingFailuresBail` export pattern.

- [ ] **Step 3: Run scoped unit tests**

Run:

```bash
bun test test/unit/execution/story-orchestrator-no-progress-bail.test.ts --timeout=30000
```

Expected: all new wrapper and precedence tests pass.

---

### Task 3: Wire rectification composition and integration coverage

**Files:**
- Modify: `src/execution/story-orchestrator/rectification.ts:8,287-300`
- Modify: `test/unit/execution/story-orchestrator-no-progress-bail.test.ts` or create `test/integration/execution/no-progress-rectification.test.ts`
- Reference: existing `_storyOrchestratorDeps.runFixCycle` injection and rectification fixtures

- [ ] **Step 1: Add production-entry tests before wiring**

Capture the cycle passed to `_storyOrchestratorDeps.runFixCycle`, invoke its strategy’s `bailWhen` with three iterations satisfying both predicates, and assert the reason is no-progress. Add an integration-style injected-cycle test where validation always returns the same two findings and the fix operation is counted; assert no-progress-enabled configuration stops after exactly three fix dispatches and returns `rectificationExhausted: true`. Add the disabled case and assert dispatch count exceeds three. Keep all process and agent calls mocked through existing deps.

- [ ] **Step 2: Run the scoped integration tests to verify RED**

Run:

```bash
bun test test/unit/execution/story-orchestrator-no-progress-bail.test.ts test/unit/execution/story-orchestrator-revalidation-carveout.test.ts --timeout=30000
```

Expected: the new production composition assertion fails because rectification currently applies only `withIncreasingFailuresBail`.

- [ ] **Step 3: Compose wrappers with explicit precedence**

In `rectification.ts`, import `withNoProgressBail` from the sibling module and build strategies in this order:

```ts
const rawStrategies = (overrides?.strategies ?? rectification.strategies) as FixStrategy<
  Finding,
  unknown,
  unknown,
  unknown
>[];
const noProgressStrategies = withNoProgressBail(
  rawStrategies,
  rectification.abortOnNoProgress ?? false,
  rectification.consecutiveNoProgressToBail ?? 3,
);
const strategies = withIncreasingFailuresBail(
  noProgressStrategies,
  rectification.abortOnIncreasingFailures,
  rectification.consecutiveIncreasesToBail ?? 1,
);
```

Assign `strategies` to `cycle.strategies`. This ensures the outer count wrapper invokes the inner no-progress wrapper only after its own user predicate; because the no-progress wrapper is inside and sees no user predicate, the no-progress reason is selected before count-increase. If the existing wrapper semantics require the opposite nesting for the stated observable precedence, preserve the explicit behavior by making the no-progress wrapper evaluate the prior predicate result only after its own predicate; tests must decide the final ordering.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test test/unit/execution/story-orchestrator-bail.test.ts test/unit/execution/story-orchestrator-no-progress-bail.test.ts test/unit/execution/story-orchestrator-revalidation-carveout.test.ts --timeout=30000
```

Expected: all bail and rectification tests pass.

---

### Task 4: Verify, review, and commit

**Files:**
- All files changed by Tasks 1–3 only

- [ ] **Step 1: Inspect the diff and status**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff
```

Confirm only the new bail module, its authorized barrel/composition changes, and US-002 tests are present.

- [ ] **Step 2: Run required quality gates**

Run:

```bash
bun run lint:json
bun run typecheck
```

Expected: both pass. If a failure is pre-existing and outside changed files, leave unrelated files untouched and report it.

- [ ] **Step 3: Run the final scoped test set**

Run:

```bash
bun test test/unit/execution/story-orchestrator-bail.test.ts test/unit/execution/story-orchestrator-no-progress-bail.test.ts test/unit/execution/story-orchestrator-revalidation-carveout.test.ts --timeout=30000
```

Expected: all pass.

- [ ] **Step 4: Commit the implementation**

Run:

```bash
git add src/execution/story-orchestrator/no-progress-bail.ts src/execution/story-orchestrator/index.ts src/execution/index.ts src/execution/story-orchestrator/rectification.ts test/unit/execution/story-orchestrator-no-progress-bail.test.ts
git commit -m "feat(US-002): add identity-keyed no-progress bail"
```

Do not include unrelated files or modify CI/docs/roadmap files.

---

## Coverage Checklist

- AC1, AC3, AC4: threshold and trailing-window behavior — Task 1.
- AC2, AC5, AC9: identity comparison, additions, and empty-before progress — Task 1.
- AC6, AC7, AC8: disabled identity preservation and user predicate precedence — Tasks 1–2.
- AC10, AC11: reason details — Task 1.
- AC12–AC14: production rectification exhaustion and dispatch count — Task 3.
- AC15: no-progress versus count-increase precedence — Tasks 1 and 3.

## Self-Review

- No TODO/TBD placeholders remain.
- All referenced symbols use the existing `Finding`, `Iteration`, and `FixStrategy` contracts.
- The production wiring is limited to the authorized rectification file and required barrels.
- Tests use `bun:test` and injected orchestration dependencies; no real process or network I/O is introduced.
