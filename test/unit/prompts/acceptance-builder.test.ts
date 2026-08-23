/**
 * Tests for AcceptancePromptBuilder (Phase 4)
 *
 * Covers:
 * - buildGeneratorFromPRDPrompt: snapshot + structural contract
 * - buildGeneratorFromSpecPrompt: snapshot + structural contract
 * - buildDiagnosisPromptTemplate: snapshot + structural contract
 * - buildSourceFixPrompt: structural contract
 * - buildTestFixPrompt: structural contract
 */

import { describe, expect, test } from "bun:test";
import { AcceptancePromptBuilder } from "@/prompts";

const builder = new AcceptancePromptBuilder();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FEATURE = "url-shortener";
const CRITERIA_LIST = "AC-1: handles empty input\nAC-2: returns short URL";
const TARGET_PATH = "/project/.nax/features/url-shortener/.nax-acceptance.test.ts";
const RESOLVED_TEST_PATH = ".nax-acceptance.test.ts";

// ─── buildGeneratorFromPRDPrompt ──────────────────────────────────────────────

describe("builder.buildGeneratorFromPRDPrompt()", () => {
  const base = {
    featureName: FEATURE,
    criteriaList: CRITERIA_LIST,
    frameworkOverrideLine: "",
    targetTestFilePath: TARGET_PATH,
  };

  describe("snapshot stability", () => {
    test("no framework override, no implementation context", () => {
      expect(builder.buildGeneratorFromPRDPrompt(base)).toMatchSnapshot();
    });

    test("with framework override", () => {
      expect(
        builder.buildGeneratorFromPRDPrompt({
          ...base,
          frameworkOverrideLine:
            "\n[FRAMEWORK OVERRIDE: Use vitest as the test framework regardless of what you detect.]",
        }),
      ).toMatchSnapshot();
    });

    test("with implementation context", () => {
      expect(
        builder.buildGeneratorFromPRDPrompt({
          ...base,
          implementationContext: [{ path: "src/index.ts", content: "export function shorten() {}" }],
        }),
      ).toMatchSnapshot();
    });
  });

  describe("structural contract", () => {
    test.each([
      ["feature name", `"${FEATURE}" feature`],
      ["acceptance criteria list", CRITERIA_LIST],
      ["target test file path", TARGET_PATH],
      ["file output requirement", "File output (REQUIRED)"],
    ])("includes %s", (_label, expected) => {
      expect(builder.buildGeneratorFromPRDPrompt(base)).toContain(expected);
    });

    test("includes step headers", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).toContain("## Step 1");
      expect(result).toContain("## Step 2");
      expect(result).toContain("## Step 3");
    });

    test("includes implementation section when provided, omits when not", () => {
      const withCtx = builder.buildGeneratorFromPRDPrompt({
        ...base,
        implementationContext: [{ path: "src/index.ts", content: "export function shorten() {}" }],
      });
      expect(withCtx).toContain("## Implementation (already exists)");
      expect(withCtx).toContain("src/index.ts");
      expect(builder.buildGeneratorFromPRDPrompt(base)).not.toContain("## Implementation");
    });

    test("includes framework override when non-empty", () => {
      const line = "\n[FRAMEWORK OVERRIDE: Use vitest as the test framework regardless of what you detect.]";
      const result = builder.buildGeneratorFromPRDPrompt({ ...base, frameworkOverrideLine: line });
      expect(result).toContain("FRAMEWORK OVERRIDE");
    });
  });
});

// ─── buildGeneratorFromSpecPrompt ────────────────────────────────────────────

describe("builder.buildGeneratorFromSpecPrompt()", () => {
  const base = {
    featureName: FEATURE,
    criteriaList: CRITERIA_LIST,
    resolvedTestPath: RESOLVED_TEST_PATH,
  };

  describe("snapshot stability", () => {
    test("standard generator from spec", () => {
      expect(builder.buildGeneratorFromSpecPrompt(base)).toMatchSnapshot();
    });
  });

  describe("structural contract", () => {
    test.each([
      ["feature name", `"${FEATURE}" feature`],
      ["criteria list", CRITERIA_LIST],
      ["raw code output instruction", "Output raw code only"],
      ["resolved test path", RESOLVED_TEST_PATH],
    ])("includes %s", (_label, expected) => {
      expect(builder.buildGeneratorFromSpecPrompt(base)).toContain(expected);
    });

    test("does NOT include file output (REQUIRED) directive (raw output mode)", () => {
      expect(builder.buildGeneratorFromSpecPrompt(base)).not.toContain("File output (REQUIRED)");
    });
  });
});

// ─── buildDiagnosisPromptTemplate ────────────────────────────────────────────

