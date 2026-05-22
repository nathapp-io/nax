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
  extractFilesFromTypecheckOutput,
  filterLintOutputToFiles,
  filterTypecheckOutputToFiles,
  splitFindingsByScope,
} from "../../../../src/pipeline/stages/autofix-scope-split";
import { runTestWriterRectification } from "../../../../src/pipeline/stages/autofix-test-writer";
import { isTestFile } from "../../../../src/test-runners";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { ReviewCheckResult } from "../../../../src/review/types";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewFinding } from "../../../../src/plugins/extensions";
import { makeMockRuntime } from "../../../helpers/runtime";

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

function makeTypecheckCheck(output: string): ReviewCheckResult {
  return {
    check: "typecheck",
    success: false,
    command: "tsc --noEmit",
    exitCode: 1,
    output,
    durationMs: 10,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const mockAgentManager = makeMockAgentManager(mock(async () => ({ estimatedCostUsd: 0, success: true, output: "ok", exitCode: 0, rateLimited: false })));
  const runtime = makeMockRuntime({ agentManager: mockAgentManager });
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
    runtime,
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
  test.each([
    ["empty string", ""],
    ["whitespace-only string", "   \n  \n"],
    ["unparseable output (no file paths)", "Lint failed\nSome warnings\nPlease fix the errors above\n"],
  ])("%s → empty array", (_label, output) => {
    expect(extractFilesFromLintOutput(output)).toEqual([]);
  });

  test.each([
    ["ESLint stylish file header", "src/foo.test.ts\n  1:5   error  Non-null assertion  @typescript-eslint/no-non-null-assertion", "src/foo.test.ts"],
    ["Biome stylish path:line:col", "src/entity-store.integration.spec.ts:232:26 lint/suspicious/noNonNullAssertion ━━━━━\n  ✖ Non-null assertion operator is forbidden.\n  232 │ const result = store.search(projectId, \"foo\")!;", "src/entity-store.integration.spec.ts"],
    ["ESLint compact path:line:col: severity", "src/foo.test.ts:1:5: error  Non-null assertion  @typescript-eslint/no-non-null-assertion", "src/foo.test.ts"],
  ] as const)("%s format — extracts file path", (_label, output, expected) => {
    expect(extractFilesFromLintOutput(output)).toContain(expected);
  });

  test("deduplicates multiple entries for same file, extracts mixed test+source files, and handles absolute paths", () => {
    const dedup = extractFilesFromLintOutput("src/foo.test.ts:1:5 lint/error\nsrc/foo.test.ts:2:8 lint/error\nsrc/bar.spec.ts:10:3 lint/error");
    expect(dedup).toContain("src/foo.test.ts");
    expect(dedup).toContain("src/bar.spec.ts");
    expect(dedup.filter((f) => f === "src/foo.test.ts")).toHaveLength(1);

    const mixed = extractFilesFromLintOutput("src/service.ts:10:3 lint/error message\ntest/unit/service.test.ts:5:1 lint/error message");
    expect(mixed).toContain("src/service.ts");
    expect(mixed).toContain("test/unit/service.test.ts");

    expect(extractFilesFromLintOutput("/home/user/project/src/foo.test.ts:5:3 lint/error message")).toContain("/home/user/project/src/foo.test.ts");
  });

  test("ESLint json output extracts file paths", () => {
    const output = JSON.stringify([
      {
        filePath: "src/service.ts",
        messages: [{ line: 10, column: 3, severity: 2, ruleId: "no-var", message: "Use const." }],
      },
      {
        filePath: "src/service.test.ts",
        messages: [{ line: 5, column: 1, severity: 2, ruleId: "no-var", message: "Use const in test." }],
      },
    ]);
    const files = extractFilesFromLintOutput(output);
    expect(files).toEqual(["src/service.ts", "src/service.test.ts"]);
  });
});

