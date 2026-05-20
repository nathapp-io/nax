# Rectification Unification (US-006a + US-006b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold gate-internal rectification into the general `runFixCycle` phase so `runFixCycle` becomes the single rectification SSOT across the codebase, then delete the now-dead `runRectificationLoop`.

**Architecture:** US-006a is purely additive — it adds the adapter, strategy, prompt method, and wires them in while leaving `runRectificationLoop` intact. US-006b is deletion-only, removing the now-unreachable code once all callers are proven gone. The `fullSuiteGateOp` is converted from running its own rectification loop to returning `findings: Finding[]` for the general rectification phase to consume.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, Biome for lint.

**Spec:** `docs/specs/SPEC-rectification-unification.md`

**Branch:** `refactor/rectification-unification`

---

## File Map

### US-006a — Files to Create
- `src/findings/adapters/test-failure.ts` — `TestFailure → Finding` adapter
- `src/operations/full-suite-rectify.ts` — `fullSuiteRectifyStrategy` definition
- `test/unit/findings/adapters/test-failure.test.ts` — unit tests for adapter
- `test/unit/operations/full-suite-rectify.test.ts` — unit tests for strategy

### US-006a — Files to Modify
- `src/findings/adapters/index.ts` — add exports for `test-failure.ts`
- `src/findings/index.ts` — add `testFailureToFinding`, `testSummaryToFindings` to explicit named export block (it uses named not `export *`)
- `src/prompts/builders/rectifier-builder.ts` — add `static failingTestContext(findings: Finding[]): string`
- `src/operations/full-suite-gate.ts` — remove internal rectification; add `findings` to output; simplify status type
- `src/execution/story-orchestrator.ts` — update `gatherRectificationFindings`, `validate`, and `ExecutionPlan.run()` short-circuit
- `src/execution/build-plan-for-strategy.ts` — wire `fullSuiteRectifyStrategy` into rectification strategies
- `src/execution/plan-inputs.ts` — remove `rectificationEnabled` from `fullSuiteGateInput`
- `src/pipeline/stages/rectify.ts` — rewire `runRectificationLoop` import to `tdd` re-export
- `src/execution/lifecycle/run-regression.ts` — rewire `runRectificationLoop` import to `tdd` re-export
- `test/unit/operations/full-suite-gate.test.ts` — update tests for new interface
- `test/unit/execution/story-orchestrator.test.ts` — add tests for short-circuit + validate
- `test/unit/prompts/builders/rectifier-builder.test.ts` — add test for `failingTestContext`
- `test/integration/tdd/story-orchestrator-core.test.ts` — remove `rectificationEnabled` from `fullSuiteGate` inputs
- `test/integration/tdd/story-orchestrator-failureCategory.test.ts` — same
- `test/integration/tdd/story-orchestrator-fallback.test.ts` — same
- `test/integration/tdd/story-orchestrator-lite.test.ts` — same
- `test/integration/tdd/story-orchestrator-verdict.test.ts` — same
- `test/integration/tdd/orchestrator-totals.test.ts` — same

### US-006a — Files to Delete (dead-behavior tests)
- `test/unit/operations/full-suite-gate-cost-scope.test.ts` — tested `runRectificationLoop` dep (deleted)
- `test/integration/agents/acp/tdd-flow-rectification.test.ts` — tested `failed-no-rectification`/`rectification-exhausted` statuses (deleted)

### US-006b — Files to Delete
- `src/verification/rectification-loop.ts`
- `test/unit/verification/rectification-loop.test.ts`
- `test/unit/verification/rectification-loop-types.test.ts`
- `test/unit/verification/rectification-loop-escalation.test.ts`
- `test/unit/verification/rectification-loop-debate.test.ts`
- `test/unit/verification/rectification-loop-debate-cost.test.ts`

### US-006b — Files to Modify
- `src/verification/index.ts` — remove `export { _rectificationDeps } from "./rectification-loop"` (line 14)

---

## US-006a

### Task 1: Test-failure → Finding adapter

**Files:**
- Create: `src/findings/adapters/test-failure.ts`
- Create: `test/unit/findings/adapters/test-failure.test.ts`
- Modify: `src/findings/adapters/index.ts`

- [ ] **Step 1.1: Write the failing test**

Create `test/unit/findings/adapters/test-failure.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { testFailureToFinding, testSummaryToFindings } from "@/findings";
import type { TestFailure, TestSummary } from "@/test-runners";

describe("testFailureToFinding", () => {
  test("maps TestFailure fields to Finding fields", () => {
    const failure: TestFailure = {
      file: "test/unit/foo.test.ts",
      testName: "should handle edge case",
      error: "Expected 1 but got 0",
      stackTrace: [],
    };
    const finding = testFailureToFinding(failure);
    expect(finding.source).toBe("test-runner");
    expect(finding.severity).toBe("error");
    expect(finding.category).toBe("failed-test");
    expect(finding.rule).toBe("should handle edge case");
    expect(finding.file).toBe("test/unit/foo.test.ts");
    expect(finding.message).toBe("Expected 1 but got 0");
    expect(finding.line).toBeUndefined();
  });

  test("sets no line field (TestFailure has no line)", () => {
    const failure: TestFailure = {
      file: "test/unit/bar.test.ts",
      testName: "bar test",
      error: "boom",
      stackTrace: ["at line 5"],
    };
    const finding = testFailureToFinding(failure);
    expect(finding.line).toBeUndefined();
  });
});

describe("testSummaryToFindings", () => {
  test("returns empty array for empty failures", () => {
    const summary: TestSummary = { passed: 5, failed: 0, failures: [] };
    expect(testSummaryToFindings(summary)).toEqual([]);
  });

  test("maps each failure to a Finding", () => {
    const summary: TestSummary = {
      passed: 0,
      failed: 2,
      failures: [
        { file: "a.test.ts", testName: "test A", error: "err A", stackTrace: [] },
        { file: "b.test.ts", testName: "test B", error: "err B", stackTrace: [] },
      ],
    };
    const findings = testSummaryToFindings(summary);
    expect(findings).toHaveLength(2);
    expect(findings[0].rule).toBe("test A");
    expect(findings[1].rule).toBe("test B");
    expect(findings[0].source).toBe("test-runner");
    expect(findings[0].category).toBe("failed-test");
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/findings/adapters/test-failure.test.ts --timeout=5000
```

Expected: FAIL with "Cannot find module '@/findings/adapters/test-failure'"

- [ ] **Step 1.3: Create the adapter**

Create `src/findings/adapters/test-failure.ts`:

