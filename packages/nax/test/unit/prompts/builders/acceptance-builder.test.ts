import { describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import type { FailedCriterion } from "@/acceptance";
import { AcceptancePromptBuilder, MAX_FILE_LINES } from "@/prompts";

const builder = new AcceptancePromptBuilder();

function criterion(overrides: Partial<FailedCriterion> = {}): FailedCriterion {
  return { acId: "AC-1", storyId: "US-001", original: "does the thing", refined: "does the thing", ...overrides };
}

describe("AcceptancePromptBuilder.buildPathCorrection", () => {
  const target = "/repo/apps/web/.nax/features/foo/.nax-acceptance.test.tsx";

  test("embeds the exact target path", () => {
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt).toContain(target);
  });

  test("instructs the agent not to rename/sanitize and to preserve content", () => {
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt.toLowerCase()).toContain("exact");
    expect(prompt.toLowerCase()).toContain("do not");
    expect(prompt.toLowerCase()).toContain("preserve");
  });

  test("ends its Requirements with P1 and still names the target path (US-001 AC7)", () => {
    const target = "/r/.nax/features/f/.nax-acceptance.test.ts";
    const prompt = new AcceptancePromptBuilder().buildPathCorrection(target);
    expect(prompt).toContain("Keep every acceptance test in this one file; do not create a second test file.");
    expect(prompt).toContain(target);
  });
});

describe("AcceptancePromptBuilder.buildGeneratorFromPRDPrompt path anchor", () => {
  const packageStoryPath = "/repo/packages/core/.nax/features/foo/.nax-acceptance.test.ts";

  function renderPackageStoryPrompt(): string {
    return new AcceptancePromptBuilder().buildGeneratorFromPRDPrompt({
      featureName: "foo",
      criteriaList: "AC-1: does the thing",
      frameworkOverrideLine: "",
      targetTestFilePath: packageStoryPath,
    });
  }

  test("does not derive the package root by walking up from the test file", () => {
    const prompt = renderPackageStoryPrompt();
    expect(prompt).toContain(packageStoryPath);
    expect(prompt).not.toContain("3 levels above");
    expect(prompt).not.toContain("../../../");
    expect(prompt).not.toContain("package root");
  });

  test("frames the path as repo-rooted and orchestrator-computed", () => {
    const prompt = renderPackageStoryPrompt();
    expect(prompt).toContain("repo-rooted");
    expect(prompt).toContain("computed by the orchestrator");
    expect(prompt).toContain("package's own `.nax/features/`");
  });

  test("frames Process cwd as the package's own root (manifest dir)", () => {
    const prompt = renderPackageStoryPrompt();
    expect(prompt).toContain("package's own root");
    expect(prompt).toContain("manifest");
    expect(prompt).not.toContain("join(import.meta.dir");
  });
});

describe("AcceptancePromptBuilder.buildLoadRepairPrompt", () => {
  const target = "/r/t.test.ts";
  const tail = "error: Cannot find module 'x'";
  const G2 =
    "The file must load before the implementation exists. In languages that resolve imports at runtime (TypeScript, JavaScript, Python), import modules this feature adds inside each test rather than at the top of the file, so a missing module fails only the tests that use it.";

  function renderLoadRepairPrompt(): string {
    return new AcceptancePromptBuilder().buildLoadRepairPrompt(target, tail);
  }

  test("names the target path so the repair edits the right file", () => {
    expect(renderLoadRepairPrompt()).toContain(target);
  });

  test("includes the output tail in a fenced block", () => {
    const prompt = renderLoadRepairPrompt();
    expect(prompt).toContain(tail);
    expect(prompt).toContain("```");
  });

  test("asks for the smallest edit that makes the file load while keeping every AC-N test", () => {
    const prompt = renderLoadRepairPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("smallest");
    expect(lower).toContain("load");
    expect(prompt).toContain("AC-N");
  });

  test("repeats G2 verbatim", () => {
    expect(renderLoadRepairPrompt()).toContain(G2);
  });
});

// ─── Generator prompts ───────────────────────────────────────────────────────

