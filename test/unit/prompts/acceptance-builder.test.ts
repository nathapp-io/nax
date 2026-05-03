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
import { AcceptancePromptBuilder } from "../../../src/prompts";

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
          frameworkOverrideLine: "\n[FRAMEWORK OVERRIDE: Use vitest as the test framework regardless of what you detect.]",
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
    test("includes feature name", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).toContain(`"${FEATURE}" feature`);
    });

    test("includes acceptance criteria list", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).toContain(CRITERIA_LIST);
    });

    test("includes step headers", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).toContain("## Step 1");
      expect(result).toContain("## Step 2");
      expect(result).toContain("## Step 3");
    });

    test("includes target test file path in path anchor", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).toContain(TARGET_PATH);
    });

    test("includes file output requirement", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).toContain("File output (REQUIRED)");
    });

    test("includes implementation context when provided", () => {
      const result = builder.buildGeneratorFromPRDPrompt({
        ...base,
        implementationContext: [{ path: "src/index.ts", content: "export function shorten() {}" }],
      });
      expect(result).toContain("## Implementation (already exists)");
      expect(result).toContain("src/index.ts");
    });

    test("omits implementation section when not provided", () => {
      const result = builder.buildGeneratorFromPRDPrompt(base);
      expect(result).not.toContain("## Implementation");
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
    test("includes feature name", () => {
      expect(builder.buildGeneratorFromSpecPrompt(base)).toContain(`"${FEATURE}" feature`);
    });

    test("includes criteria list", () => {
      expect(builder.buildGeneratorFromSpecPrompt(base)).toContain(CRITERIA_LIST);
    });

    test("includes raw code output instruction", () => {
      expect(builder.buildGeneratorFromSpecPrompt(base)).toContain("Output raw code only");
    });

    test("includes resolved test path in path anchor", () => {
      const result = builder.buildGeneratorFromSpecPrompt(base);
      expect(result).toContain(RESOLVED_TEST_PATH);
    });

    test("does NOT include file output (REQUIRED) directive (raw output mode)", () => {
      const result = builder.buildGeneratorFromSpecPrompt(base);
      expect(result).not.toContain("File output (REQUIRED)");
    });
  });
});

// ─── buildDiagnosisPromptTemplate ────────────────────────────────────────────

describe("builder.buildDiagnosisPromptTemplate()", () => {
  const base = {
    truncatedOutput: "FAIL: AC-1 assertion error",
    testFileContent: 'import { test } from "bun:test"; test("AC-1: x", () => {});',
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
          verdictSection: "\nSEMANTIC VERDICTS:\n- US-001: likely test bug (semantic review confirmed AC implementation)\n",
        }),
      ).toMatchSnapshot();
    });
  });

  describe("structural contract", () => {
    test("includes test output", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain(base.truncatedOutput);
    });

    test("includes test file content in fenced block", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain("```typescript");
      expect(result).toContain(base.testFileContent);
    });

    test("includes source files section", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain(base.sourceFilesSection);
    });

    test("includes maxFileLines in source files header", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain(`up to ${base.maxFileLines} lines each`);
    });

    test("includes JSON response schema", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
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
    testOutput: "FAIL: AC-1 null pointer",
    diagnosisReasoning: "Source file has uninitialized field",
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
    testFileContent: 'test("AC-1: x", () => { expect(foo()).toBe(1); });',
  };

  test("includes test output", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain(base.testOutput);
  });

  test("includes diagnosis reasoning", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain(base.diagnosisReasoning);
  });

  test("includes prior iterations block when provided", () => {
    const result = builder.buildSourceFixPrompt({ ...base, priorIterationsBlock: "## Prior Iterations\n\nprior table\n\n" });
    expect(result).toContain("## Prior Iterations");
    expect(result).toContain("prior table");
  });

  test("includes acceptance test path", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain(base.acceptanceTestPath);
  });

  test("includes test file content in fenced typescript block", () => {
    const result = builder.buildSourceFixPrompt(base);
    expect(result).toContain("```typescript");
    expect(result).toContain(base.testFileContent);
  });

  test("omits fenced block when testFileContent is empty", () => {
    const result = builder.buildSourceFixPrompt({ ...base, testFileContent: "" });
    expect(result).not.toContain("```typescript");
  });

  test("instructs not to modify test file", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain("Do NOT modify the test file");
  });
});

// ─── buildTestFixPrompt ───────────────────────────────────────────────────────

describe("builder.buildTestFixPrompt()", () => {
  const base = {
    testOutput: "FAIL: AC-1 assertion error",
    diagnosisReasoning: "Test uses wrong assertion type",
    failedACs: ["AC-1", "AC-3"],
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
    testFileContent: 'test("AC-1: x", () => { expect(foo()).toBe(1); });',
  };

  test("includes failing ACs", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("AC-1");
    expect(result).toContain("AC-3");
  });

  test("includes test output", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain(base.testOutput);
  });

  test("includes diagnosis reasoning", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain(base.diagnosisReasoning);
  });

  test("includes prior iterations block when provided", () => {
    const result = builder.buildTestFixPrompt({ ...base, priorIterationsBlock: "## Prior Iterations\n\nprior table\n\n" });
    expect(result).toContain("## Prior Iterations");
    expect(result).toContain("prior table");
  });

  test("includes test file content in fenced typescript block", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("```typescript");
    expect(result).toContain(base.testFileContent);
  });

  test("instructs to fix only failing ACs and not source code", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("Fix ONLY the failing test assertions");
    expect(result).toContain("Do NOT modify source code");
  });
});
