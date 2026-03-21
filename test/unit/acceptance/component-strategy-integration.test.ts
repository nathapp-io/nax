/**
 * ACS-005: Integration test — component strategy end-to-end with Ink project
 *
 * Covers:
 * - Integration test with testStrategy='component' and testFramework='ink-testing-library'
 * - Generated code imports render from ink-testing-library
 * - Generated code uses lastFrame() for assertions
 * - Generated code uses Bun.spawn when strategy is 'cli'
 * - Generated code defaults to import-and-call pattern when strategy is unset
 * - Generated test file is syntactically valid TypeScript
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _generatorPRDDeps, generateFromPRD } from "../../../src/acceptance/generator";
import { buildCliTemplate, buildComponentTemplate } from "../../../src/acceptance/templates";
import type { AcceptanceCriterion, GenerateFromPRDOptions, RefinedCriterion } from "../../../src/acceptance/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(): NaxConfig {
  return {
    version: 1,
    models: {
      fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
      powerful: { provider: "anthropic", model: "claude-opus-4-5" },
    },
    autoMode: {
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: false, tierOrder: [{ tier: "fast", attempts: 3 }] },
    },
    analyze: {
      llmEnhanced: false,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 5000,
    },
    routing: {
      strategy: "keyword",
      adaptive: { minSamples: 10, costThreshold: 0.8, fallbackStrategy: "keyword" },
      llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: false, mode: "hybrid", timeoutMs: 5000 },
    },
    execution: {
      maxIterations: 5,
      iterationDelayMs: 0,
      costLimit: 10,
      sessionTimeoutSeconds: 60,
      verificationTimeoutSeconds: 60,
      maxStoriesPerFeature: 100,
      rectification: {
        enabled: false,
        maxRetries: 1,
        fullSuiteTimeoutSeconds: 60,
        maxFailureSummaryChars: 1000,
        abortOnIncreasingFailures: false,
      },
      regressionGate: { enabled: false, timeoutSeconds: 60, acceptOnTimeout: true, maxRectificationAttempts: 1 },
      contextProviderTokenBudget: 1000,
      smartTestRunner: false,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: false,
      commands: {},
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      dangerouslySkipPermissions: true,
      drainTimeoutMs: 0,
      shell: "/bin/sh",
      stripEnvVars: [],
      environmentalEscalationDivisor: 2,
    },
    tdd: {
      maxRetries: 1,
      autoVerifyIsolation: false,
      autoApproveVerifier: true,
      strategy: "off",
      sessionTiers: { testWriter: "fast", verifier: "fast" },
      testWriterAllowedPaths: [],
      rollbackOnFailure: false,
      greenfieldDetection: false,
    },
    constitution: { enabled: false, path: "constitution.md", maxTokens: 0 },
    review: { enabled: false, checks: [], commands: {} },
    plan: { model: "balanced", outputPath: "spec.md" },
    acceptance: {
      enabled: true,
      maxRetries: 1,
      generateTests: false,
      testPath: "acceptance.test.ts",
      model: "fast",
      refinement: false,
      redGate: false,
    },
    context: {
      fileInjection: "disabled",
      testCoverage: {
        enabled: false,
        detail: "names-and-counts",
        maxTokens: 0,
        testPattern: "**/*.test.ts",
        scopeToStory: false,
      },
      autoDetect: { enabled: false, maxFiles: 0, traceImports: false },
    },
    interaction: {
      plugin: "cli",
      config: {},
      defaults: { timeout: 1000, fallback: "escalate" },
      triggers: {},
    },
    precheck: {
      storySizeGate: { enabled: false, maxAcCount: 10, maxDescriptionLength: 5000, maxBulletPoints: 20 },
    },
    prompts: {},
    decompose: {
      trigger: "disabled",
      maxAcceptanceCriteria: 6,
      maxSubstories: 5,
      maxSubstoryComplexity: "medium",
      maxRetries: 1,
      model: "balanced",
    },
  };
}