describe("AcceptancePromptBuilder.buildGeneratorFromPRDPrompt", () => {
  test("includes the framework override line only when one is given", () => {
    const base = {
      featureName: "foo",
      criteriaList: "AC-1: does the thing",
      targetTestFilePath: "/repo/.nax/features/foo/.nax-acceptance.test.ts",
    };
    expect(builder.buildGeneratorFromPRDPrompt({ ...base, frameworkOverrideLine: "" })).not.toContain(
      "Use Bun test (describe/test/expect)",
    );
    expect(
      builder.buildGeneratorFromPRDPrompt({ ...base, frameworkOverrideLine: "Use Bun test (describe/test/expect)" }),
    ).toContain("Use Bun test (describe/test/expect)");
  });

  test("embeds each implementation-context file only when context is supplied", () => {
    const base = {
      featureName: "foo",
      criteriaList: "AC-1: does the thing",
      frameworkOverrideLine: "",
      targetTestFilePath: "/repo/.nax/features/foo/.nax-acceptance.test.ts",
    };
    const withContext = builder.buildGeneratorFromPRDPrompt({
      ...base,
      implementationContext: [{ path: "src/add.ts", content: "export const add = (a, b) => a + b;" }],
    });
    expect(withContext).toContain("## Implementation (already exists)");
    expect(withContext).toContain("### src/add.ts");
    expect(withContext).toContain("export const add = (a, b) => a + b;");
    expect(builder.buildGeneratorFromPRDPrompt({ ...base, implementationContext: [] })).not.toContain(
      "## Implementation (already exists)",
    );
  });
});

describe("AcceptancePromptBuilder.buildGeneratorFromSpecPrompt", () => {
  const prompt = builder.buildGeneratorFromSpecPrompt({
    featureName: "foo",
    criteriaList: "AC-1: does the thing",
    resolvedTestPath: ".nax-acceptance.test.ts",
  });

  test("names the feature and its criteria", () => {
    expect(prompt).toContain('"foo"');
    expect(prompt).toContain("AC-1: does the thing");
  });

  test("asks for raw code rather than a fenced block", () => {
    expect(prompt).toContain("Output raw code only");
  });

  test("anchors the saved path at the feature dir three levels above __dirname", () => {
    expect(prompt).toContain("<repo-root>/.nax/features/foo/.nax-acceptance.test.ts");
    expect(prompt).toContain("3 `../` levels above `__dirname`");
  });
});

// ─── Diagnosis prompts ───────────────────────────────────────────────────────

describe("AcceptancePromptBuilder.buildDiagnosisPromptTemplate", () => {
  test("renders the supplied sections verbatim", () => {
    const prompt = builder.buildDiagnosisPromptTemplate({
      truncatedOutput: "1 failed",
      acceptanceTestPath: "/repo/.nax/features/foo/.nax-acceptance.test.ts",
      sourceFilesSection: "FILE: src/add.ts",
      maxFileLines: MAX_FILE_LINES,
      failedCriteriaSection: "FAILING ACCEPTANCE CRITERIA:\nAC-1 [US-001]: adds numbers",
    });
    expect(prompt).toContain("1 failed");
    expect(prompt).toContain("/repo/.nax/features/foo/.nax-acceptance.test.ts");
    expect(prompt).toContain("FILE: src/add.ts");
    expect(prompt).toContain(`up to ${MAX_FILE_LINES} lines each`);
    expect(prompt).toContain("AC-1 [US-001]: adds numbers");
  });

  test("falls back to a criterion-unavailable note when no criteria are given", () => {
    const prompt = builder.buildDiagnosisPromptTemplate({
      truncatedOutput: "1 failed",
      acceptanceTestPath: "/t.ts",
      sourceFilesSection: "(none)",
      maxFileLines: MAX_FILE_LINES,
    });
    expect(prompt).toContain("(criterion text unavailable — judge from the test file and the output)");
  });

  test("demands a verdict JSON object and no prose", () => {
    const prompt = builder.buildDiagnosisPromptTemplate({
      truncatedOutput: "1 failed",
      acceptanceTestPath: "/t.ts",
      sourceFilesSection: "(none)",
      maxFileLines: MAX_FILE_LINES,
    });
    expect(prompt).toContain('"verdict": "source_bug" | "test_bug" | "both"');
    expect(prompt).toContain("Respond with ONLY a JSON object");
  });
});