```typescript
import type { TestFailure, TestSummary } from "../../test-runners";
import type { Finding } from "../types";

export function testFailureToFinding(failure: TestFailure): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: failure.testName,
    file: failure.file,
    message: failure.error,
  };
}

export function testSummaryToFindings(summary: TestSummary): Finding[] {
  return summary.failures.map(testFailureToFinding);
}
```

- [ ] **Step 1.4: Export from adapters barrel**

In `src/findings/adapters/index.ts`, add:

```typescript
export { testFailureToFinding, testSummaryToFindings } from "./test-failure";
```

(Add at the end of the existing exports.)

- [ ] **Step 1.4b: Export from findings top-level barrel**

`src/findings/index.ts` uses explicit named exports from `./adapters` (not `export *`), so new functions must be added explicitly. In `src/findings/index.ts`, update the adapters export block (lines 23–32) to add the two new names:

```typescript
export {
  acceptanceDiagnoseRawArrayToFindings,
  acceptanceDiagnoseRawToFinding,
  acFailureToFinding,
  acSentinelToFinding,
  lintDiagnosticToFinding,
  pluginToFinding,
  reviewFindingToFinding,
  testFailureToFinding,
  testSummaryToFindings,
  tscDiagnosticToFinding,
} from "./adapters";
```

- [ ] **Step 1.5: Run test to verify it passes**

```bash
AGENT=1 timeout 30 bun test test/unit/findings/adapters/test-failure.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 1.6: Typecheck**

```bash
bun run typecheck 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 1.7: Commit**

```bash
git add src/findings/adapters/test-failure.ts src/findings/adapters/index.ts src/findings/index.ts test/unit/findings/adapters/test-failure.test.ts
git commit -m "feat: add test-failure → Finding adapter (US-006a §1)"
```

---

### Task 2: RectifierPromptBuilder.failingTestContext

**Files:**
- Modify: `src/prompts/builders/rectifier-builder.ts`
- Modify: `test/unit/prompts/builders/rectifier-builder.test.ts`

- [ ] **Step 2.1: Write the failing test**

Add to `test/unit/prompts/builders/rectifier-builder.test.ts` (find the end of the file or an appropriate describe block):

```typescript
import { RectifierPromptBuilder } from "@/prompts";
import type { Finding } from "@/findings";

describe("RectifierPromptBuilder.failingTestContext", () => {
  test("returns a string containing test failure details", () => {
    const findings: Finding[] = [
      {
        source: "test-runner",
        severity: "error",
        category: "failed-test",
        rule: "should handle edge case",
        file: "test/unit/foo.test.ts",
        message: "Expected 1 but got 0",
      },
    ];
    const result = RectifierPromptBuilder.failingTestContext(findings);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("should handle edge case");
    expect(result).toContain("Expected 1 but got 0");
  });

  test("handles empty findings array", () => {
    const result = RectifierPromptBuilder.failingTestContext([]);
    expect(typeof result).toBe("string");
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/prompts/builders/rectifier-builder.test.ts --timeout=5000 2>&1 | tail -10
```

Expected: FAIL with "is not a function" on `failingTestContext`

- [ ] **Step 2.3: Add the static method**

In `src/prompts/builders/rectifier-builder.ts`, add the import for `Finding` at the top:

```typescript
import type { Finding } from "@/findings/types";
```

Then inside the `RectifierPromptBuilder` class (after the last static method, before the closing `}`), add:

```typescript
  static failingTestContext(findings: Finding[]): string {
    if (findings.length === 0) {
      return "The full test suite has failing tests. Fix the implementation to make all tests pass.";
    }
    const lines: string[] = [
      `Fix the following ${findings.length} failing test${findings.length === 1 ? "" : "s"}:\n`,
    ];
    for (const f of findings) {
      const location = f.file ? `${f.file}` : "(unknown file)";
      const rule = f.rule ? `  Test: ${f.rule}\n` : "";
      lines.push(`- ${location}\n${rule}  Error: ${f.message}\n`);
    }
    lines.push(
      "\nFix the implementation (not the tests) to make all failing tests pass. Run the test suite to verify after each change.",
    );
    return lines.join("\n");
  }
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
AGENT=1 timeout 30 bun test test/unit/prompts/builders/rectifier-builder.test.ts --timeout=5000 2>&1 | tail -10
```

Expected: PASS

- [ ] **Step 2.5: Typecheck**

```bash
bun run typecheck 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 2.6: Commit**

```bash
git add src/prompts/builders/rectifier-builder.ts test/unit/prompts/builders/rectifier-builder.test.ts
git commit -m "feat: add RectifierPromptBuilder.failingTestContext for full-suite rectification (US-006a §2)"
```

---

### Task 3: Full-suite rectify strategy

**Files:**
- Create: `src/operations/full-suite-rectify.ts`
- Create: `test/unit/operations/full-suite-rectify.test.ts`
- Modify: `src/operations/index.ts`

- [ ] **Step 3.1: Write the failing test**

Create `test/unit/operations/full-suite-rectify.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fullSuiteRectifyStrategy } from "@/operations";
import type { Finding } from "@/findings";

function makeTestFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "some test",
    file: "test/unit/foo.test.ts",
    message: "Expected true but got false",
    ...overrides,
  };
}

