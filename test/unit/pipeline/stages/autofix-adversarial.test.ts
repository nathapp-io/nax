/**
 * Tests for autofix-adversarial helpers (#409, #669)
 *
 * Covers:
 * - extractFilesFromLintOutput: ESLint stylish/compact + Biome format parsing
 * - splitFindingsByScope (replaces splitAdversarialFindingsByScope):
 *   - Structured findings path (adversarial checks)
 *   - Output parsing path (lint checks)
 * - runTestWriterRectification: success, agent unavailable, agent throws
 */

import { describe, expect, mock, test, afterEach } from "bun:test";
import {
  extractFilesFromLintOutput,
  splitFindingsByScope,
  runTestWriterRectification,
} from "../../../../src/pipeline/stages/autofix-adversarial";
import { isTestFile } from "../../../../src/test-runners";
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

function makeLintCheck(output: string): ReviewCheckResult {
  return {
    check: "lint",
    success: false,
    command: "biome",
    exitCode: 1,
    output,
    durationMs: 10,
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
// isTestFile (sanity check)
// ─────────────────────────────────────────────────────────────────────────────

describe("isTestFile", () => {
  test.each([
    "src/foo.test.ts",
    "src/bar.spec.ts",
    "test/unit/foo.test.js",
    "src/foo.test.tsx",
    "src/bar.spec.jsx",
    "rag_service_test.go",
    "tests/integration/foo_test.rs",
    "test_rag_service.py",
  ])("matches test file: %s", (file) => {
    expect(isTestFile(file)).toBe(true);
  });

  test.each([
    "src/foo.ts",
    "src/bar.js",
    "src/foo.tsx",
    "src/test-utils.ts",
    "src/testing/helpers.ts",
  ])("does not match source file: %s", (file) => {
    expect(isTestFile(file)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractFilesFromLintOutput
// ─────────────────────────────────────────────────────────────────────────────

describe("extractFilesFromLintOutput", () => {
  test("empty string → empty array", () => {
    expect(extractFilesFromLintOutput("")).toEqual([]);
  });

  test("whitespace-only string → empty array", () => {
    expect(extractFilesFromLintOutput("   \n  \n")).toEqual([]);
  });

  test("unparseable output (no file paths) → empty array", () => {
    const output = "Lint failed\nSome warnings\nPlease fix the errors above\n";
    expect(extractFilesFromLintOutput(output)).toEqual([]);
  });

  test("ESLint stylish format — file header line", () => {
    const output = `
src/foo.test.ts
  1:5   error  Non-null assertion  @typescript-eslint/no-non-null-assertion
`.trim();
    const files = extractFilesFromLintOutput(output);
    expect(files).toContain("src/foo.test.ts");
  });

  test("Biome stylish format — path:line:col prefix", () => {
    const output = `
src/entity-store.integration.spec.ts:232:26 lint/suspicious/noNonNullAssertion ━━━━━
  ✖ Non-null assertion operator is forbidden.
  232 │ const result = store.search(projectId, "foo")!;
`.trim();
    const files = extractFilesFromLintOutput(output);
    expect(files).toContain("src/entity-store.integration.spec.ts");
  });

  test("ESLint compact format — path:line:col: severity", () => {
    const output = "src/foo.test.ts:1:5: error  Non-null assertion  @typescript-eslint/no-non-null-assertion";
    const files = extractFilesFromLintOutput(output);
    expect(files).toContain("src/foo.test.ts");
  });

  test("multiple test files deduplicated", () => {
    const output = `
src/foo.test.ts:1:5 lint/error
src/foo.test.ts:2:8 lint/error
src/bar.spec.ts:10:3 lint/error
`.trim();
    const files = extractFilesFromLintOutput(output);
    expect(files).toContain("src/foo.test.ts");
    expect(files).toContain("src/bar.spec.ts");
    // deduplicated — foo.test.ts appears only once
    expect(files.filter((f) => f === "src/foo.test.ts")).toHaveLength(1);
  });

  test("mixed test and source files extracted", () => {
    const output = `
src/service.ts:10:3 lint/error message
test/unit/service.test.ts:5:1 lint/error message
`.trim();
    const files = extractFilesFromLintOutput(output);
    expect(files).toContain("src/service.ts");
    expect(files).toContain("test/unit/service.test.ts");
  });

  test("absolute paths extracted", () => {
    const output = "/home/user/project/src/foo.test.ts:5:3 lint/error message";
    const files = extractFilesFromLintOutput(output);
    expect(files).toContain("/home/user/project/src/foo.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitFindingsByScope — structured findings path (adversarial checks)
// ─────────────────────────────────────────────────────────────────────────────

describe("splitFindingsByScope — structured findings path", () => {
  test("non-LLM check (typecheck) → both buckets null", () => {
    const check: ReviewCheckResult = {
      check: "typecheck",
      success: false,
      command: "tsc",
      exitCode: 1,
      output: "type error",
      durationMs: 10,
    };
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("adversarial check with no findings → both buckets null", () => {
    const check = makeAdversarialCheck([]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
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
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("all test-file findings → testFindings non-null, sourceFindings null", () => {
    const findings = [makeFinding("src/auth.test.ts"), makeFinding("test/unit/foo.spec.ts")];
    const check = makeAdversarialCheck(findings);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(testFindings!.findings).toHaveLength(2);
    expect(sourceFindings).toBeNull();
  });

  test("all source-file findings → sourceFindings non-null, testFindings null", () => {
    const findings = [makeFinding("src/auth.ts"), makeFinding("src/utils/helpers.ts")];
    const check = makeAdversarialCheck(findings);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
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
    const { testFindings, sourceFindings } = splitFindingsByScope(check);

    expect(testFindings!.findings).toHaveLength(2);
    expect(testFindings!.findings!.map((f) => f.file)).toEqual(["src/auth.test.ts", "test/unit/auth.spec.ts"]);
    expect(sourceFindings!.findings).toHaveLength(2);
    expect(sourceFindings!.findings!.map((f) => f.file)).toEqual(["src/auth.ts", "src/utils.ts"]);
  });

  test("finding with file:undefined is treated as source-file (non-test)", () => {
    const finding: ReviewFinding = { ruleId: "r", severity: "error", file: undefined as any, line: 1, message: "m" };
    const check = makeAdversarialCheck([finding]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
    expect(sourceFindings!.findings).toHaveLength(1);
  });

  test("scoped checks preserve original raw output from parent check", () => {
    const rawOutput = "adversarial tool raw output with stack trace\n  at line 42\n  at line 100";
    const findings = [makeFinding("src/foo.ts"), makeFinding("src/foo.test.ts")];
    const check = makeAdversarialCheck(findings, rawOutput);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);

    expect(testFindings!.output).toBe(rawOutput);
    expect(sourceFindings!.output).toBe(rawOutput);
  });

  test("scoped check exitCode is inherited from parent check", () => {
    const findings = [makeFinding("src/foo.ts")];
    const check = makeAdversarialCheck(findings);
    const { sourceFindings } = splitFindingsByScope(check);
    expect(sourceFindings!.exitCode).toBe(check.exitCode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitFindingsByScope — lint output parsing path
// ─────────────────────────────────────────────────────────────────────────────

describe("splitFindingsByScope — lint output path", () => {
  test("lint check with empty output → both buckets null", () => {
    const check = makeLintCheck("");
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("lint check with unparseable output → conservative: sourceFindings non-null, testFindings null", () => {
    const check = makeLintCheck("Lint failed with unknown format\nPlease check your code");
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
  });

  test("lint check with all test-file paths → testFindings non-null, sourceFindings null", () => {
    const output = `
src/entity-store.integration.spec.ts:232:26 lint/style/noNonNullAssertion
src/entity-store.integration.spec.ts:247:18 lint/style/noNonNullAssertion
test/unit/foo.test.ts:10:5 lint/style/noNonNullAssertion
`.trim();
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("lint check with all source-file paths → sourceFindings non-null, testFindings null", () => {
    const output = `
src/service.ts:10:3 lint/style/useConst
src/utils/helpers.ts:25:1 lint/style/useConst
`.trim();
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
  });

  test("lint check with mixed paths → both buckets non-null", () => {
    const output = `
src/service.ts:10:3 lint/style/useConst
src/service.test.ts:5:1 lint/style/noNonNullAssertion
`.trim();
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(sourceFindings).not.toBeNull();
  });

  test("lint scoped checks carry the original full output (agent needs full context)", () => {
    const output = "src/foo.test.ts:1:5 lint/style/noNonNullAssertion\n  ✖ Non-null assertion";
    const check = makeLintCheck(output);
    const { testFindings } = splitFindingsByScope(check);
    expect(testFindings!.output).toBe(output);
  });

  test("lint check is not a structured-findings split — testFindings.findings is undefined", () => {
    const output = "src/foo.test.ts:1:5 lint/style/noNonNullAssertion";
    const check = makeLintCheck(output);
    const { testFindings } = splitFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(testFindings!.findings).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runTestWriterRectification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock IAgentManager that forwards run() to a mock agent.
 * Captures run() calls on IAgentManager for assertion on runOptions.
 */
function makeMockAgentManager(mockRun: ReturnType<typeof mock>): ReturnType<typeof mock> {
  const mockManager = mock(async (request: { runOptions: Record<string, unknown> }) => {
    return await mockRun(request.runOptions);
  });
  return mockManager;
}

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
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(cost).toBe(0.05);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  test("returns 0 when agent is not found (agentGetFn returns null)", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const agentManager = { getDefault: () => null, run: makeMockAgentManager(mock(async () => ({ estimatedCost: 0 }))) } as any;
    const ctx = makeCtx();

    // Suppress resolveModelForAgent error for this test — getDefault returns null
    // and the function should return 0 without calling run
    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(cost).toBe(0);
  });

  test("returns 0 and does not rethrow when agent.run throws", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const mockRun = mock(async () => { throw new Error("agent session error"); });
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

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
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx({
      rootConfig: {
        ...DEFAULT_CONFIG,
        tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: { testWriter: "fast" } },
      } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(capturedModelTier).toBe("fast");
  });

  test("defaults to 'balanced' model tier when sessionTiers.testWriter is not configured", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    let capturedModelTier = "";
    const mockRun = mock(async (opts: any) => {
      capturedModelTier = opts.modelTier;
      return { estimatedCost: 0, success: true, output: "", exitCode: 0, rateLimited: false };
    });
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx({
      rootConfig: { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: undefined } } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(capturedModelTier).toBe("balanced");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Session continuity (#437)
  // ─────────────────────────────────────────────────────────────────────────

  test("keepOpen defaults to true so session survives across autofix cycles", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    let capturedKeepSessionOpen: boolean | undefined;
    const mockRun = mock(async (opts: any) => {
      capturedKeepSessionOpen = opts.keepOpen;
      return { estimatedCost: 0, success: true, output: "", exitCode: 0, rateLimited: false };
    });
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx();

    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(capturedKeepSessionOpen).toBe(true);
  });

  test("keepOpen is false when caller passes keepOpen=false", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    let capturedKeepSessionOpen: boolean | undefined;
    const mockRun = mock(async (opts: any) => {
      capturedKeepSessionOpen = opts.keepOpen;
      return { estimatedCost: 0, success: true, output: "", exitCode: 0, rateLimited: false };
    });
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx();

    await runTestWriterRectification(ctx, testChecks, story, agentManager, false);

    expect(capturedKeepSessionOpen).toBe(false);
  });

  test("uses the same sessionRole across two calls (session resumability)", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const capturedSessionRoles: string[] = [];
    const mockRun = mock(async (opts: any) => {
      capturedSessionRoles.push(opts.sessionRole);
      return { estimatedCost: 0, success: true, output: "", exitCode: 0, rateLimited: false };
    });
    const agentManager = { getDefault: () => "claude", run: makeMockAgentManager(mockRun) } as any;
    const ctx = makeCtx();

    await runTestWriterRectification(ctx, testChecks, story, agentManager);
    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(capturedSessionRoles).toHaveLength(2);
    expect(capturedSessionRoles[0]).toBe(capturedSessionRoles[1]);
  });
});
