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
  runTestWriterRectification,
} from "../../../../src/pipeline/stages/autofix-adversarial";
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
  test("empty string → empty array", () => {
    expect(extractFilesFromTypecheckOutput("")).toEqual([]);
  });

  test("unparseable output → empty array", () => {
    const output = "Typecheck failed\nPlease fix errors";
    expect(extractFilesFromTypecheckOutput(output)).toEqual([]);
  });

  test("tsc compact output extracts source + test files", () => {
    const output = `
src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
test/unit/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.
`.trim();
    expect(extractFilesFromTypecheckOutput(output)).toEqual(["src/service.ts", "test/unit/service.test.ts"]);
  });

  test("tsc pretty output extracts file path", () => {
    const output = `
src/service.ts:10:3 - error TS2322: Type 'A' is not assignable to type 'B'.

10 const x: B = value;
         ~
`.trim();
    expect(extractFilesFromTypecheckOutput(output)).toEqual(["src/service.ts"]);
  });

  test("tsc pretty output extracts Windows drive-letter paths", () => {
    const output = "C:\\repo\\src\\service.ts:10:3 - error TS2322: Type 'A' is not assignable to type 'B'.";
    expect(extractFilesFromTypecheckOutput(output)).toEqual(["C:\\repo\\src\\service.ts"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitFindingsByScope — structured findings path (adversarial checks)
// ─────────────────────────────────────────────────────────────────────────────

describe("splitFindingsByScope — structured findings path", () => {
  test("non-routable check (build) → both buckets null", () => {
    const check: ReviewCheckResult = {
      check: "build",
      success: false,
      command: "bun run build",
      exitCode: 1,
      output: "build failed",
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

  // Issue #829 — `test-gap` findings flag a source-file unit that lacks a test;
  // the remediation belongs in test-writer scope, not implementer.
  test("test-gap on source file → routes to testFindings, not sourceFindings", () => {
    const finding = makeFinding("apps/api/src/rag/rag.service.ts", { category: "test-gap" });
    const check = makeAdversarialCheck([finding]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(testFindings!.findings).toHaveLength(1);
    expect(sourceFindings).toBeNull();
  });

  test("non-test-gap on source file still routes to sourceFindings", () => {
    const finding = makeFinding("src/foo.ts", { category: "abandonment" });
    const check = makeAdversarialCheck([finding]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
    expect(sourceFindings!.findings).toHaveLength(1);
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

  test("test-gap with undefined file routes to testFindings", () => {
    const finding: ReviewFinding = {
      ruleId: "r",
      severity: "error",
      file: undefined as any,
      line: 1,
      message: "m",
      category: "test-gap",
    };
    const check = makeAdversarialCheck([finding]);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).not.toBeNull();
    expect(sourceFindings).toBeNull();
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
    expect(testFindings?.output).toContain("src/service.test.ts:5:1");
    expect(testFindings?.output).not.toContain("src/service.ts:10:3");
    expect(sourceFindings?.output).toContain("src/service.ts:10:3");
    expect(sourceFindings?.output).not.toContain("src/service.test.ts:5:1");
  });

  test("lint scoped checks carry scoped output only", () => {
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

  test("lint check with eslint json output splits test and source diagnostics", () => {
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
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings?.output).toContain("src/service.test.ts");
    expect(testFindings?.output).not.toContain("src/service.ts");
    expect(sourceFindings?.output).toContain("src/service.ts");
    expect(sourceFindings?.output).not.toContain("src/service.test.ts");
  });

  test("lint check with eslint json-with-metadata output splits correctly", () => {
    const output = JSON.stringify({
      results: [
        {
          filePath: "src/core.ts",
          messages: [{ line: 1, column: 1, severity: 2, ruleId: "x", message: "core error" }],
        },
        {
          filePath: "test/unit/core.test.ts",
          messages: [{ line: 2, column: 1, severity: 2, ruleId: "x", message: "test error" }],
        },
      ],
    });
    const check = makeLintCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings?.output).toContain("test/unit/core.test.ts");
    expect(sourceFindings?.output).toContain("src/core.ts");
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
  test("typecheck check with empty output → both buckets null", () => {
    const check = makeTypecheckCheck("");
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("typecheck check with unparseable output → conservative: sourceFindings non-null, testFindings null", () => {
    const check = makeTypecheckCheck("Typecheck failed with unknown format");
    const { testFindings, sourceFindings } = splitFindingsByScope(check);
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
  });

  test("all test-file diagnostics → testFindings non-null, sourceFindings null", () => {
    const output = `
src/service.test.ts(5,1): error TS2304: Cannot find name 'expect'.
test/unit/foo.test.ts(2,1): error TS2552: Cannot find name 'describe'.
`.trim();
    const check = makeTypecheckCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check, undefined, "auto", "tsc");
    expect(testFindings).not.toBeNull();
    expect(sourceFindings).toBeNull();
  });

  test("all source diagnostics → sourceFindings non-null, testFindings null", () => {
    const output = `
src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/core.ts(1,1): error TS2304: Cannot find name 'foo'.
`.trim();
    const check = makeTypecheckCheck(output);
    const { testFindings, sourceFindings } = splitFindingsByScope(check, undefined, "auto", "tsc");
    expect(testFindings).toBeNull();
    expect(sourceFindings).not.toBeNull();
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
  test("filters block output to target file blocks only", () => {
    const output = `
src/service.ts:10:3 lint/style/useConst
  ✖ Use const.

src/service.test.ts:5:1 lint/style/noNonNullAssertion
  ✖ avoid non-null assertion.

Found 2 errors.
`.trim();
    const filtered = filterLintOutputToFiles(output, new Set(["src/service.test.ts"]));
    expect(filtered).not.toBeNull();
    expect(filtered).toContain("src/service.test.ts:5:1");
    expect(filtered).not.toContain("src/service.ts:10:3");
    expect(filtered).not.toContain("Found 2 errors.");
  });

  test("strips summary lines that appear before the next block", () => {
    const output = `
src/service.ts:10:3 lint/style/useConst
  ✖ Use const.
Found 1 error.

src/service.test.ts:5:1 lint/style/noNonNullAssertion
  ✖ avoid non-null assertion.
`.trim();
    const sourceOnly = filterLintOutputToFiles(output, new Set(["src/service.ts"]));
    expect(sourceOnly).not.toBeNull();
    expect(sourceOnly).toContain("src/service.ts:10:3");
    expect(sourceOnly).not.toContain("Found 1 error.");
  });

  test("returns null when target files are absent", () => {
    const output = "src/service.ts:10:3 lint/style/useConst";
    const filtered = filterLintOutputToFiles(output, new Set(["src/other.ts"]));
    expect(filtered).toBeNull();
  });
});

describe("filterTypecheckOutputToFiles", () => {
  test("filters tsc blocks to target file only", () => {
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
  });

  test("returns null when target files are absent", () => {
    const output = "src/service.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.";
    const filtered = filterTypecheckOutputToFiles(output, new Set(["src/other.ts"]), "tsc");
    expect(filtered).toBeNull();
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

  test("returns 0 when agent is not found (getDefault returns null)", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const agentManager = makeMockAgentManager(mock(async () => ({ estimatedCostUsd: 0 })));
    agentManager.getDefault = () => null;
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(cost).toBe(0);
  });

  test("returns 0 and does not rethrow when runWithFallback throws", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const agentManager = makeMockAgentManager(mock(async () => ({ estimatedCostUsd: 0 })));
    agentManager.runWithFallback = mock(async () => { throw new Error("agent session error"); });
    const ctx = makeCtx();

    const cost = await runTestWriterRectification(ctx, testChecks, story, agentManager);

    expect(cost).toBe(0);
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test("uses config.tdd.sessionTiers.testWriter for model tier", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const mockRun = mock(async () => ({ estimatedCostUsd: 0, success: true, output: "", exitCode: 0, rateLimited: false }));
    const agentManager = makeMockAgentManager(mockRun);
    const ctx = makeCtx({
      rootConfig: {
        ...DEFAULT_CONFIG,
        tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: { testWriter: "fast" } },
      } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    const callOpts = (agentManager.runWithFallback.mock.calls as unknown[][])[0][0] as { runOptions: Record<string, unknown> };
    expect(callOpts.runOptions.modelTier).toBe("fast");
  });

  test("defaults to 'balanced' model tier when sessionTiers.testWriter is not configured", async () => {
    const testChecks = [makeAdversarialCheck([makeFinding("src/foo.test.ts")])];
    const mockRun = mock(async () => ({ estimatedCostUsd: 0, success: true, output: "", exitCode: 0, rateLimited: false }));
    const agentManager = makeMockAgentManager(mockRun);
    const ctx = makeCtx({
      rootConfig: { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, sessionTiers: undefined } } as any,
    });

    await runTestWriterRectification(ctx, testChecks, story, agentManager);

    const callOpts = (agentManager.runWithFallback.mock.calls as unknown[][])[0][0] as { runOptions: Record<string, unknown> };
    expect(callOpts.runOptions.modelTier).toBe("balanced");
  });
});