describe("AcceptancePromptBuilder.buildDiagnosisPrompt", () => {
  test("drops (pass) lines from the raw output and keeps the failure detail", () => {
    const prompt = builder.buildDiagnosisPrompt({
      testOutput: "(pass) AC-1: adds\n(fail) AC-2: subtracts\nExpected 1, received 2",
      acceptanceTestPath: "/repo/.nax/features/foo/.nax-acceptance.test.ts",
      sourceFiles: [{ path: "src/add.ts", content: "export const add = 1;" }],
    });
    expect(prompt).not.toContain("(pass) AC-1: adds");
    expect(prompt).toContain("subtracts");
    expect(prompt).toContain("FILE: src/add.ts");
  });

  test("says so when no source files could be resolved", () => {
    const prompt = builder.buildDiagnosisPrompt({ testOutput: "boom", sourceFiles: [] });
    expect(prompt).toContain("(No source files could be resolved from imports)");
  });

  test("substitutes a path-unavailable note when the acceptance path is unknown", () => {
    const prompt = builder.buildDiagnosisPrompt({ testOutput: "boom", sourceFiles: [] });
    expect(prompt).toContain("(path unavailable — inspect test output for file references)");
  });

  test("renders failed criteria with the original wording when it differs from the refined one", () => {
    const prompt = builder.buildDiagnosisPrompt({
      testOutput: "boom",
      sourceFiles: [],
      failedCriteria: [criterion({ original: "adds numbers", refined: "returns 3 for 1 + 2" })],
    });
    expect(prompt).toContain("AC-1 [US-001]: returns 3 for 1 + 2");
    expect(prompt).toContain("Spec wording: adds numbers");
  });

  test("omits the spec-wording line when original and refined agree", () => {
    const prompt = builder.buildDiagnosisPrompt({ testOutput: "boom", sourceFiles: [], failedCriteria: [criterion()] });
    expect(prompt).not.toContain("Spec wording:");
  });
});

// ─── Fix prompts ─────────────────────────────────────────────────────────────

describe("AcceptancePromptBuilder.buildSourceFixPrompt", () => {
  const base = { testOutput: "1 failed", acceptanceTestPath: "/repo/.nax/features/foo/.nax-acceptance.test.ts" };

  test("names the failure, forbids test edits and forbids shims", () => {
    const prompt = builder.buildSourceFixPrompt(base);
    expect(prompt).toContain("fix the source implementation");
    expect(prompt).toContain("Do NOT modify the test file");
    expect(prompt).toContain("Do not add aliases, wrapper exports");
    expect(prompt).toContain(`ACCEPTANCE TEST FILE: ${base.acceptanceTestPath}`);
  });

  test("renders the framework hint only when a test command is known", () => {
    expect(builder.buildSourceFixPrompt({ ...base, testCommand: "bun test" })).toContain(
      "Test framework: Use Bun test (describe/test/expect)",
    );
    expect(builder.buildSourceFixPrompt(base)).not.toContain("Test framework:");
  });

  test("renders failing criteria, falling back to an unavailable note", () => {
    const withCriteria = builder.buildSourceFixPrompt({
      ...base,
      failedCriteria: [criterion({ refined: "returns 3", original: "adds numbers" })],
    });
    expect(withCriteria).toContain("AC-1 [US-001]: returns 3");
    expect(withCriteria).toContain("Spec wording: adds numbers");
    expect(builder.buildSourceFixPrompt({ ...base, failedCriteria: [] })).toContain(
      "FAILING ACCEPTANCE CRITERIA: (criterion text unavailable)",
    );
  });

  test("carries the diagnosis and prior-iteration blocks when supplied", () => {
    const prompt = builder.buildSourceFixPrompt({
      ...base,
      diagnosisReasoning: "the source returns a string",
      priorIterationsBlock: "## Prior attempts\n- attempt 1: failed\n\n",
    });
    expect(prompt).toContain("DIAGNOSIS:\nthe source returns a string");
    expect(prompt).toContain("## Prior attempts");
  });

  test("offers only the raw rerun line when no scoped command key is configured", () => {
    const prompt = builder.buildSourceFixPrompt({ ...base, testCommand: "bun test {{files}}" });
    expect(prompt).toContain("- Re-run the failing acceptance test before you finish: `bun test {{files}}`.");
    expect(prompt).not.toContain("<!--nax:run-test");
  });

  test("renders the run-test affordance region when the scoped key is declared", () => {
    const prompt = builder.buildSourceFixPrompt({
      ...base,
      testCommand: "bun test {{files}}",
      scopedCommandName: "testScoped",
    });
    expect(prompt).toContain("<!--nax:run-test:");
    expect(prompt).toContain('"command":"testScoped"');
    expect(prompt).toContain(`"files":${JSON.stringify(base.acceptanceTestPath)}`);
    expect(prompt).toContain("<!--/nax:run-test-->");
  });

  test("never emits the region with an empty files value", () => {
    const prompt = builder.buildSourceFixPrompt({
      testOutput: "1 failed",
      acceptanceTestPath: "",
      testCommand: "bun test {{files}}",
      scopedCommandName: "testScoped",
    });
    expect(prompt).not.toContain("<!--nax:run-test");
    expect(prompt).toContain("- Re-run the failing acceptance test before you finish: `bun test {{files}}`.");
  });

  test("emits no rerun line at all without a test command", () => {
    expect(builder.buildSourceFixPrompt(base)).not.toContain("Re-run the failing acceptance test");
  });
});