describe("extractFilesFromTypecheckOutput", () => {
  test.each([
    ["empty string", ""],
    ["unparseable output", "Typecheck failed\nPlease fix errors"],
  ])("%s → empty array", (_label, output) => {
    expect(extractFilesFromTypecheckOutput(output)).toEqual([]);
  });

  test("tsc compact output extracts source + test files", () => {
    const output = `
src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
test/unit/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.
`.trim();
    expect(extractFilesFromTypecheckOutput(output)).toEqual(["src/service.ts", "test/unit/service.test.ts"]);
  });

  test.each<[string, string, string[]]>([
    ["unix path", "src/service.ts:10:3 - error TS2322: Type 'A' is not assignable to type 'B'.\n\n10 const x: B = value;\n         ~", ["src/service.ts"]],
    ["Windows drive-letter path", "C:\\repo\\src\\service.ts:10:3 - error TS2322: Type 'A' is not assignable to type 'B'.", ["C:\\repo\\src\\service.ts"]],
  ])("tsc pretty output extracts %s", (_label, output, expected) => {
    expect(extractFilesFromTypecheckOutput(output)).toEqual(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitFindingsByScope — structured findings path (adversarial checks)
// ─────────────────────────────────────────────────────────────────────────────

describe("splitFindingsByScope — structured findings path", () => {
  test.each<[string, () => ReviewCheckResult]>([
    ["non-routable check (build)", () => ({
      check: "build" as const, success: false, command: "bun run build", exitCode: 1, output: "build failed", durationMs: 10,
    })],
    ["adversarial check with no findings", () => makeAdversarialCheck([])],
    ["adversarial check with undefined findings", () => ({
      check: "adversarial" as const, success: false, command: "adversarial-review", exitCode: 1, output: "output", durationMs: 10,
    })],
  ])("%s → both buckets null", (_label, makeCheck) => {
    const { testFindings, sourceFindings } = splitFindingsByScope(makeCheck());
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test.each([
    ["all test-file", [makeFinding("src/auth.test.ts"), makeFinding("test/unit/foo.spec.ts")], true, false],
    ["all source-file", [makeFinding("src/auth.ts"), makeFinding("src/utils/helpers.ts")], false, true],
  ] as const)("%s findings → correct bucket populated, other null", (_label, findings, testNotNull, _sourceNotNull) => {
    const check = makeAdversarialCheck([...findings]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    if (testNotNull) {
      expect(testFindings).not.toBeNull();
      expect(testFindings!.findings).toHaveLength(2);
      expect(sourceFindings).toBeNull();
    } else {
      expect(testFindings).toBeNull();
      expect(sourceFindings).not.toBeNull();
      expect(sourceFindings!.findings).toHaveLength(2);
    }
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

  test("file:undefined routes to sourceFindings (non-test-gap) or testFindings (test-gap)", () => {
    const nonGap: ReviewFinding = { ruleId: "r", severity: "error", file: undefined as any, line: 1, message: "m" };
    const { testFindings: t1, sourceFindings: s1 } = splitFindingsByScope(makeAdversarialCheck([nonGap]));
    expect(t1).toBeNull();
    expect(s1).not.toBeNull();
    expect(s1!.findings).toHaveLength(1);

    const gap: ReviewFinding = { ruleId: "r", severity: "error", file: undefined as any, line: 1, message: "m", category: "test-gap" };
    const { testFindings: t2, sourceFindings: s2 } = splitFindingsByScope(makeAdversarialCheck([gap]));
    expect(t2).not.toBeNull();
    expect(s2).toBeNull();
  });

  test("scoped checks inherit exitCode and raw output from parent check", () => {
    const rawOutput = "adversarial tool raw output with stack trace\n  at line 42\n  at line 100";
    const findings = [makeFinding("src/foo.ts"), makeFinding("src/foo.test.ts")];
    const check = makeAdversarialCheck(findings, rawOutput);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings!.output).toBe(rawOutput);
    expect(sourceFindings!.output).toBe(rawOutput);
    expect(sourceFindings!.exitCode).toBe(check.exitCode);
  });

  // Issue #829 — `test-gap` findings flag a source-file unit that lacks a test;
  // the remediation belongs in test-writer scope, not implementer.
  test.each([
    ["test-gap on source file → routes to testFindings", "apps/api/src/rag/rag.service.ts", "test-gap", true, false],
    ["non-test-gap on source file → routes to sourceFindings", "src/foo.ts", "abandonment", false, true],
  ] as const)("%s", (_label, file, category, testNotNull, sourceNotNull) => {
    const finding = makeFinding(file, { category });
    const check = makeAdversarialCheck([finding]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    if (testNotNull) { expect(testFindings).not.toBeNull(); expect(testFindings!.findings).toHaveLength(1); }
    else expect(testFindings).toBeNull();
    if (sourceNotNull) { expect(sourceFindings).not.toBeNull(); expect(sourceFindings!.findings).toHaveLength(1); }
    else expect(sourceFindings).toBeNull();
  });

  test("mixed test-gap + non-test-gap on source files → split correctly", () => {
    const findings = [
      makeFinding("src/foo.ts", { category: "abandonment" }),
      makeFinding("src/foo.ts", { category: "test-gap" }),
      makeFinding("src/bar.test.ts", { category: "convention" }),
    ];
    const check = makeAdversarialCheck(findings);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(sourceFindings!.findings!.map((f) => f.category)).toEqual(["abandonment"]);
    expect(testFindings!.findings!.map((f) => f.category)).toEqual(["test-gap", "convention"]);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// splitFindingsByScope — lint output parsing path
// ─────────────────────────────────────────────────────────────────────────────

describe("splitFindingsByScope — lint output path", () => {
  test("empty lint/typecheck → both null; unparseable lint/typecheck → conservative sourceFindings only", () => {
    expect(splitFindingsByScope(makeLintCheck("")).testFindings).toBeNull();
    expect(splitFindingsByScope(makeLintCheck("")).sourceFindings).toBeNull();
    expect(splitFindingsByScope(makeLintCheck("Lint failed with unknown format\nPlease check your code")).testFindings).toBeNull();
    expect(splitFindingsByScope(makeLintCheck("Lint failed with unknown format\nPlease check your code")).sourceFindings).not.toBeNull();
    expect(splitFindingsByScope(makeTypecheckCheck("")).testFindings).toBeNull();
    expect(splitFindingsByScope(makeTypecheckCheck("")).sourceFindings).toBeNull();
    expect(splitFindingsByScope(makeTypecheckCheck("Typecheck failed with unknown format")).testFindings).toBeNull();
    expect(splitFindingsByScope(makeTypecheckCheck("Typecheck failed with unknown format")).sourceFindings).not.toBeNull();
  });

  test.each([
    ["all test-file paths", "src/entity-store.integration.spec.ts:232:26 lint/style/noNonNullAssertion\nsrc/entity-store.integration.spec.ts:247:18 lint/style/noNonNullAssertion\ntest/unit/foo.test.ts:10:5 lint/style/noNonNullAssertion", true, false],
    ["all source-file paths", "src/service.ts:10:3 lint/style/useConst\nsrc/utils/helpers.ts:25:1 lint/style/useConst", false, true],
  ] as const)("lint check with %s → correct bucket", (_label, output, testNotNull, sourceNotNull) => {
    const { testFindings, sourceFindings } = splitFindingsByScope(makeLintCheck(output));
    if (testNotNull) expect(testFindings).not.toBeNull();
    else expect(testFindings).toBeNull();
    if (sourceNotNull) expect(sourceFindings).not.toBeNull();
    else expect(sourceFindings).toBeNull();
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
    expect(testFindings?.output).toContain("src/service.test.ts:5:1");
    expect(testFindings?.output).not.toContain("src/service.ts:10:3");
    expect(sourceFindings?.output).toContain("src/service.ts:10:3");
    expect(sourceFindings?.output).not.toContain("src/service.test.ts:5:1");
  });

  test("lint scoped checks carry scoped output only and testFindings.findings is undefined (not a structured split)", () => {
    const output = "src/foo.test.ts:1:5 lint/style/noNonNullAssertion\n  ✖ Non-null assertion";
    const { testFindings } = splitFindingsByScope(makeLintCheck(output));
    expect(testFindings!.output).toBe(output);
    expect(testFindings!.findings).toBeUndefined();
  });

  test("lint check with eslint json array and json-with-metadata formats both split test and source diagnostics", () => {
    const jsonArray = JSON.stringify([
      { filePath: "src/service.ts", messages: [{ line: 10, column: 3, severity: 2, ruleId: "no-var", message: "Use const." }] },
      { filePath: "src/service.test.ts", messages: [{ line: 5, column: 1, severity: 2, ruleId: "no-var", message: "Use const in test." }] },
    ]);
    const r1 = splitFindingsByScope(makeLintCheck(jsonArray));
    expect(r1.testFindings?.output).toContain("src/service.test.ts");
    expect(r1.testFindings?.output).not.toContain("src/service.ts");
    expect(r1.sourceFindings?.output).toContain("src/service.ts");
    expect(r1.sourceFindings?.output).not.toContain("src/service.test.ts");

    const jsonMeta = JSON.stringify({ results: [
      { filePath: "src/core.ts", messages: [{ line: 1, column: 1, severity: 2, ruleId: "x", message: "core error" }] },
      { filePath: "test/unit/core.test.ts", messages: [{ line: 2, column: 1, severity: 2, ruleId: "x", message: "test error" }] },
    ]});
    const r2 = splitFindingsByScope(makeLintCheck(jsonMeta));
    expect(r2.testFindings?.output).toContain("test/unit/core.test.ts");
    expect(r2.sourceFindings?.output).toContain("src/core.ts");
  });

  test("lint parsing can be disabled with format none", () => {
    const output = `
src/service.ts:10:3 lint/style/useConst
src/service.test.ts:5:1 lint/style/noNonNullAssertion
`.trim();
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check, undefined, "none");
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
    expect(sourceFindings?.output).toBe(output);
  });

  test("lint check with biome json output splits test and source diagnostics", () => {
    const output = JSON.stringify({
      diagnostics: [
        {
          category: "lint/style/useConst",
          severity: "error",
          message: "Use const.",
          location: {
            span: {
              path: "src/service.ts",
              line: 10,
              column: 3,
            },
          },
        },
        {
          category: "lint/suspicious/noNonNullAssertion",
          severity: "error",
          message: "Avoid non-null assertion.",
          location: {
            span: {
              path: "test/unit/service.test.ts",
              line: 5,
              column: 1,
            },
          },
        },
      ],
    });
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check, undefined, "biome-json");
    expect(testFindings?.output).toContain("test/unit/service.test.ts");
    expect(testFindings?.output).not.toContain("src/service.ts");
    expect(sourceFindings?.output).toContain("src/service.ts");
    expect(sourceFindings?.output).not.toContain("test/unit/service.test.ts");
  });
});

describe("splitFindingsByScope — typecheck output path", () => {

  test.each([
    ["all test-file diagnostics", "src/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.\ntest/unit/foo.test.ts(2,1): error TS2552: Cannot find name 'describe'.", true, false],
    ["all source diagnostics", "src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/core.ts(1,1): error TS2304: Cannot find name 'foo'.", false, true],
  ] as const)("%s → correct bucket", (_label, output, testNotNull, sourceNotNull) => {
    const { testFindings, sourceFindings } = splitFindingsByScope(makeTypecheckCheck(output), undefined, "auto", "tsc");
    if (testNotNull) expect(testFindings).not.toBeNull();
    else expect(testFindings).toBeNull();
    if (sourceNotNull) expect(sourceFindings).not.toBeNull();
    else expect(sourceFindings).toBeNull();
  });

  test("mixed test/source diagnostics split into distinct outputs", () => {
    const output = `
src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.
`.trim();
    const check = makeTypecheckCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check, undefined, "auto", "tsc");
    expect(testFindings?.output).toContain("src/service.test.ts(5,1)");
    expect(testFindings?.output).not.toContain("src/service.ts(10,3)");
    expect(sourceFindings?.output).toContain("src/service.ts(10,3)");
    expect(sourceFindings?.output).not.toContain("src/service.test.ts(5,1)");
  });

  test("typecheck parser can be disabled with format none", () => {
    const output = `
src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.
`.trim();
    const check = makeTypecheckCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check, undefined, "auto", "none");
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
    expect(sourceFindings?.output).toBe(output);
  });
});

describe("filterLintOutputToFiles", () => {
  test("filters to target file blocks, strips summary lines, and returns null when target absent", () => {
    const out1 = "src/service.ts:10:3 lint/style/useConst\n  ✖ Use const.\n\nsrc/service.test.ts:5:1 lint/style/noNonNullAssertion\n  ✖ avoid non-null assertion.\n\nFound 2 errors.";
    const f1 = filterLintOutputToFiles(out1, new Set(["src/service.test.ts"]));
    expect(f1).not.toBeNull();
    expect(f1).toContain("src/service.test.ts:5:1");
    expect(f1).not.toContain("src/service.ts:10:3");
    expect(f1).not.toContain("Found 2 errors.");

    const out2 = "src/service.ts:10:3 lint/style/useConst\n  ✖ Use const.\nFound 1 error.\n\nsrc/service.test.ts:5:1 lint/style/noNonNullAssertion\n  ✖ avoid non-null assertion.";
    const f2 = filterLintOutputToFiles(out2, new Set(["src/service.ts"]));
    expect(f2).not.toBeNull();
    expect(f2).toContain("src/service.ts:10:3");
    expect(f2).not.toContain("Found 1 error.");
    expect(filterLintOutputToFiles("src/service.ts:10:3 lint/style/useConst", new Set(["src/other.ts"]))).toBeNull();
  });
});

describe("filterTypecheckOutputToFiles", () => {
  test("filters tsc blocks to target file; returns null when absent", () => {
    const output = `
src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.

src/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.
Found 2 errors in 2 files.
`.trim();
    const filtered = filterTypecheckOutputToFiles(output, new Set(["src/service.test.ts"]), "tsc");
    expect(filtered).not.toBeNull();
    expect(filtered).toContain("src/service.test.ts(5,1)");
    expect(filtered).not.toContain("src/service.ts(10,3)");
    expect(filtered).not.toContain("Found 2 errors in 2 files.");

    const absent = filterTypecheckOutputToFiles("src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.", new Set(["src/other.ts"]), "tsc");
    expect(absent).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runTestWriterRectification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a mock IAgentManager that forwards run() to a mock agent.
 * Captures run() calls on IAgentManager for assertion on runOptions.
 */
function makeMockAgentManager(mockRun: ReturnType<typeof mock>) {
  const mockManager = mock(async (request: { runOptions: Record<string, unknown> }) => {
    return await mockRun(request.runOptions);
  });
  return {
    getDefault: () => "claude",
    run: mockManager,
    runWithFallback: mock(async (request: { runOptions: Record<string, unknown> }) => {
      return { result: await mockRun(request.runOptions), fallbacks: [] };
    }),
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} },
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
  } as any;
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
    const mockRun = mock(async () => ({ estimatedCostUsd: 0.05, success: true, output: "done", exitCode: 0, rateLimited: false }));
    const agentManager = makeMockAgentManager(mockRun);
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(cost).toBe(0.05);
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["agent not found (getDefault returns null)", (mgr: ReturnType<typeof makeMockAgentManager>) => { mgr.getDefault = () => null; }, 0],
    ["runWithFallback throws", (mgr: ReturnType<typeof makeMockAgentManager>) => { mgr.runWithFallback = mock(async () => { throw new Error("agent session error"); }); }, 1],
  ] as const)("returns 0 when %s", async (_label, setupMgr, expectedCalls) => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const agentManager = makeMockAgentManager(mock(async () => ({ estimatedCostUsd: 0 })));
    setupMgr(agentManager);
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(cost).toBe(0);
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(expectedCalls);
  });

  test.each([
    ["configured testWriter tier", { testWriter: "fast" } as any, "fast"],
    ["undefined sessionTiers falls back to balanced", undefined, "balanced"],
  ] as const)("model tier: %s", async (_label, sessionTiers, expectedTier) => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const mockRun = mock(async () => ({ estimatedCostUsd: 0, success: true, output: "", exitCode: 0, rateLimited: false }));
    const agentManager = makeMockAgentManager(mockRun);
    const ctx = makeCtx({
      rootConfig: { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers } } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    const callOpts = (agentManager.runWithFallback.mock.calls as unknown[][])[0][0] as { runOptions: Record<string, unknown> };
    expect(callOpts.runOptions.modelTier).toBe(expectedTier);
  });
});