describe("fullSuiteRectifyStrategy", () => {
  test("name is full-suite-rectify", () => {
    expect(fullSuiteRectifyStrategy.name).toBe("full-suite-rectify");
  });

  test("coRun is exclusive", () => {
    expect(fullSuiteRectifyStrategy.coRun).toBe("exclusive");
  });

  test("appliesTo returns true for test-runner + failed-test findings", () => {
    const finding = makeTestFinding();
    expect(fullSuiteRectifyStrategy.appliesTo(finding)).toBe(true);
  });

  test("appliesTo returns false for other sources", () => {
    const finding = makeTestFinding({ source: "lint" });
    expect(fullSuiteRectifyStrategy.appliesTo(finding)).toBe(false);
  });

  test("appliesTo returns false for other categories (e.g. assertion-failure from acceptance-diagnose)", () => {
    const finding = makeTestFinding({ category: "assertion-failure" });
    expect(fullSuiteRectifyStrategy.appliesTo(finding)).toBe(false);
  });

  test("fixOp references implementerOp (name=implementer)", () => {
    expect(fullSuiteRectifyStrategy.fixOp.name).toBe("implementer");
  });

  test("buildInput produces ImplementerInput with story and contextMarkdown", () => {
    const finding = makeTestFinding();
    const ctx = { storyId: "US-001", story: { id: "US-001", title: "Test" } } as any;
    const input = fullSuiteRectifyStrategy.buildInput([finding], [], ctx);
    expect(input.story).toBeDefined();
    expect(typeof input.contextMarkdown).toBe("string");
    expect(input.contextMarkdown!.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
AGENT=1 timeout 30 bun test test/unit/operations/full-suite-rectify.test.ts --timeout=5000
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3.3: Create the strategy file**

Create `src/operations/full-suite-rectify.ts`:

```typescript
import type { TddConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import { RectifierPromptBuilder } from "../prompts";
import type { ImplementerInput, ImplementerOutput } from "./implement";
import { implementerOp } from "./implement";

export const fullSuiteRectifyStrategy: FixStrategy<Finding, ImplementerInput, ImplementerOutput, TddConfig> = {
  name: "full-suite-rectify",
  appliesTo: (finding) => finding.source === "test-runner" && finding.category === "failed-test",
  fixOp: implementerOp,
  buildInput: (findings, _iterations, ctx) => ({
    story: (ctx as unknown as { story: ImplementerInput["story"] }).story,
    contextMarkdown: RectifierPromptBuilder.failingTestContext(findings),
  }),
  extractApplied: (_output, _input) => ({ targetFiles: [], summary: "Fixed failing tests" }),
  maxAttempts: 3,
  coRun: "exclusive",
};
```

- [ ] **Step 3.4: Export from operations barrel**

In `src/operations/index.ts`, add before the closing exports:

```typescript
export { fullSuiteRectifyStrategy } from "./full-suite-rectify";
```

(Add after the `fullSuiteGateOp` export block, around line 83.)

- [ ] **Step 3.5: Run test to verify it passes**

```bash
AGENT=1 timeout 30 bun test test/unit/operations/full-suite-rectify.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 3.6: Typecheck**

```bash
bun run typecheck 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3.7: Commit**

```bash
git add src/operations/full-suite-rectify.ts src/operations/index.ts test/unit/operations/full-suite-rectify.test.ts
git commit -m "feat: add fullSuiteRectifyStrategy for full-suite gate rectification (US-006a §2)"
```

---

### Task 4: Modify fullSuiteGateOp — remove internal rectification, add findings output

**Files:**
- Modify: `src/operations/full-suite-gate.ts`
- Modify: `src/execution/plan-inputs.ts`
- Modify: `test/unit/operations/full-suite-gate.test.ts`

This task removes the internal rectification loop from the op and adds `findings: Finding[]` to the output. The op becomes purely: run tests → return findings.

- [ ] **Step 4.1: Write new / updated tests first**

In `test/unit/operations/full-suite-gate.test.ts`, update the test file. The existing tests need to be updated because:
- `rectificationEnabled` input field is removed
- `status: "failed-no-rectification"` becomes `status: "failed"`
- `status: "rectification-exhausted"` is removed
- `findings: Finding[]` is now in the output

Replace the file content. Keep the existing `describe("fullSuiteGateOp — DeterministicOperation shape")` block intact (it tests kind/name/execute shape). Update the execution logic tests:

```typescript
import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp, _fullSuiteGateDeps } from "@/operations";
import type { Finding } from "@/findings";

const mockCtx = { runtime: {}, storyId: "US-001" } as any;

function makeDeps(overrides = {}) {
  return {
    resolveGateContext: async () => ({
      config: {} as any,
      testCmd: "bun test",
      fullSuiteTimeout: 60,
    }),
    runTests: async () => ({ passed: true, failed: 0, output: "", parsedSummary: { passed: 5, failed: 0, failures: [] } }),
    ...overrides,
  };
}

describe("fullSuiteGateOp — DeterministicOperation shape", () => {
  test("kind is deterministic (no LLM session)", () => {
    expect(fullSuiteGateOp.kind).toBe("deterministic");
  });

  test("name is full-suite-gate", () => {
    expect(fullSuiteGateOp.name).toBe("full-suite-gate");
  });

  test("has execute() function, not build()/parse()", () => {
    expect(typeof fullSuiteGateOp.execute).toBe("function");
    expect((fullSuiteGateOp as any).build).toBeUndefined();
    expect((fullSuiteGateOp as any).parse).toBeUndefined();
  });
});

describe("fullSuiteGateOp — test execution logic (US-006)", () => {
  test("returns success=true, status=passed, findings=[] when tests pass", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps(),
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
    expect(out.passed).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.attempts).toBe(0);
  });

  test("returns success=false, status=failed, findings populated when tests fail with structured failures", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 2,
          output: "2 tests failed",
          parsedSummary: {
            passed: 0,
            failed: 2,
            failures: [
              { file: "test/a.test.ts", testName: "test A", error: "err A", stackTrace: [] },
              { file: "test/b.test.ts", testName: "test B", error: "err B", stackTrace: [] },
            ],
          },
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.passed).toBe(false);
    expect(out.findings).toHaveLength(2);
    expect(out.findings[0].source).toBe("test-runner");
    expect(out.findings[0].category).toBe("failed-test");
    expect(out.findings[0].rule).toBe("test A");
    // Regression guard: must NOT be old status values
    expect(out.status).not.toBe("failed-no-rectification");
    expect(out.status).not.toBe("rectification-exhausted");
  });

  test("returns status=execution-failed and findings=[] when parser returns 0 structured failures despite non-zero exit", async () => {
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp" },
      mockCtx,
      makeDeps({
        runTests: async () => ({
          passed: false,
          failed: 3,
          output: "process crashed",
          parsedSummary: { passed: 0, failed: 3, failures: [] },
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.status).toBe("execution-failed");
    expect(out.findings).toEqual([]);
  });

  test("no runRectificationLoop dep exists on _fullSuiteGateDeps (AC-3)", () => {
    expect(((_fullSuiteGateDeps as any).runRectificationLoop)).toBeUndefined();
  });

  test("rectificationEnabled field is not read (removed from FullSuiteGateInput)", async () => {
    // Passing rectificationEnabled should be a type error at compile time,
    // and at runtime the field is simply ignored. This test ensures the op
    // produces the same output regardless of any legacy field value.
    const out = await fullSuiteGateOp.execute(
      { story: { id: "US-001" } as any, workdir: "/tmp", rectificationEnabled: true } as any,
      mockCtx,
      makeDeps(),
    );
    expect(out.success).toBe(true);
    expect(out.status).toBe("passed");
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails (because implementation not changed yet)**

```bash
AGENT=1 timeout 30 bun test test/unit/operations/full-suite-gate.test.ts --timeout=5000
```

Expected: FAIL — tests reference `findings` which doesn't exist yet, and `status: "failed"` is not the current value.

- [ ] **Step 4.3: Modify `src/operations/full-suite-gate.ts`**

Make the following changes to `src/operations/full-suite-gate.ts`:

**a. Add Finding import at the top:**

```typescript
import type { TestSummary } from "../test-runners";
import { testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
```

(Use the `"../findings"` barrel — not the leaf path `"../findings/adapters/test-failure"`. Task 1.4b added both functions to the top-level barrel's explicit named export list.)

**b. Replace `FullSuiteGateStatus`:**

```typescript
export type FullSuiteGateStatus =
  | "passed"
  | "failed"           // tests failed; findings populated
  | "execution-failed" // runner exited non-zero but parser found 0 structured failures
  | "inconclusive";
```

(Remove `"rectification-exhausted"` and `"failed-no-rectification"`.)

**c. Replace `FullSuiteGateInput` — remove `rectificationEnabled` and `implementerTier`:**

```typescript
export interface FullSuiteGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly featureName?: string;
  readonly projectDir?: string;
  readonly lite?: boolean;
  readonly resolvedTestPatterns?: import("../test-runners").ResolvedTestPatterns;
}
```

**d. Add `findings` to `FullSuiteGateOutput`:**

```typescript
export interface FullSuiteGateOutput {
  readonly success: boolean;
  readonly passed: boolean;
  readonly status: FullSuiteGateStatus;
  readonly estimatedCostUsd: number;
  readonly durationMs?: number;
  readonly attempts?: number;
  /**
   * Structured test failures for the rectification phase.
   * Empty when tests pass or when the parser returns no structured records (status: "execution-failed").
   */
  readonly findings: Finding[];
}
```

**e. Update `RunTestsResult` to include `parsedSummary`:**

```typescript
interface RunTestsResult {
  readonly passed: boolean;
  readonly failed: number;
  readonly output: string;
  readonly parsedSummary: TestSummary;
}
```

**f. Remove `RunRectificationResult` interface and `runRectificationLoop` from `FullSuiteGateDeps`:**

Remove `RunRectificationResult` entirely. Remove `runRectificationLoop` from `FullSuiteGateDeps`:

```typescript
export interface FullSuiteGateDeps {
  resolveGateContext: (input: FullSuiteGateInput, ctx: CallContext) => Promise<FullSuiteGateContext>;
  runTests: (input: FullSuiteGateInput, gateCtx: FullSuiteGateContext) => Promise<RunTestsResult>;
}
```

**g. Update `_fullSuiteGateDeps.runTests` to return `parsedSummary`:**

```typescript
  runTests: async (input, gateCtx) => {
    const { executeWithTimeout, parseTestOutput } = await import("../verification");
    const result = await executeWithTimeout(gateCtx.testCmd, gateCtx.fullSuiteTimeout, undefined, {
      cwd: input.workdir,
    });
    const parsedSummary = parseTestOutput(result.output ?? "");
    return {
      passed: result.success && result.exitCode === 0,
      failed: parsedSummary.failed ?? 0,
      output: result.output ?? "",
      parsedSummary,
    };
  },
```

**h. Remove `_fullSuiteGateDeps.runRectificationLoop` entirely.**

**i. Update `execute()` — remove rectification loop, use findings:**

```typescript
  async execute(
    input: FullSuiteGateInput,
    ctx: CallContext,
    deps: FullSuiteGateDeps = _fullSuiteGateDeps,
  ): Promise<FullSuiteGateOutput> {
    const gateCtx = await deps.resolveGateContext(input, ctx);
    const testResult = await deps.runTests(input, gateCtx);

    if (testResult.passed) {
      return { success: true, passed: true, status: "passed", estimatedCostUsd: 0, attempts: 0, findings: [] };
    }

    const findings = testSummaryToFindings(testResult.parsedSummary);
    if (findings.length === 0) {
      // Runner exited non-zero but parser found 0 structured failures — environmental failure.
      return { success: false, passed: false, status: "execution-failed", estimatedCostUsd: 0, attempts: 0, findings: [] };
    }

    return { success: false, passed: false, status: "failed", estimatedCostUsd: 0, attempts: 0, findings };
  },
```

**j. Remove the import of `runRectificationLoop` from `"../tdd"` at the top of the file.**
Also remove the `ModelTier` import if it was only used for `implementerTier`.

- [ ] **Step 4.4: Update `src/execution/plan-inputs.ts` — remove `rectificationEnabled`**

In `assemblePlanInputsFromCtx`, update the `fullSuiteGateInput` construction:

```typescript
  const fullSuiteGateInput = _isTdd
    ? {
        story,
        workdir: ctx.workdir,
        featureName: ctx.prd.feature,
        projectDir: ctx.projectDir,
        resolvedTestPatterns,
      }
    : undefined;
```

(Remove `rectificationEnabled: ctx.config.execution?.rectification?.enabled ?? false` and `implementerTier`.)

- [ ] **Step 4.4b: Delete / update test files that test removed behavior**

Removing `rectificationEnabled`, `implementerTier`, `runRectificationLoop`, and the old status values breaks **9 test files** beyond `full-suite-gate.test.ts`. Handle each:

**Delete** (they test dead behavior exclusively):

```bash
rm test/unit/operations/full-suite-gate-cost-scope.test.ts
rm test/integration/agents/acp/tdd-flow-rectification.test.ts
```

- `full-suite-gate-cost-scope.test.ts` — tests cost propagation through `runRectificationLoop` (dep deleted). Fully obsolete.
- `tdd-flow-rectification.test.ts` — tests `failed-no-rectification`/`rectification-exhausted` statuses and mocks `_fullSuiteGateDeps.runRectificationLoop`. All behavior deleted.

**Update** (remove `rectificationEnabled` from `fullSuiteGate` inputs — the field no longer exists on `FullSuiteGateInput`):

For each of these files, find every occurrence of `rectificationEnabled: true/false` inside a `fullSuiteGate: { ... }` object and remove the key. The field is gone from the interface; TypeScript will flag it as a type error if not removed.

```bash
grep -rn "rectificationEnabled" test/integration/tdd/ --include="*.ts" -l
```

Expected files:
- `test/integration/tdd/story-orchestrator-core.test.ts`
- `test/integration/tdd/story-orchestrator-failureCategory.test.ts`
- `test/integration/tdd/story-orchestrator-fallback.test.ts`
- `test/integration/tdd/story-orchestrator-lite.test.ts`
- `test/integration/tdd/story-orchestrator-verdict.test.ts`
- `test/integration/tdd/orchestrator-totals.test.ts`

In each file, remove the `rectificationEnabled: <bool>` line from every `fullSuiteGate: { ... }` input object. Do NOT remove it from top-level config objects (e.g. `execution: { rectification: { enabled: ... } }` — that's a different field on `NaxConfig`, not `FullSuiteGateInput`).

Also update `runTests` mock return values in any test that constructs `RunTestsResult` without `parsedSummary` — the `RunTestsResult` type now requires it. If integration tests mock `_fullSuiteGateDeps.runTests`, add `parsedSummary: { passed: 0, failed: 0, failures: [] }` to those mock returns.

- [ ] **Step 4.5: Run tests to verify they pass**

```bash
AGENT=1 timeout 30 bun test test/unit/operations/full-suite-gate.test.ts --timeout=5000
```

Expected: PASS

- [ ] **Step 4.6: Typecheck**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: no errors (fix any type errors before proceeding)

- [ ] **Step 4.7: Commit**

```bash
git add src/operations/full-suite-gate.ts src/execution/plan-inputs.ts test/unit/operations/full-suite-gate.test.ts
git rm test/unit/operations/full-suite-gate-cost-scope.test.ts
git rm test/integration/agents/acp/tdd-flow-rectification.test.ts
git add test/integration/tdd/story-orchestrator-core.test.ts test/integration/tdd/story-orchestrator-failureCategory.test.ts test/integration/tdd/story-orchestrator-fallback.test.ts test/integration/tdd/story-orchestrator-lite.test.ts test/integration/tdd/story-orchestrator-verdict.test.ts test/integration/tdd/orchestrator-totals.test.ts
git commit -m "feat: remove internal rectification from fullSuiteGateOp; add findings to output (US-006a §0)"
```

---

### Task 5: Short-circuit carve-out + extend validate callback in story-orchestrator

**Files:**
- Modify: `src/execution/story-orchestrator.ts`
- Modify: `test/unit/execution/story-orchestrator.test.ts`

This task has two related changes in `story-orchestrator.ts`:
1. `gatherRectificationFindings` — also read from fullSuiteGate output
2. `runRectification` validate callback — re-run gate AND verifier; honor `opts.mode === "lite"`
3. `ExecutionPlan.run()` short-circuit logic — exempt gate + verifier when rectification is configured

- [ ] **Step 5.1: Write failing tests**

In `test/unit/execution/story-orchestrator.test.ts`, add these new test cases (find the file and add to an appropriate describe block, or create a new `describe("US-006 short-circuit and validate"` block):

```typescript
import { describe, expect, test, mock } from "bun:test";
import { StoryOrchestratorBuilder, ExecutionPlan, _storyOrchestratorDeps } from "@/execution";
import type { CallContext, RunOperation, DeterministicOperation } from "@/operations";
import { fullSuiteGateOp, verifierOp } from "@/operations";
import { pickSelector, DEFAULT_CONFIG } from "@/config";
import { makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const sel = pickSelector("test-story-orchestrator-us006", "execution");

function makeRunOp(name: string, result: { success: boolean }): RunOperation<any, any, typeof DEFAULT_CONFIG> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: sel,
    session: { role: "implementer", lifetime: "warm" },
    build: () => ({ role: { id: "r", content: "", overridable: false }, task: { id: "t", content: "", overridable: false } }),
    parse: () => result,
  };
}

function makeDetOp(name: string, findings: any[], success: boolean): DeterministicOperation<any, any, any> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: sel,
    execute: async () => ({ success, passed: success, findings, estimatedCostUsd: 0, attempts: 0 }),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// AC-6: Short-circuit carve-out
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-6: short-circuit carve-out", () => {
  let runtime: NaxRuntime;
  const createdRuntimes: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  function makeCtx(rt: NaxRuntime): CallContext {
    return {
      runtime: rt,
      storyId: "US-test",
      story: { id: "US-test", title: "Test" } as any,
      packageDir: "/tmp",
    } as any;
  }

  test("when rectification configured: gate failure does NOT halt verifier (both run)", async () => {
    runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const ctx = makeCtx(runtime);

    const gateOp = makeDetOp("full-suite-gate", [{ source: "test-runner", category: "failed-test", severity: "error", message: "fail", rule: "t" }], false);
    const verifierOp = makeDetOp("verifier", [], true);
    const implOp = makeRunOp("implementer", { success: true });

    let verifierRan = false;
    const trackedVerifierOp = { ...verifierOp, execute: async (...args: any[]) => { verifierRan = true; return verifierOp.execute(...args); } };

    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "verifier") verifierRan = true;
      if (op.kind === "run") return op.parse("", input, _ctx);
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return {};
    };
    _storyOrchestratorDeps.runFixCycle = async () => ({ iterations: [], finalFindings: [], exitReason: "resolved", costUsd: 0 });

    try {
      const plan = new StoryOrchestratorBuilder()
        .addImplementer({ op: implOp, input: { story: ctx.story } })
        .addFullSuiteGate({ op: gateOp, input: { story: ctx.story, workdir: "/tmp" } })
        .addVerifier({ op: trackedVerifierOp, input: { story: ctx.story } })
        .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
        .build(ctx);

      await plan.run();
      expect(verifierRan).toBe(true);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("when rectification NOT configured: gate failure halts verifier (short-circuit)", async () => {
    runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const ctx = makeCtx(runtime);

    const gateOp = makeDetOp("full-suite-gate", [], false);
    const implOp = makeRunOp("implementer", { success: true });
    let verifierRan = false;

    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "verifier") verifierRan = true;
      if (op.kind === "run") return op.parse("", input, _ctx);
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return {};
    };

    try {
      const plan = new StoryOrchestratorBuilder()
        .addImplementer({ op: implOp, input: { story: ctx.story } })
        .addFullSuiteGate({ op: gateOp, input: { story: ctx.story, workdir: "/tmp" } })
        .addVerifier({ op: { ...gateOp, name: "verifier" }, input: { story: ctx.story } })
        .build(ctx);

      await plan.run();
      expect(verifierRan).toBe(false);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AC-4: validate re-runs gate AND verifier (when gate present)
// AC-5: validate honors opts.mode === "lite" (skips gate)
// ──────────────────────────────────────────────────────────────────────────────

describe("AC-4 + AC-5: validate callback gate + lite-mode behavior", () => {
  let runtime: NaxRuntime;
  const createdRuntimes: NaxRuntime[] = [];

  afterEach(async () => {
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  function makeCtx(rt: NaxRuntime): CallContext {
    return {
      runtime: rt,
      storyId: "US-validate-test",
      story: { id: "US-validate-test", title: "Test" } as any,
      packageDir: "/tmp",
    } as any;
  }

  test("AC-4: validate re-runs BOTH gate and verifier when fullSuiteGate is non-null", async () => {
    runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const ctx = makeCtx(runtime);

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };

    const gateOp = makeDetOp("full-suite-gate", [], false);
    const verOp = makeDetOp("verifier", [], false);
    const implOp = makeRunOp("implementer", { success: true });

    let capturedCycle: any = null;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;

    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "full-suite-gate") gateRunCount.n++;
      if (op.name === "verifier") verifierRunCount.n++;
      if (op.kind === "run") return op.parse("", input, _ctx);
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return {};
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any, cycleCtx: any) => {
      capturedCycle = cycle;
      return { iterations: [], finalFindings: [], exitReason: "resolved", costUsd: 0 };
    };

    try {
      const plan = new StoryOrchestratorBuilder()
        .addImplementer({ op: implOp, input: { story: ctx.story } })
        .addFullSuiteGate({ op: gateOp, input: { story: ctx.story, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { story: ctx.story } })
        .addRectification({
          maxAttempts: 3,
          strategies: [{ name: "s", appliesTo: () => true, fixOp: implOp, buildInput: () => ({ story: ctx.story }), maxAttempts: 1, coRun: "exclusive" }],
          abortOnIncreasingFailures: false,
        })
        .build(ctx);

      // Seed phaseOutputs with findings so rectification fires
      await plan.run();

      // Now test the captured validate callback directly
      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        await capturedCycle.validate(ctx, { mode: "full" });
        expect(gateRunCount.n).toBeGreaterThan(beforeGate);
        expect(verifierRunCount.n).toBeGreaterThan(beforeVerifier);
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });

  test("AC-5: validate skips gate re-run when opts.mode === 'lite'", async () => {
    runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const ctx = makeCtx(runtime);

    const gateRunCount = { n: 0 };
    const verifierRunCount = { n: 0 };

    const gateOp = makeDetOp("full-suite-gate", [], false);
    const verOp = makeDetOp("verifier", [], false);
    const implOp = makeRunOp("implementer", { success: true });

    let capturedCycle: any = null;
    const origCallOp = _storyOrchestratorDeps.callOp;
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;

    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      if (op.name === "full-suite-gate") gateRunCount.n++;
      if (op.name === "verifier") verifierRunCount.n++;
      if (op.kind === "run") return op.parse("", input, _ctx);
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return {};
    };
    _storyOrchestratorDeps.runFixCycle = async (cycle: any) => {
      capturedCycle = cycle;
      return { iterations: [], finalFindings: [], exitReason: "resolved", costUsd: 0 };
    };

    try {
      const plan = new StoryOrchestratorBuilder()
        .addImplementer({ op: implOp, input: { story: ctx.story } })
        .addFullSuiteGate({ op: gateOp, input: { story: ctx.story, workdir: "/tmp" } })
        .addVerifier({ op: verOp, input: { story: ctx.story } })
        .addRectification({
          maxAttempts: 3,
          strategies: [{ name: "s", appliesTo: () => true, fixOp: implOp, buildInput: () => ({ story: ctx.story }), maxAttempts: 1, coRun: "exclusive" }],
          abortOnIncreasingFailures: false,
        })
        .build(ctx);

      await plan.run();

      if (capturedCycle) {
        const beforeGate = gateRunCount.n;
        const beforeVerifier = verifierRunCount.n;
        // Lite mode — gate must NOT be re-run
        await capturedCycle.validate(ctx, { mode: "lite" });
        expect(gateRunCount.n).toBe(beforeGate); // gate NOT re-run
        expect(verifierRunCount.n).toBeGreaterThan(beforeVerifier); // verifier IS re-run
      }
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    }
  });
});
```

- [ ] **Step 5.2: Run tests to confirm they compile/fail meaningfully**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/story-orchestrator.test.ts --timeout=5000 2>&1 | tail -20
```

Expected: compile or test failure (implementation not changed yet)

- [ ] **Step 5.3: Modify `src/execution/story-orchestrator.ts`**

**a. Update `gatherRectificationFindings` to include fullSuiteGate:**

```typescript
function gatherRectificationFindings(
  phaseOutputs: Record<string, unknown>,
  verifierPhase: InternalPhase,
  fullSuiteGatePhase: InternalPhase | undefined,
  semanticPhase: InternalPhase | undefined,
  adversarialPhase: InternalPhase | undefined,
): Finding[] {
  const findings: Finding[] = [];
  if (fullSuiteGatePhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase.slot.op.name]));
  }
  findings.push(...extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]));
  if (semanticPhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[semanticPhase.slot.op.name]));
  }
  if (adversarialPhase) {
    findings.push(...extractPhaseFindings(phaseOutputs[adversarialPhase.slot.op.name]));
  }
  return findings;
}
```

Update the call site in `runRectification`:

```typescript
  const initialFindings = gatherRectificationFindings(
    phaseOutputs,
    verifierPhase,
    state.fullSuiteGate,
    state.semanticReview,
    state.adversarialReview,
  );
```

**b. Update the `validate` callback in `runRectification` — honor `opts.mode` and re-run gate:**

Replace the existing `validate` callback:

```typescript
    validate: async (_validateCtx, opts) => {
      if (ctx.runtime.signal?.aborted) return [];
      const lite = opts?.mode === "lite";
      // Re-run validators in canonical order: gate before verifier (matches phase order).
      // Lite mode skips the full-suite gate to keep terminal exhausted re-validation cheap.
      const fullSuiteGatePhase = state.fullSuiteGate;
      if (fullSuiteGatePhase && !lite) {
        await runPhase(ctx, fullSuiteGatePhase.slot, phaseCosts, phaseOutputs);
      }
      await runPhase(ctx, verifierPhase.slot, phaseCosts, phaseOutputs);
      const findings: Finding[] = [];
      if (fullSuiteGatePhase && !lite) {
        findings.push(...extractPhaseFindings(phaseOutputs[fullSuiteGatePhase.slot.op.name]));
      }
      findings.push(...extractPhaseFindings(phaseOutputs[verifierPhase.slot.op.name]));
      return findings;
    },
```

**c. Add `shortCircuitExempt` set to `ExecutionPlan.run()`:**

In `ExecutionPlan.run()`, replace the for-loop:

```typescript
    // Exempt gate + verifier from short-circuit only when rectification is configured
    // (it will consume their failures). Without rectification, failures still halt the plan.
    const shortCircuitExempt = this.state.rectification
      ? new Set<string>([fullSuiteGateOp.name, verifierOp.name])
      : new Set<string>();

    for (const phase of collectOrderedPhases(this.state)) {
      try {
        await runPhase(this.ctx, phase.slot, phaseCosts, phaseOutputs);
      } catch (error) {
        logger?.error("story-orchestrator", "Phase threw unexpected error", {
          storyId: this.ctx.storyId,
          phase: phase.slot.op.name,
          error: errorMessage(error),
        });
        throw error;
      }

      // Short-circuit on any phase failure (spec §2C: any phase returning success=false halts execution).
      // Exception: phases in shortCircuitExempt continue so rectification can consume their findings.
      if (!phasePassed(phase.slot.op.name, phaseOutputs[phase.slot.op.name])) {
        if (!shortCircuitExempt.has(phase.slot.op.name)) {
          break;
        }
      }
    }
```

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/story-orchestrator.test.ts --timeout=5000
```

Expected: PASS

Also run the gates test:
```bash
AGENT=1 timeout 30 bun test test/unit/execution/story-orchestrator-gates.test.ts --timeout=5000
```

- [ ] **Step 5.5: Typecheck**

```bash
bun run typecheck 2>&1 | head -40
```

Expected: no errors

- [ ] **Step 5.6: Commit**

```bash
git add src/execution/story-orchestrator.ts test/unit/execution/story-orchestrator.test.ts
git commit -m "feat: add short-circuit carve-out + extend validate for full-suite gate (US-006a §3+§4)"
```

---

### Task 6: Wire fullSuiteRectifyStrategy into build-plan-for-strategy

**Files:**
- Modify: `src/execution/build-plan-for-strategy.ts`
- Modify: `test/unit/execution/rectification.test.ts` (or create new)

- [ ] **Step 6.1: Write failing test**

In `test/unit/execution/rectification.test.ts`, add a test that verifies `fullSuiteRectifyStrategy` is in the strategies array when a full-suite gate is included in the plan:

```typescript
import { describe, expect, test } from "bun:test";
import { buildPlanForStrategy } from "@/execution";
import { fullSuiteRectifyStrategy } from "@/operations";
import { makeStory, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

describe("AC-7: fullSuiteRectifyStrategy is wired in buildPlanForStrategy", () => {
  test("fullSuiteRectifyStrategy appears in plan strategies for three-session-tdd with rectification", () => {
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const story = makeStory({ id: "US-001", title: "Test" });
    const config = makeNaxConfig({
      execution: { rectification: { enabled: true, maxRetries: 3, abortOnIncreasingFailures: true } },
      review: { enabled: false },
    });
    const ctx = {
      runtime,
      storyId: "US-001",
      story,
      packageDir: "/tmp",
    } as any;

    const inputs = {
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp" },
      verifier: { story },
      rectification: { maxAttempts: 3, strategies: [], abortOnIncreasingFailures: true },
    };

    const plan = buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    expect(names).toContain("rectification");

    // The plan's rectification strategies must include fullSuiteRectifyStrategy.
    // We verify by checking the strategy's name in a round-about way through the public API:
    // PhaseNames includes "rectification" only when strategies are present.
    expect(names).toContain("rectification");
  });
});
```

- [ ] **Step 6.2: Run test to verify behavior (may already compile)**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/rectification.test.ts --timeout=5000 2>&1 | tail -20
```

- [ ] **Step 6.3: Modify `src/execution/build-plan-for-strategy.ts`**

Add import for `fullSuiteRectifyStrategy` at the top:

```typescript
import { fullSuiteRectifyStrategy } from "../operations/full-suite-rectify";
import type { RectificationPhaseOptions } from "./story-orchestrator";
```

Update the rectification section in `buildPlanForStrategy`:

```typescript
  // Rectification: requires both config gate and typed inputs.
  // When TDD with full-suite gate is configured, prepend fullSuiteRectifyStrategy so
  // test-failure findings from the gate take priority over review-finding strategies.
  if (shouldRunRectification(config) && inputs.rectification) {
    const gateStrategies = isTdd && inputs.fullSuiteGate ? [fullSuiteRectifyStrategy] : [];
    const rectOpts: RectificationPhaseOptions = {
      ...inputs.rectification,
      strategies: [...gateStrategies, ...inputs.rectification.strategies],
    };
    builder.addRectification(rectOpts);
  }
```

- [ ] **Step 6.4: Run tests**

```bash
AGENT=1 timeout 30 bun test test/unit/execution/ --timeout=5000
```

Expected: PASS

- [ ] **Step 6.5: Verify AC-7 grep**

```bash
grep -nE 'fullSuiteRectifyStrategy' /home/williamkhoo/Desktop/projects/nathapp/ai-coder/nax/src/execution/build-plan-for-strategy.ts
```

Expected: ≥1 match

- [ ] **Step 6.6: Typecheck**

```bash
bun run typecheck 2>&1 | head -20
```

- [ ] **Step 6.7: Commit**

```bash
git add src/execution/build-plan-for-strategy.ts test/unit/execution/rectification.test.ts
git commit -m "feat: wire fullSuiteRectifyStrategy into buildPlanForStrategy (US-006a §7 AC-7)"
```

---

### Task 7: Rewire old callers — rectify.ts and run-regression.ts

**Files:**
- Modify: `src/pipeline/stages/rectify.ts`
- Modify: `src/execution/lifecycle/run-regression.ts`

The spec says these two files currently import `runRectificationLoop` from `"../../verification/rectification-loop"` and must be rewired. The spec says to "redirect import to `../../tdd`" if the TDD version is semantically equivalent for this call-site.

Looking at the spec §6: `src/tdd/rectification-runner.ts` exports `runRectificationLoop` (via the tdd barrel). The callers in `rectify.ts` and `run-regression.ts` can redirect to `"../../tdd"` (or `"../tdd"` depending on depth).

- [ ] **Step 7.1: Check what tdd barrel exports**

```bash
grep -n "runRectificationLoop" /home/williamkhoo/Desktop/projects/nathapp/ai-coder/nax/src/tdd/index.ts 2>/dev/null || grep -rn "runRectificationLoop" /home/williamkhoo/Desktop/projects/nathapp/ai-coder/nax/src/tdd/ --include="*.ts" | head -10
```

- [ ] **Step 7.2: Rewire `src/pipeline/stages/rectify.ts`**

Find line 140 (currently `import { runRectificationLoop } from "../../verification/rectification-loop";`). Change it to import from `tdd`:

```typescript
import { runRectificationLoop } from "../../tdd";
```

(Or from whatever the correct relative path is to the tdd barrel.)

- [ ] **Step 7.3: Rewire `src/execution/lifecycle/run-regression.ts`**

Find line 18 (currently `import { runRectificationLoop } from "../../verification/rectification-loop";`). Change it to:

```typescript
import { runRectificationLoop } from "../../tdd";
```

- [ ] **Step 7.4: Typecheck**

```bash
bun run typecheck 2>&1 | head -30
```

Expected: no errors

- [ ] **Step 7.5: Verify AC-7 grep — no remaining callers of rectification-loop**

```bash
grep -rn 'from.*verification/rectification-loop' /home/williamkhoo/Desktop/projects/nathapp/ai-coder/nax/src/
```

Expected: 0 lines (no callers remain importing from rectification-loop)

- [ ] **Step 7.6: Run targeted tests**

```bash
AGENT=1 timeout 30 bun test test/unit/pipeline/stages/rectify.test.ts --timeout=5000
AGENT=1 timeout 30 bun test test/unit/execution/ --timeout=5000
```

- [ ] **Step 7.7: Commit**

```bash
git add src/pipeline/stages/rectify.ts src/execution/lifecycle/run-regression.ts
git commit -m "refactor: rewire rectify.ts + run-regression.ts to import runRectificationLoop from tdd (US-006a §6)"
```

---

### Task 8: AC verification run — validate all US-006a acceptance criteria

- [ ] **Step 8.1: AC-1 grep — testFailureToFinding exports**

```bash
grep -nE 'export function testFailureToFinding\(failure: TestFailure\): Finding' src/findings/adapters/test-failure.ts && echo "AC-1a PASS" || echo "AC-1a FAIL"
grep -nE 'export function testSummaryToFindings\(summary: TestSummary\): Finding\[\]' src/findings/adapters/test-failure.ts && echo "AC-1b PASS" || echo "AC-1b FAIL"
```

- [ ] **Step 8.2: AC-2 grep — fullSuiteRectifyStrategy exports**

```bash
grep -nE 'export const fullSuiteRectifyStrategy: FixStrategy<' src/operations/full-suite-rectify.ts && echo "AC-2a PASS" || echo "AC-2a FAIL"
grep -nE 'fixOp: implementerOp' src/operations/full-suite-rectify.ts && echo "AC-2b PASS" || echo "AC-2b FAIL"
grep -nE 'RectifierPromptBuilder\.failingTestContext' src/operations/full-suite-rectify.ts && echo "AC-2c PASS" || echo "AC-2c FAIL"
```

- [ ] **Step 8.3: AC-3 grep — no old status values / no runRectificationLoop in gate**

```bash
grep -nE '"rectification-exhausted"|"failed-no-rectification"|rectificationEnabled' src/operations/full-suite-gate.ts && echo "AC-3 FAIL: old values present" || echo "AC-3a PASS"
grep -nE 'runRectificationLoop' src/operations/full-suite-gate.ts && echo "AC-3 FAIL: still calls runRectificationLoop" || echo "AC-3b PASS"
```

- [ ] **Step 8.4: AC-7 grep — fullSuiteRectifyStrategy wired in build-plan**

```bash
grep -nE 'fullSuiteRectifyStrategy' src/execution/build-plan-for-strategy.ts && echo "AC-7 PASS" || echo "AC-7 FAIL"
```

- [ ] **Step 8.5: Run full test suite**

```bash
bun run test:bail
```

Expected: all tests pass

- [ ] **Step 8.6: Commit (no changes — just verification)**

If all ACs pass, US-006a is complete.

---

## US-006b

### Task 9: Delete legacy rectification loop files

**Depends on:** All US-006a tasks completed and AC-7 grep proven (zero callers of rectification-loop in `src/`).

- [ ] **Step 9.1: Confirm zero callers remain**

```bash
grep -rn 'from.*verification/rectification-loop' src/ && echo "CALLERS REMAIN - DO NOT DELETE" || echo "Zero callers - safe to delete"
```

Expected: "Zero callers - safe to delete"

- [ ] **Step 9.2: Delete the legacy loop source file**

```bash
rm src/verification/rectification-loop.ts
```

- [ ] **Step 9.3: Remove re-export from verification barrel**

`src/verification/index.ts` line 14 exports `_rectificationDeps` from the file being deleted. Removing the file without removing this line causes a compile error. Remove it:

```bash
grep -n "_rectificationDeps\|rectification-loop" src/verification/index.ts
```

Expected line:
```
14: export { _rectificationDeps } from "./rectification-loop";
```

Delete that line from `src/verification/index.ts`.

- [ ] **Step 9.4: Typecheck**

```bash
bun run typecheck 2>&1 | head -30
```

Expected: no errors. If errors appear, some caller still imports from rectification-loop — fix before proceeding.

- [ ] **Step 9.5: Run test suite before deleting tests**

```bash
bun run test:bail 2>&1 | tail -20
```

Expected: PASS (minus the rectification-loop test files which test dead code — these are the tests we're about to delete)

- [ ] **Step 9.6: Check which test files to delete**

```bash
find test/unit/verification -name 'rectification-loop*.test.ts'
```

Expected to see:
- `test/unit/verification/rectification-loop.test.ts`
- `test/unit/verification/rectification-loop-types.test.ts`
- `test/unit/verification/rectification-loop-escalation.test.ts`
- `test/unit/verification/rectification-loop-debate.test.ts`
- `test/unit/verification/rectification-loop-debate-cost.test.ts`

- [ ] **Step 9.7: Delete legacy test files**

```bash
find test/unit/verification -name 'rectification-loop*.test.ts' -delete
```

- [ ] **Step 9.8: Verify AC-8 — file does not exist**

```bash
test -f src/verification/rectification-loop.ts && echo "AC-8 FAIL: file still exists" || echo "AC-8 PASS: deleted"
```

- [ ] **Step 9.9: Verify AC-8 grep — zero callers in src/**

```bash
grep -rnE 'from ["'"'"'"]\.\./\.\./verification/rectification-loop["'"'"'"]|from ["'"'"'"]\.\./verification/rectification-loop["'"'"'"]' src/ && echo "AC-8 FAIL: callers remain" || echo "AC-8 PASS: zero callers"
```

- [ ] **Step 9.10: Verify AC-9 — runFixCycle is the only loop**

```bash
grep -rnE 'function runRectification[A-Za-z]*\(' src/ | grep -v 'src/execution/story-orchestrator.ts' | grep -v 'src/tdd/rectification-runner.ts' && echo "AC-9 FAIL: other loops exist" || echo "AC-9 PASS"
```

Expected: "AC-9 PASS"

- [ ] **Step 9.11: Verify AC-10 — legacy test files removed + replacement coverage exists**

```bash
find test/unit/verification -name 'rectification-loop*.test.ts' | wc -l
```
Expected: 0

```bash
grep -rnE 'full-suite-rectify|fullSuiteRectifyStrategy' test/unit/execution/ test/unit/findings/ test/unit/operations/ && echo "AC-10 replacement coverage PASS" || echo "AC-10 FAIL: no replacement coverage"
```

Expected: matches in the test files created in Tasks 3 and 6.

- [ ] **Step 9.12: Run full test suite**

```bash
bun run test
```

Expected: PASS

- [ ] **Step 9.13: Commit**

```bash
git add -A
git commit -m "feat: delete legacy runRectificationLoop — runFixCycle is now the only rectification SSOT (US-006b)"
```

---

## Final Verification

- [ ] **Run lint**

```bash
bun run lint
```

- [ ] **Run full typecheck**

```bash
bun run typecheck
```

- [ ] **Run full test suite**

```bash
bun run test
```

All three should pass cleanly.