describe("AcceptancePromptBuilder.buildTestFixPrompt", () => {
  const base = {
    testOutput: "1 failed",
    failedACs: ["AC-1", "AC-2"],
    acceptanceTestPath: "/repo/.nax/features/foo/.nax-acceptance.test.ts",
  };

  test("lists the failing ACs and scopes the edit to their assertions", () => {
    const prompt = builder.buildTestFixPrompt(base);
    expect(prompt).toContain("FAILING ACS: AC-1, AC-2");
    expect(prompt).toContain("locate the failing AC blocks and adjust their assertions only");
    expect(prompt).toContain("Do NOT modify passing tests. Do NOT modify source code.");
    expect(prompt).toContain(`ACCEPTANCE TEST FILE: ${base.acceptanceTestPath}`);
  });

  test("renders the framework hint, diagnosis and prior-iteration blocks when supplied", () => {
    const prompt = builder.buildTestFixPrompt({
      ...base,
      testCommand: "pytest",
      diagnosisReasoning: "the test asserts the wrong name",
      priorIterationsBlock: "## Prior attempts\n- attempt 1: failed\n\n",
    });
    expect(prompt).toContain("Test framework: Use pytest");
    expect(prompt).toContain("DIAGNOSIS:\nthe test asserts the wrong name");
    expect(prompt).toContain("## Prior attempts");
  });

  test("renders the run-test affordance region when the scoped key is declared", () => {
    const prompt = builder.buildTestFixPrompt({
      ...base,
      testCommand: "bun test {{files}}",
      scopedCommandName: "testScoped",
    });
    expect(prompt).toContain('"command":"testScoped"');
    expect(prompt).toContain(`"files":${JSON.stringify(base.acceptanceTestPath)}`);
  });
});

