/**
 * Tests for autofix-adversarial helpers (#409 post-review fixes)
 *
 * Covers:
 * - splitAdversarialFindingsByScope: test-file vs source-file bucket classification
 * - Edge cases: no findings, all test, all source, mixed, file:undefined, non-adversarial check
 * - Raw output preservation — scoped check retains original check.output
 * - runTestWriterRectification: success, agent unavailable, agent throws
 */

import { describe, expect, mock, test, afterEach } from "bun:test";
import {
  TEST_FILE_PATTERN,
  splitAdversarialFindingsByScope,
  runTestWriterRectification,
} from "../../../../src/pipeline/stages/autofix-adversarial";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { ReviewCheckResult } from "../../../../src/review/types";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewFinding } from "../../../../src/plugins/extensions";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeFinding(file: string, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    ruleId: "no-unused-vars",
    severity: "error",
    file,
    line: 1,
    message: `Issue in ${file}`,
    ...overrides,
  };
}

function makeAdversarialCheck(
  findings: ReviewFinding[],
  output = "adversarial review output",
): ReviewCheckResult {
  return {
    check: "adversarial",
    success: false,
    command: "adversarial-review",
    exitCode: 1,
    output,
    durationMs: 100,
    findings,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    config: DEFAULT_CONFIG as any,
    prd: { feature: "my-feature", stories: [] } as any,
    story: { id: "US-001", title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test",
    projectDir: "/tmp/test",
    hooks: { hooks: {} } as any,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST_FILE_PATTERN
// ─────────────────────────────────────────────────────────────────────────────

describe("TEST_FILE_PATTERN", () => {
  test.each([
    "src/foo.test.ts",
    "src/bar.spec.ts",
    "test/unit/foo.test.js",
    "src/foo.test.tsx",
    "src/bar.spec.jsx",
  ])("matches test file: %s", (file) => {
    expect(TEST_FILE_PATTERN.test(file)).toBe(true);
  });

  test.each([
    "src/foo.ts",
    "src/bar.js",
    "src/foo.tsx",
    "src/test-utils.ts",
    "src/testing/helpers.ts",
  ])("does not match source file: %s", (file) => {
    expect(TEST_FILE_PATTERN.test(file)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitAdversarialFindingsByScope
// ─────────────────────────────────────────────────────────────────────────────

describe("splitAdversarialFindingsByScope", () => {
  test("non-adversarial check → both buckets null", () => {
    const check: ReviewCheckResult = {
      check: "lint",
      success: false,
      command: "biome",
      exitCode: 1,
      output: "lint error",
      durationMs: 10,
      findings: [makeFinding("src/foo.test.ts")],
    };
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("adversarial check with no findings → both buckets null", () => {
    const check = makeAdversarialCheck([]);
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("adversarial check with undefined findings → both buckets null", () => {
    const check: ReviewCheckResult = {
      check: "adversarial",
      success: false,
      command: "adversarial-review",
      exitCode: 1,
      output: "output",
      durationMs: 10,
    };
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("all test-file findings → testFindings non-null, sourceFindings null", () => {
    const findings = [makeFinding("src/auth.test.ts"), makeFinding("test/unit/foo.spec.ts")];
    const check = makeAdversarialCheck(findings);
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(testFindings!.findings).toHaveLength(2);
    expect(sourceFindings).toBeNull();
  });

  test("all source-file findings → sourceFindings non-null, testFindings null", () => {
    const findings = [makeFinding("src/auth.ts"), makeFinding("src/utils/helpers.ts")];
    const check = makeAdversarialCheck(findings);
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
    expect(sourceFindings!.findings).toHaveLength(2);
  });

  test("mixed findings → both buckets populated with correct subsets", () => {
    const findings = [
      makeFinding("src/auth.ts"),
      makeFinding("src/auth.test.ts"),
      makeFinding("src/utils.ts"),
      makeFinding("test/unit/auth.spec.ts"),
    ];
    const check = makeAdversarialCheck(findings);
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);

    expect(testFindings!.findings).toHaveLength(2);
    expect(testFindings!.findings!.map((f) => f.file)).toEqual(["src/auth.test.ts", "test/unit/auth.spec.ts"]);
    expect(sourceFindings!.findings).toHaveLength(2);
    expect(sourceFindings!.findings!.map((f) => f.file)).toEqual(["src/auth.ts", "src/utils.ts"]);
  });

  test("finding with file:undefined is treated as source-file (non-test)", () => {
    const finding: ReviewFinding = { ruleId: "r", severity: "error", file: undefined as any, line: 1, message: "m" };
    const check = makeAdversarialCheck([finding]);
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
    expect(sourceFindings!.findings).toHaveLength(1);
  });

  test("scoped checks preserve original raw output from parent check", () => {
    const rawOutput = "adversarial tool raw output with stack trace\n  at line 42\n  at line 100";
    const findings = [makeFinding("src/foo.ts"), makeFinding("src/foo.test.ts")];
    const check = makeAdversarialCheck(findings, rawOutput);
    const { testFindings, sourceFindings } = splitAdversarialFindingsByScope(check);

    expect(testFindings!.output).toBe(rawOutput);
    expect(sourceFindings!.output).toBe(rawOutput);
  });

  test("scoped check exitCode is inherited from parent check", () => {
    const findings = [makeFinding("src/foo.ts")];
    const check = makeAdversarialCheck(findings);
    const { sourceFindings } = splitAdversarialFindingsByScope(check);
    expect(sourceFindings!.exitCode).toBe(check.exitCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runTestWriterRectification
// ─────────────────────────────────────────────────────────────────────────────

describe("runTestWriterRectification", () => {
  afterEach(() => {
    mock.restore();
  });

  const story = {
    id: "US-001",
    title: "Test story",
    status: "in-progress",
    acceptanceCriteria: ["AC1"],
  } as any;

  test("returns cost from agent on success", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const mockRun = mock(async () => ({ estimatedCost: 0.05, success: true, output: "done", exitCode: 0, rateLimited: false }));
    const agentGetFn = mock(() => ({ run: mockRun }));
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentGetFn as any);

    expect(cost).toBe(0.05);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  test("returns 0 when agent is not found (agentGetFn returns null)", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const agentGetFn = mock(() => null);
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentGetFn as any);

    expect(cost).toBe(0);
  });

  test("returns 0 and does not rethrow when agent.run throws", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const mockRun = mock(async () => { throw new Error("agent session error"); });
    const agentGetFn = mock(() => ({ run: mockRun }));
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentGetFn as any);

    expect(cost).toBe(0);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  test("uses config.tdd.sessionTiers.testWriter for model tier", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    let capturedModelTier = "";
    const mockRun = mock(async (opts: any) => {
      capturedModelTier = opts.modelTier;
      return { estimatedCost: 0, success: true, output: "", exitCode: 0, rateLimited: false };
    });
    const agentGetFn = mock(() => ({ run: mockRun }));
    const ctx = makeCtx({
      rootConfig: {
        ...DEFAULT_CONFIG,
        tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: { testWriter: "fast" } },
      } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentGetFn as any);

    expect(capturedModelTier).toBe("fast");
  });

  test("defaults to 'balanced' model tier when sessionTiers.testWriter is not configured", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    let capturedModelTier = "";
    const mockRun = mock(async (opts: any) => {
      capturedModelTier = opts.modelTier;
      return { estimatedCost: 0, success: true, output: "", exitCode: 0, rateLimited: false };
    });
    const agentGetFn = mock(() => ({ run: mockRun }));
    const ctx = makeCtx({
      rootConfig: { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: undefined } } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentGetFn as any);

    expect(capturedModelTier).toBe("balanced");
  });
});