describe("builder.buildDiagnosisPromptTemplate()", () => {
  const base = {
    truncatedOutput: "FAIL: AC-1 assertion error",
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
    sourceFilesSection: "(No source files could be resolved from imports)",
    verdictSection: "",
    maxFileLines: 500,
  };

  describe("snapshot stability", () => {
    test("no verdicts", () => {
      expect(builder.buildDiagnosisPromptTemplate(base)).toMatchSnapshot();
    });

    test("with verdict section", () => {
      expect(
        builder.buildDiagnosisPromptTemplate({
          ...base,
          verdictSection:
            "\nSEMANTIC VERDICTS:\n- US-001: likely test bug (semantic review confirmed AC implementation)\n",
        }),
      ).toMatchSnapshot();
    });
  });

  describe("structural contract", () => {
    test.each([
      ["test output", () => base.truncatedOutput],
      ["source files section", () => base.sourceFilesSection],
      ["maxFileLines header", () => `up to ${base.maxFileLines} lines each`],
    ])("includes %s", (_label, getExpected) => {
      expect(builder.buildDiagnosisPromptTemplate(base)).toContain(getExpected());
    });

    test("references test path, instructs Read, includes JSON schema (Bug 6 no embedded body)", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain(base.acceptanceTestPath);
      expect(result).not.toContain("```typescript");
      expect(result).toContain("Read");
      expect(result).toContain('"verdict"');
      expect(result).toContain('"reasoning"');
      expect(result).toContain('"confidence"');
    });

    test("includes verdict section when provided", () => {
      const result = builder.buildDiagnosisPromptTemplate({
        ...base,
        verdictSection: "\nSEMANTIC VERDICTS:\n- US-001: likely test bug\n",
      });
      expect(result).toContain("SEMANTIC VERDICTS");
    });

    test("does not include SEMANTIC VERDICTS when verdictSection is empty", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).not.toContain("SEMANTIC VERDICTS");
    });
  });
});

// ─── buildSourceFixPrompt ─────────────────────────────────────────────────────

describe("builder.buildSourceFixPrompt()", () => {
  const base = {
    testOutput: "(fail) AC-1: null pointer [2ms]\n  Error: Cannot read property\n\n 0 pass\n 1 fail",
    diagnosisReasoning: "Source file has uninitialized field",
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
  };

  test("includes structured test output and does not embed file content (Bug 6 regression)", () => {
    const result = builder.buildSourceFixPrompt(base);
    expect(result).toContain("AC-1");
    expect(result).toContain("Cannot read property");
    expect(result).not.toContain("```typescript");
  });

  test.each([
    ["acceptance test path", () => base.acceptanceTestPath],
    ["Read instruction", () => "Read the test file at the path above"],
    ["diagnosis reasoning", () => base.diagnosisReasoning],
  ])("buildSourceFixPrompt includes %s", (_label, getExpected) => {
    expect(builder.buildSourceFixPrompt(base)).toContain(getExpected());
  });

  test("includes prior iterations block when provided", () => {
    const result = builder.buildSourceFixPrompt({
      ...base,
      priorIterationsBlock: "## Prior Iterations\n\nprior table\n\n",
    });
    expect(result).toContain("## Prior Iterations");
    expect(result).toContain("prior table");
  });

  test("includes test framework hint when testCommand is provided", () => {
    const result = builder.buildSourceFixPrompt({ ...base, testCommand: "bun test" });
    expect(result).toContain("Test framework:");
  });

  test("instructs not to modify test file", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain("Do NOT modify the test file");
  });
});

// ─── buildTestFixPrompt ───────────────────────────────────────────────────────

describe("builder.buildTestFixPrompt()", () => {
  const base = {
    testOutput:
      "(pass) AC-1: ok [1ms]\n(fail) AC-2: assertion failed [2ms]\n  Error: Expected 1 got 0\n\n 1 pass\n 1 fail",
    diagnosisReasoning: "Test uses wrong assertion type",
    failedACs: ["AC-2"],
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
  };

  test("includes failing ACs, drops (pass) lines, does not embed file content (Bug 6 regression)", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("AC-2");
    expect(result).not.toContain("```typescript");
    expect(result).not.toContain("(pass) AC-1");
    expect(result).toContain("Expected 1 got 0");
  });

  test.each([
    ["acceptance test path", () => base.acceptanceTestPath],
    ["Read instruction", () => "Read the test file at the path above"],
    ["diagnosis reasoning", () => base.diagnosisReasoning],
  ])("buildTestFixPrompt includes %s", (_label, getExpected) => {
    expect(builder.buildTestFixPrompt(base)).toContain(getExpected());
  });

  test("includes prior iterations block when provided", () => {
    const result = builder.buildTestFixPrompt({
      ...base,
      priorIterationsBlock: "## Prior Iterations\n\nprior table\n\n",
    });
    expect(result).toContain("## Prior Iterations");
    expect(result).toContain("prior table");
  });

  test("includes test framework hint when testCommand is provided", () => {
    const result = builder.buildTestFixPrompt({ ...base, testCommand: "bun test" });
    expect(result).toContain("Test framework:");
  });

  test("instructs to fix only failing ACs and not source code", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("surgical");
    expect(result).toContain("Do NOT modify source code");
  });
});
