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
import { applyProtocolRegions } from "@/prompts/sections";

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

  // #1939: source-fix/test-fix already have a working RunCommand (#1936/#1938) but
  // the prompt never said so — the test command was spent solely on the framework hint.
  // US-003 replaced the hedge wording ("if that tool is available to you")
  // with a protocol-region: the ACP body is the shell string, the native
  // body is the RunCommand call, and dispatch selects between them.
  describe("re-run affordance (#1939 / US-003)", () => {
    test("renders one region whose body is the shell command when scopedCommandName is given", () => {
      const result = builder.buildSourceFixPrompt({
        ...base,
        testCommand: "bun test /abs/path.ts",
        scopedCommandName: "testScoped",
      });
      expect(result).toContain("Re-run the failing acceptance test before you finish");
      // The shell string is the ACP body of the region.
      expect(result).toContain("`bun test /abs/path.ts`");
      // No hedge wording survives.
      expect(result).not.toContain("if that tool is available to you");
    });

    test("omits the RunCommand form when scopedCommandName is not given", () => {
      const result = builder.buildSourceFixPrompt({ ...base, testCommand: "bun test /abs/path.ts" });
      expect(result).toContain("Re-run the failing acceptance test before you finish: `bun test /abs/path.ts`");
      expect(result).not.toContain("RunCommand");
    });

    test("omits the affordance entirely when no testCommand was resolved", () => {
      const result = builder.buildSourceFixPrompt({ ...base, scopedCommandName: "testScoped" });
      expect(result).not.toContain("Re-run the failing acceptance test");
    });
  });

  // US-003 AC6: the rerun line, applied with native + advertised RunCommand,
  // renders a RunCommand call whose command is the scoped key and whose
  // values.files equals the acceptance test path.
  describe("re-run affordance (US-003)", () => {
    test("the rerun line, applied with native + RunCommand, renders a call carrying the scoped key and the acceptance path in values.files (US-003 AC6)", () => {
      const result = builder.buildSourceFixPrompt({
        ...base,
        testCommand: "bun test /abs/path.ts",
        scopedCommandName: "testScoped",
      });
      const native = applyProtocolRegions(result, {
        protocol: "native",
        advertisedTools: new Set(["RunCommand"]),
      });
      expect(native).toContain(
        'RunCommand {"command": "testScoped", "values": {"files": "/project/.nax/features/feat/.nax-acceptance.test.ts"}}',
      );
    });

    // US-003 AC7: with no resolved scoped key, the rerun line renders ONLY
    // the raw command string under both protocols and no RunCommand call.
    test("the rerun line without a scoped key renders only the raw command string under acp and no RunCommand call (US-003 AC7)", () => {
      const result = builder.buildSourceFixPrompt({ ...base, testCommand: "bun test /abs/path.ts" });
      const acp = applyProtocolRegions(result, { protocol: "acp" });
      expect(acp).toContain("`bun test /abs/path.ts`");
      expect(acp).not.toContain("RunCommand");
    });

    test("the rerun line without a scoped key renders only the raw command string under native and no RunCommand call (US-003 AC7)", () => {
      const result = builder.buildSourceFixPrompt({ ...base, testCommand: "bun test /abs/path.ts" });
      const native = applyProtocolRegions(result, { protocol: "native" });
      expect(native).toContain("`bun test /abs/path.ts`");
      expect(native).not.toContain("RunCommand");
    });

    // US-003 AC8: the rerun line contains no "if that tool is available to
    // you" hedge — it now renders one region whose body is the shell string.
    test("the rerun line contains no 'if that tool is available to you' phrase (US-003 AC8)", () => {
      const result = builder.buildSourceFixPrompt({
        ...base,
        testCommand: "bun test /abs/path.ts",
        scopedCommandName: "testScoped",
      });
      expect(result).not.toContain("if that tool is available to you");
    });
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

  // #1939: same affordance gap as buildSourceFixPrompt.
  // US-003 replaced the hedge wording ("if that tool is available to you")
  // with a protocol-region: the ACP body is the shell string, the native
  // body is the RunCommand call, and dispatch selects between them.
  describe("re-run affordance (#1939 / US-003)", () => {
    test("renders one region whose body is the shell command when scopedCommandName is given", () => {
      const result = builder.buildTestFixPrompt({
        ...base,
        testCommand: "bun test /abs/path.ts",
        scopedCommandName: "testScoped",
      });
      expect(result).toContain("Re-run the failing acceptance test before you finish");
      expect(result).toContain("`bun test /abs/path.ts`");
      expect(result).not.toContain("if that tool is available to you");
    });

    test("omits the RunCommand form when scopedCommandName is not given", () => {
      const result = builder.buildTestFixPrompt({ ...base, testCommand: "bun test /abs/path.ts" });
      expect(result).toContain("Re-run the failing acceptance test before you finish: `bun test /abs/path.ts`");
      expect(result).not.toContain("RunCommand");
    });

    test("omits the affordance entirely when no testCommand was resolved", () => {
      const result = builder.buildTestFixPrompt({ ...base, scopedCommandName: "testScoped" });
      expect(result).not.toContain("Re-run the failing acceptance test");
    });
  });

  // US-003: same affordance through the protocol region registry. The
  // rerun line now carries a region; the tests pin the ACs across both
  // builders.
  describe("re-run affordance (US-003)", () => {
    test("the rerun line, applied with native + RunCommand, renders a call carrying the scoped key and the acceptance path in values.files (US-003 AC6)", () => {
      const result = builder.buildTestFixPrompt({
        ...base,
        testCommand: "bun test /abs/path.ts",
        scopedCommandName: "testScoped",
      });
      const native = applyProtocolRegions(result, {
        protocol: "native",
        advertisedTools: new Set(["RunCommand"]),
      });
      expect(native).toContain(
        'RunCommand {"command": "testScoped", "values": {"files": "/project/.nax/features/feat/.nax-acceptance.test.ts"}}',
      );
    });

    test("the rerun line without a scoped key renders only the raw command string under acp and no RunCommand call (US-003 AC7)", () => {
      const result = builder.buildTestFixPrompt({ ...base, testCommand: "bun test /abs/path.ts" });
      const acp = applyProtocolRegions(result, { protocol: "acp" });
      expect(acp).toContain("`bun test /abs/path.ts`");
      expect(acp).not.toContain("RunCommand");
    });

    test("the rerun line without a scoped key renders only the raw command string under native and no RunCommand call (US-003 AC7)", () => {
      const result = builder.buildTestFixPrompt({ ...base, testCommand: "bun test /abs/path.ts" });
      const native = applyProtocolRegions(result, { protocol: "native" });
      expect(native).toContain("`bun test /abs/path.ts`");
      expect(native).not.toContain("RunCommand");
    });

    test("the rerun line contains no 'if that tool is available to you' phrase (US-003 AC8)", () => {
      const result = builder.buildTestFixPrompt({
        ...base,
        testCommand: "bun test /abs/path.ts",
        scopedCommandName: "testScoped",
      });
      expect(result).not.toContain("if that tool is available to you");
    });
  });

  test("omits the tool-call form when there is no acceptance test path to name", () => {
    // RunCommand keeps an empty `files` value verbatim and `bun test ''` exits 1
    // without running anything, so an empty path must degrade to the raw command.
    const prompt = new AcceptancePromptBuilder().buildSourceFixPrompt({
      testOutput: "boom",
      testCommand: "bun run test",
      acceptanceTestPath: "",
      scopedCommandName: "testScoped",
    });
    expect(prompt).not.toContain("RunCommand");
    expect(prompt).toContain("`bun run test`");
  });
});