function makeInkStory(): UserStory {
  return {
    id: "INK-001",
    title: "Ink counter component",
    description: "A simple Ink component that displays a counter",
    acceptanceCriteria: [
      "Component renders initial count of 0",
      "Component displays count in output",
    ],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeInkCriteria(storyId: string): RefinedCriterion[] {
  return [
    {
      original: "Component renders initial count of 0",
      refined: "lastFrame() contains '0' when component is rendered with default props",
      testable: true,
      storyId,
    },
    {
      original: "Component displays count in output",
      refined: "lastFrame() contains the current count value",
      testable: true,
      storyId,
    },
  ];
}

function makeInkCriteriaItems(): AcceptanceCriterion[] {
  return [
    { id: "AC-1", text: "Component renders initial count of 0", lineNumber: 1 },
    { id: "AC-2", text: "Component displays count in output", lineNumber: 2 },
  ];
}

function makeOptions(workdir: string, overrides?: Partial<GenerateFromPRDOptions>): GenerateFromPRDOptions {
  return {
    featureName: "ink-counter",
    workdir,
    featureDir: workdir,
    codebaseContext: "src/\n  Counter.tsx\n",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    config: makeConfig(),
    ...overrides,
  };
}

let savedComplete: typeof _generatorPRDDeps.adapter.complete;
let savedWriteFile: typeof _generatorPRDDeps.writeFile;

function saveDeps() {
  savedComplete = _generatorPRDDeps.adapter.complete;
  savedWriteFile = _generatorPRDDeps.writeFile;
}

function restoreDeps() {
  _generatorPRDDeps.adapter.complete = savedComplete;
  _generatorPRDDeps.writeFile = savedWriteFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 + AC-2 + AC-3: Component strategy integration — ink-testing-library
// End-to-end: generateFromPRD with component strategy produces valid test code
// ─────────────────────────────────────────────────────────────────────────────

describe("component strategy integration — ink project fixture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-ink-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
    mock.restore();
  });

  test("generateFromPRD with component strategy produces code that imports from ink-testing-library", async () => {
    const story = makeInkStory();
    const criteria = makeInkCriteria(story.id);
    const options = makeOptions(tmpDir, {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });

    const expectedCode = `import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { InkCounter } from "../src/ink-counter";

describe("ink-counter - Acceptance Tests", () => {
  test("AC-1: Component renders initial count of 0", () => {
    const { lastFrame } = render(<InkCounter />);
    expect(lastFrame()).toContain(""); // Replace with expected output
  });

  test("AC-2: Component displays count in output", () => {
    const { lastFrame } = render(<InkCounter />);
    expect(lastFrame()).toContain(""); // Replace with expected output
  });
});
`;

    _generatorPRDDeps.adapter.complete = mock(async () => expectedCode);
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("ink-testing-library");
  });

  test("generateFromPRD with component strategy produces code that uses lastFrame()", async () => {
    const story = makeInkStory();
    const criteria = makeInkCriteria(story.id);
    const options = makeOptions(tmpDir, {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });

    const expectedCode = `import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { InkCounter } from "../src/ink-counter";

describe("ink-counter - Acceptance Tests", () => {
  test("AC-1: Component renders initial count of 0", () => {
    const { lastFrame } = render(<InkCounter />);
    expect(lastFrame()).toContain("0");
  });
});
`;

    _generatorPRDDeps.adapter.complete = mock(async () => expectedCode);
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("lastFrame()");
  });

  test("generateFromPRD with component strategy produces syntactically valid TypeScript structure", async () => {
    const story = makeInkStory();
    const criteria = makeInkCriteria(story.id);
    const options = makeOptions(tmpDir, {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });

    const expectedCode = `import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { InkCounter } from "../src/ink-counter";

describe("ink-counter - Acceptance Tests", () => {
  test("AC-1: Component renders initial count of 0", () => {
    const { lastFrame } = render(<InkCounter />);
    expect(lastFrame()).toContain("0");
  });
});
`;

    _generatorPRDDeps.adapter.complete = mock(async () => expectedCode);
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    // Valid TS structure checks
    expect(result.testCode).toContain("import");
    expect(result.testCode).toContain("describe(");
    expect(result.testCode).toContain("test(");
    expect(result.testCode).toContain("expect(");
  });

  test("generateFromPRD prompt includes ink-testing-library instructions when strategy is component", async () => {
    const story = makeInkStory();
    const criteria = makeInkCriteria(story.id);
    const options = makeOptions(tmpDir, {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });

    let capturedPrompt = "";
    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test"; describe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    const promptLower = capturedPrompt.toLowerCase();
    expect(
      promptLower.includes("ink-testing-library") || promptLower.includes("lastframe") || promptLower.includes("render"),
    ).toBe(true);
  });

  test("buildComponentTemplate for ink-testing-library fixture produces correct structure", () => {
    const criteria = makeInkCriteriaItems();
    const code = buildComponentTemplate({
      featureName: "ink-counter",
      criteria,
      testFramework: "ink-testing-library",
    });

    expect(code).toContain("ink-testing-library");
    expect(code).toContain("render(");
    expect(code).toContain("lastFrame()");
    expect(code).toContain('from "bun:test"');
    expect(code).toContain("describe(");
    expect(code).toContain("AC-1");
    expect(code).toContain("AC-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: CLI strategy generator output — Bun.spawn usage
// Unit test verifying Bun.spawn is present in generated code
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI strategy generator — Bun.spawn usage unit test", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-cli-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
    mock.restore();
  });

  test("buildCliTemplate generates code with Bun.spawn call", () => {
    const criteria = makeInkCriteriaItems();
    const code = buildCliTemplate({ featureName: "my-cli-tool", criteria });

    expect(code).toContain("Bun.spawn");
  });

  test("buildCliTemplate generates code referencing stdout", () => {
    const criteria = makeInkCriteriaItems();
    const code = buildCliTemplate({ featureName: "my-cli-tool", criteria });

    expect(code).toContain("stdout");
  });

  test("buildCliTemplate generates code with proc.exited awaited concurrently with stdout", () => {
    const criteria = makeInkCriteriaItems();
    const code = buildCliTemplate({ featureName: "my-cli-tool", criteria });

    // Should use Promise.all pattern for concurrent read (matches project async patterns)
    expect(code).toContain("Promise.all");
  });

  test("buildCliTemplate generated code contains exit code assertion", () => {
    const criteria = makeInkCriteriaItems();
    const code = buildCliTemplate({ featureName: "my-cli-tool", criteria });

    expect(code).toContain("exitCode");
  });

  test("generateFromPRD with cli strategy uses 3-step language-agnostic prompt", async () => {
    const story = makeInkStory();
    const criteria = makeInkCriteria(story.id);
    const options = makeOptions(tmpDir, { testStrategy: "cli" });

    let capturedPrompt = "";
    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test"; describe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain("Step 1: Understand and Classify");
    expect(capturedPrompt).toContain("Step 2: Explore the Project");
    expect(capturedPrompt).toContain("NEVER use placeholder assertions");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Default (no testStrategy) — import-and-call pattern
// ─────────────────────────────────────────────────────────────────────────────

describe("default strategy — import-and-call pattern when testStrategy is unset", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-default-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
    mock.restore();
  });

  test("generateFromPRD prompt does not include component/cli/e2e instructions when testStrategy is omitted", async () => {
    const story = makeInkStory();
    // Use neutral criteria that don't contain strategy-specific keywords
    const criteria: RefinedCriterion[] = [
      { original: "function returns correct value", refined: "add(1, 2) returns 3", testable: true, storyId: story.id },
      { original: "handles zero input", refined: "add(0, 0) returns 0", testable: true, storyId: story.id },
    ];
    const options = makeOptions(tmpDir); // no testStrategy

    let capturedPrompt = "";
    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test"; describe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    const promptLower = capturedPrompt.toLowerCase();
    expect(promptLower).not.toContain("bun.spawn");
    expect(promptLower).not.toContain("fetch(");
    expect(promptLower).not.toContain("tomatchsnapshot");
    expect(promptLower).not.toContain("lastframe");
  });

  test("generateFromPRD with no testStrategy returns bun:test import in code", async () => {
    const story = makeInkStory();
    const criteria: RefinedCriterion[] = [
      { original: "function returns correct value", refined: "add(1, 2) returns 3", testable: true, storyId: story.id },
    ];
    const options = makeOptions(tmpDir);

    const unitCode = `import { describe, test, expect } from "bun:test";

describe("ink-counter - Acceptance Tests", () => {
  test("AC-1: Component renders initial count of 0", async () => {
    // import and call the function directly
    expect(true).toBe(true);
  });
});
`;

    _generatorPRDDeps.adapter.complete = mock(async () => unitCode);
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain('from "bun:test"');
    expect(result.testCode).not.toContain("ink-testing-library");
    expect(result.testCode).not.toContain("Bun.spawn");
  });
});
