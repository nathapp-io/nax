/**
 * Tests for ACS-003: Strategy-aware acceptance test generator templates
 *
 * Covers:
 * - GenerateFromPRDOptions has optional testStrategy and testFramework fields
 * - Template builder functions exist and produce strategy-specific code structures
 * - generateFromPRD uses component template (ink-testing-library) when strategy='component'
 * - generateFromPRD uses cli template (Bun.spawn) when strategy='cli'
 * - generateFromPRD uses e2e template (fetch) when strategy='e2e'
 * - generateFromPRD uses snapshot template (toMatchSnapshot) when strategy='snapshot'
 * - generateFromPRD defaults to unit behavior when testStrategy is omitted
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _generatorPRDDeps, generateFromPRD } from "../../../src/acceptance/generator";
import {
  buildCliTemplate,
  buildComponentTemplate,
  buildE2eTemplate,
  buildSnapshotTemplate,
  buildUnitTemplate,
} from "../../../src/acceptance/templates";
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

function makeStory(): UserStory {
  return {
    id: "ACS-003",
    title: "Strategy-aware templates",
    description: "Generator uses templates based on strategy",
    acceptanceCriteria: ["template produces correct structure"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeCriteria(storyId: string): RefinedCriterion[] {
  return [
    { original: "renders component", refined: "Component renders correctly", testable: true, storyId },
    { original: "outputs to stdout", refined: "CLI outputs expected text to stdout", testable: true, storyId },
  ];
}

function makeCriteriaItems(): AcceptanceCriterion[] {
  return [
    { id: "AC-1", text: "Component renders correctly", lineNumber: 1 },
    { id: "AC-2", text: "CLI outputs expected text to stdout", lineNumber: 2 },
  ];
}

function makeOptions(workdir: string, overrides?: Partial<GenerateFromPRDOptions>): GenerateFromPRDOptions {
  return {
    featureName: "my-feature",
    workdir,
    featureDir: workdir,
    codebaseContext: "src/\n  index.ts\n",
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
// AC-1: GenerateFromPRDOptions type fields
// ─────────────────────────────────────────────────────────────────────────────

describe("GenerateFromPRDOptions — testStrategy and testFramework fields", () => {
  test("accepts testStrategy field without error", () => {
    const opts: GenerateFromPRDOptions = makeOptions(tmpdir(), { testStrategy: "unit" });
    expect(opts.testStrategy).toBe("unit");
  });

  test("accepts all valid testStrategy values", () => {
    const strategies = ["unit", "component", "cli", "e2e", "snapshot"] as const;
    for (const strategy of strategies) {
      const opts: GenerateFromPRDOptions = makeOptions(tmpdir(), { testStrategy: strategy });
      expect(opts.testStrategy).toBe(strategy);
    }
  });

  test("accepts testFramework field without error", () => {
    const opts: GenerateFromPRDOptions = makeOptions(tmpdir(), { testFramework: "ink-testing-library" });
    expect(opts.testFramework).toBe("ink-testing-library");
  });

  test("testStrategy is optional — omitting it leaves field undefined", () => {
    const opts: GenerateFromPRDOptions = makeOptions(tmpdir());
    expect(opts.testStrategy).toBeUndefined();
  });

  test("testFramework is optional — omitting it leaves field undefined", () => {
    const opts: GenerateFromPRDOptions = makeOptions(tmpdir());
    expect(opts.testFramework).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: Template functions exist in src/acceptance/templates/
// ─────────────────────────────────────────────────────────────────────────────

describe("Template functions — exist and are callable", () => {
  test("buildUnitTemplate is a function", () => {
    expect(typeof buildUnitTemplate).toBe("function");
  });

  test("buildComponentTemplate is a function", () => {
    expect(typeof buildComponentTemplate).toBe("function");
  });

  test("buildCliTemplate is a function", () => {
    expect(typeof buildCliTemplate).toBe("function");
  });

  test("buildE2eTemplate is a function", () => {
    expect(typeof buildE2eTemplate).toBe("function");
  });

  test("buildSnapshotTemplate is a function", () => {
    expect(typeof buildSnapshotTemplate).toBe("function");
  });

  test("buildUnitTemplate returns a string", () => {
    const result = buildUnitTemplate({ featureName: "test", criteria: makeCriteriaItems() });
    expect(typeof result).toBe("string");
  });

  test("buildComponentTemplate returns a string", () => {
    const result = buildComponentTemplate({ featureName: "test", criteria: makeCriteriaItems() });
    expect(typeof result).toBe("string");
  });

  test("buildCliTemplate returns a string", () => {
    const result = buildCliTemplate({ featureName: "test", criteria: makeCriteriaItems() });
    expect(typeof result).toBe("string");
  });

  test("buildE2eTemplate returns a string", () => {
    const result = buildE2eTemplate({ featureName: "test", criteria: makeCriteriaItems() });
    expect(typeof result).toBe("string");
  });

  test("buildSnapshotTemplate returns a string", () => {
    const result = buildSnapshotTemplate({ featureName: "test", criteria: makeCriteriaItems() });
    expect(typeof result).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: Template output is valid TypeScript structure
// ─────────────────────────────────────────────────────────────────────────────

describe("buildUnitTemplate — unit strategy output structure", () => {
  const criteria = makeCriteriaItems();

  test("contains bun:test import", () => {
    const code = buildUnitTemplate({ featureName: "my-feature", criteria });
    expect(code).toContain('from "bun:test"');
  });

  test("contains describe block", () => {
    const code = buildUnitTemplate({ featureName: "my-feature", criteria });
    expect(code).toContain("describe(");
  });

  test("contains test() calls", () => {
    const code = buildUnitTemplate({ featureName: "my-feature", criteria });
    expect(code).toContain("test(");
  });

  test("contains expect() assertion", () => {
    const code = buildUnitTemplate({ featureName: "my-feature", criteria });
    expect(code).toContain("expect(");
  });

  test("contains import statement for the function under test", () => {
    const code = buildUnitTemplate({ featureName: "my-feature", criteria });
    expect(code).toContain("import");
  });

  test("includes AC-N naming for each criterion", () => {
    const code = buildUnitTemplate({ featureName: "my-feature", criteria });
    expect(code).toContain("AC-1");
    expect(code).toContain("AC-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: Component strategy — ink-testing-library
// ─────────────────────────────────────────────────────────────────────────────

describe("buildComponentTemplate — ink-testing-library output structure", () => {
  const criteria = makeCriteriaItems();

  test("contains render import from ink-testing-library when framework is ink-testing-library", () => {
    const code = buildComponentTemplate({
      featureName: "my-component",
      criteria,
      testFramework: "ink-testing-library",
    });
    expect(code).toContain("ink-testing-library");
  });

  test("contains render call", () => {
    const code = buildComponentTemplate({
      featureName: "my-component",
      criteria,
      testFramework: "ink-testing-library",
    });
    expect(code).toContain("render(");
  });

  test("contains lastFrame() assertion for ink-testing-library", () => {
    const code = buildComponentTemplate({
      featureName: "my-component",
      criteria,
      testFramework: "ink-testing-library",
    });
    expect(code).toContain("lastFrame()");
  });

  test("contains bun:test import", () => {
    const code = buildComponentTemplate({
      featureName: "my-component",
      criteria,
      testFramework: "ink-testing-library",
    });
    expect(code).toContain('from "bun:test"');
  });

  test("contains describe block", () => {
    const code = buildComponentTemplate({
      featureName: "my-component",
      criteria,
      testFramework: "ink-testing-library",
    });
    expect(code).toContain("describe(");
  });

  test("contains screen.getByText for react framework", () => {
    const code = buildComponentTemplate({
      featureName: "my-component",
      criteria,
      testFramework: "react",
    });
    expect(code).toContain("screen.getByText");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: CLI strategy — Bun.spawn + stdout
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCliTemplate — CLI strategy output structure", () => {
  const criteria = makeCriteriaItems();

  test("contains Bun.spawn call", () => {
    const code = buildCliTemplate({ featureName: "my-cli", criteria });
    expect(code).toContain("Bun.spawn");
  });

  test("contains stdout reference", () => {
    const code = buildCliTemplate({ featureName: "my-cli", criteria });
    expect(code).toContain("stdout");
  });

  test("contains bun:test import", () => {
    const code = buildCliTemplate({ featureName: "my-cli", criteria });
    expect(code).toContain('from "bun:test"');
  });

  test("contains describe block", () => {
    const code = buildCliTemplate({ featureName: "my-cli", criteria });
    expect(code).toContain("describe(");
  });

  test("contains expect() assertion", () => {
    const code = buildCliTemplate({ featureName: "my-cli", criteria });
    expect(code).toContain("expect(");
  });

  test("includes AC-N naming for each criterion", () => {
    const code = buildCliTemplate({ featureName: "my-cli", criteria });
    expect(code).toContain("AC-1");
    expect(code).toContain("AC-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: E2E strategy — fetch + response.text()
// ─────────────────────────────────────────────────────────────────────────────

describe("buildE2eTemplate — E2E strategy output structure", () => {
  const criteria = makeCriteriaItems();

  test("contains fetch() call", () => {
    const code = buildE2eTemplate({ featureName: "my-api", criteria });
    expect(code).toContain("fetch(");
  });

  test("contains response.text() or response.json() assertion", () => {
    const code = buildE2eTemplate({ featureName: "my-api", criteria });
    const hasTextOrJson = code.includes("response.text()") || code.includes(".text()") || code.includes(".json()");
    expect(hasTextOrJson).toBe(true);
  });

  test("contains localhost in the fetch URL", () => {
    const code = buildE2eTemplate({ featureName: "my-api", criteria });
    expect(code).toContain("localhost");
  });

  test("contains bun:test import", () => {
    const code = buildE2eTemplate({ featureName: "my-api", criteria });
    expect(code).toContain('from "bun:test"');
  });

  test("contains describe block", () => {
    const code = buildE2eTemplate({ featureName: "my-api", criteria });
    expect(code).toContain("describe(");
  });

  test("includes AC-N naming for each criterion", () => {
    const code = buildE2eTemplate({ featureName: "my-api", criteria });
    expect(code).toContain("AC-1");
    expect(code).toContain("AC-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: Snapshot strategy — render + toMatchSnapshot()
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSnapshotTemplate — snapshot strategy output structure", () => {
  const criteria = makeCriteriaItems();

  test("contains render call", () => {
    const code = buildSnapshotTemplate({ featureName: "my-component", criteria });
    expect(code).toContain("render(");
  });

  test("contains toMatchSnapshot() assertion", () => {
    const code = buildSnapshotTemplate({ featureName: "my-component", criteria });
    expect(code).toContain("toMatchSnapshot()");
  });

  test("contains bun:test import", () => {
    const code = buildSnapshotTemplate({ featureName: "my-component", criteria });
    expect(code).toContain('from "bun:test"');
  });

  test("contains describe block", () => {
    const code = buildSnapshotTemplate({ featureName: "my-component", criteria });
    expect(code).toContain("describe(");
  });

  test("includes AC-N naming for each criterion", () => {
    const code = buildSnapshotTemplate({ featureName: "my-component", criteria });
    expect(code).toContain("AC-1");
    expect(code).toContain("AC-2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: generateFromPRD defaults to unit behavior when testStrategy is omitted
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — defaults to unit behavior when testStrategy is omitted", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("prompt contains unit-style instructions when testStrategy is undefined", async () => {
    const story = makeStory();
    const criteria = makeCriteria(story.id);
    const options = makeOptions(tmpDir); // no testStrategy
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test";\ndescribe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    // Should not contain component/cli/e2e/snapshot strategy-specific instructions
    expect(capturedPrompt.toLowerCase()).not.toContain("bun.spawn");
    expect(capturedPrompt.toLowerCase()).not.toContain("fetch(");
    expect(capturedPrompt.toLowerCase()).not.toContain("tomatchsnapshot");
  });

  test("returns testCode with bun:test import when testStrategy is omitted", async () => {
    const story = makeStory();
    const criteria = makeCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(
      async () => `import { describe, test, expect } from "bun:test";\ndescribe("my-feature - Acceptance Tests", () => {\n  test("AC-1: Component renders correctly", async () => {\n    expect(true).toBe(true);\n  });\n});\n`,
    );
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain('from "bun:test"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 (integration): generateFromPRD uses component template when strategy='component'
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — component strategy selection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("prompt contains component strategy instructions when testStrategy is 'component'", async () => {
    const story = makeStory();
    const criteria = makeCriteria(story.id);
    const options = makeOptions(tmpDir, {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test";\ndescribe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    // Prompt should reference component testing approach
    const promptLower = capturedPrompt.toLowerCase();
    const hasComponentHint =
      promptLower.includes("render") ||
      promptLower.includes("component") ||
      promptLower.includes("ink-testing-library") ||
      promptLower.includes("lastframe");
    expect(hasComponentHint).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 (integration): generateFromPRD uses CLI template when strategy='cli'
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — cli strategy selection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("prompt uses 3-step language-agnostic structure when testStrategy is 'cli'", async () => {
    const story = makeStory();
    const criteria = makeCriteria(story.id);
    const options = makeOptions(tmpDir, { testStrategy: "cli" });
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test";\ndescribe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain("Step 1: Understand and Classify");
    expect(capturedPrompt).toContain("Step 2: Explore the Project");
    expect(capturedPrompt).toContain("Step 3: Generate the Acceptance Test File");
    expect(capturedPrompt).toContain("NEVER use placeholder assertions");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4 (integration): generateFromPRD uses E2E template when strategy='e2e'
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — e2e strategy selection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("prompt uses 3-step language-agnostic structure when testStrategy is 'e2e'", async () => {
    const story = makeStory();
    const criteria = makeCriteria(story.id);
    const options = makeOptions(tmpDir, { testStrategy: "e2e" });
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test";\ndescribe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain("Step 1: Understand and Classify");
    expect(capturedPrompt).toContain("Step 2: Explore the Project");
    expect(capturedPrompt).toContain("Step 3: Generate the Acceptance Test File");
    expect(capturedPrompt).toContain("integration-check");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 (integration): generateFromPRD uses snapshot template when strategy='snapshot'
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — snapshot strategy selection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("prompt uses 3-step language-agnostic structure when testStrategy is 'snapshot'", async () => {
    const story = makeStory();
    const criteria = makeCriteria(story.id);
    const options = makeOptions(tmpDir, { testStrategy: "snapshot" });
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return `import { describe, test, expect } from "bun:test";\ndescribe("test", () => {});`;
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain("Step 1: Understand and Classify");
    expect(capturedPrompt).toContain("Step 2: Explore the Project");
    expect(capturedPrompt).toContain("Step 3: Generate the Acceptance Test File");
    expect(capturedPrompt).toContain("file-check");
  });
});