describe("AcceptancePromptBuilder.buildFixGeneratorPrompt", () => {
  const prd = makePRD({
    userStories: [makeStory({ id: "US-001", title: "Adds", description: "Adds numbers" })],
  });

  test("lists each failed AC with its text, marking unknown text", () => {
    const prompt = builder.buildFixGeneratorPrompt({
      batchedACs: ["AC-1", "AC-2"],
      acTextMap: { "AC-1": "adds numbers" },
      testOutput: "1 failed",
      relatedStories: [],
      prd,
    });
    expect(prompt).toContain("AC-1: adds numbers");
    expect(prompt).toContain("AC-2: No description available");
    expect(prompt).toContain("FAILED ACCEPTANCE CRITERIA (2 total)");
  });

  test("renders the related stories and skips ids the PRD does not contain", () => {
    const prompt = builder.buildFixGeneratorPrompt({
      batchedACs: ["AC-1"],
      acTextMap: {},
      testOutput: "1 failed",
      relatedStories: ["US-001", "US-999"],
      prd,
    });
    expect(prompt).toContain("US-001: Adds\n  Adds numbers");
    expect(prompt).not.toContain("US-999");
  });

  test("names the test file only when one is supplied", () => {
    const base = { batchedACs: ["AC-1"], acTextMap: {}, testOutput: "1 failed", relatedStories: [], prd };
    expect(builder.buildFixGeneratorPrompt(base)).not.toContain("ACCEPTANCE TEST FILE:");
    expect(builder.buildFixGeneratorPrompt({ ...base, testFilePath: "/t.test.ts" })).toContain(
      "ACCEPTANCE TEST FILE: /t.test.ts",
    );
  });

  test("caps the failure output at 2000 characters and asks for plain text", () => {
    const prompt = builder.buildFixGeneratorPrompt({
      batchedACs: ["AC-1"],
      acTextMap: {},
      testOutput: "x".repeat(3000),
      relatedStories: [],
      prd,
    });
    expect(prompt).toContain("x".repeat(2000));
    expect(prompt).not.toContain("x".repeat(2001));
    expect(prompt).toContain("Respond with ONLY the fix description");
  });
});

// ─── Refinement prompt ───────────────────────────────────────────────────────

describe("AcceptancePromptBuilder.buildRefinementPrompt", () => {
  test("numbers the criteria and wraps the prompt in the JSON-only envelope", () => {
    const prompt = builder.buildRefinementPrompt(["adds numbers", "subtracts numbers"], "");
    expect(prompt).toContain("1. adds numbers");
    expect(prompt).toContain("2. subtracts numbers");
    expect(prompt).toContain('"refined": "<concrete, machine-verifiable description>"');
    expect(prompt).toContain("YOUR RESPONSE MUST START WITH { OR [");
  });

  test("includes story context and codebase context only when supplied", () => {
    const bare = builder.buildRefinementPrompt(["a"], "");
    expect(bare).not.toContain("STORY CONTEXT:");
    expect(bare).not.toContain("CODEBASE CONTEXT:");

    const full = builder.buildRefinementPrompt(["a"], "src/add.ts", {
      storyTitle: "Adds",
      storyDescription: "Adds numbers",
    });
    expect(full).toContain("STORY CONTEXT:\nTitle: Adds\nDescription: Adds numbers");
    expect(full).toContain("CODEBASE CONTEXT:\nsrc/add.ts");
  });

  test.each([
    ["component", "TEST STRATEGY: component", "Text content visible on screen matches expected"],
    ["cli", "TEST STRATEGY: cli", "stdout contains expected text"],
    ["e2e", "TEST STRATEGY: e2e", '"HTTP status 200 returned"'],
  ] as const)("appends the %s strategy section and example", (testStrategy, sectionLine, example) => {
    const prompt = builder.buildRefinementPrompt(["a"], "", { testStrategy });
    expect(prompt).toContain(sectionLine);
    expect(prompt).toContain(example);
  });

  test("appends the framework line to a strategy section", () => {
    const prompt = builder.buildRefinementPrompt(["a"], "", { testStrategy: "component", testFramework: "React" });
    expect(prompt).toContain("Use React testing library syntax.");
  });

  test("a known strategy without a framework adds no usage sentence", () => {
    const prompt = builder.buildRefinementPrompt(["a"], "", { testStrategy: "cli" });
    expect(prompt).not.toContain("testing library syntax");
  });

  test("an unknown or missing strategy renders only the framework line, or nothing", () => {
    // "unit"/"snapshot" have no dedicated section — the framework hint is all they get.
    expect(builder.buildRefinementPrompt(["a"], "", { testStrategy: "unit" })).not.toContain("TEST STRATEGY:");
    expect(builder.buildRefinementPrompt(["a"], "", { testStrategy: "unit", testFramework: "Vitest" })).toContain(
      "TEST FRAMEWORK: Vitest",
    );
    expect(builder.buildRefinementPrompt(["a"], "")).not.toContain("TEST FRAMEWORK:");
  });

  test("the default refined example is the generic assertion form", () => {
    expect(builder.buildRefinementPrompt(["a"], "")).toContain(
      '"Array of length N returned", "HTTP status 200 returned"',
    );
  });
});
