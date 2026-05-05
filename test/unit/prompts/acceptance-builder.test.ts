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

    test("references acceptance test path (Bug 6 — no embedded body)", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain(base.acceptanceTestPath);
      expect(result).not.toContain("```typescript");
    });

    test("instructs agent to use Read on the test path", () => {
      const result = builder.buildDiagnosisPromptTemplate(base);
      expect(result).toContain("Read");
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
    testOutput: "(fail) AC-1: null pointer [2ms]\n  Error: Cannot read property\n\n 0 pass\n 1 fail",
    diagnosisReasoning: "Source file has uninitialized field",
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
  };

  test("includes structured test output (Bug 6 regression)", () => {
    const result = builder.buildSourceFixPrompt(base);
    expect(result).toContain("AC-1");
    expect(result).toContain("Cannot read property");
  });

  test("does not embed test file content (Bug 6 regression)", () => {
    const result = builder.buildSourceFixPrompt(base);
    expect(result).not.toContain("```typescript");
  });

  test("references acceptance test path", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain(base.acceptanceTestPath);
  });

  test("instructs agent to Read the test file", () => {
    const result = builder.buildSourceFixPrompt(base);
    expect(result).toContain("Read the test file at the path above");
  });

  test("includes diagnosis reasoning", () => {
    expect(builder.buildSourceFixPrompt(base)).toContain(base.diagnosisReasoning);
  });

  test("includes prior iterations block when provided", () => {
    const result = builder.buildSourceFixPrompt({ ...base, priorIterationsBlock: "## Prior Iterations\n\nprior table\n\n" });
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
    testOutput: "(pass) AC-1: ok [1ms]\n(fail) AC-2: assertion failed [2ms]\n  Error: Expected 1 got 0\n\n 1 pass\n 1 fail",
    diagnosisReasoning: "Test uses wrong assertion type",
    failedACs: ["AC-2"],
    acceptanceTestPath: "/project/.nax/features/feat/.nax-acceptance.test.ts",
  };

  test("includes failing ACs", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("AC-2");
  });

  test("does not embed test file content (Bug 6 regression)", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).not.toContain("```typescript");
  });

  test("drops (pass) lines from test output (Bug 6 regression)", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).not.toContain("(pass) AC-1");
    expect(result).toContain("AC-2");
    expect(result).toContain("Expected 1 got 0");
  });

  test("references acceptance test path", () => {
    expect(builder.buildTestFixPrompt(base)).toContain(base.acceptanceTestPath);
  });

  test("instructs agent to Read the test file", () => {
    const result = builder.buildTestFixPrompt(base);
    expect(result).toContain("Read the test file at the path above");
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
