/**
 * PB-004: Migrate call sites to PromptBuilder — integration tests
 *
 * These tests are expected to FAIL until:
 * 1. PromptBuilder gains a .withLoader(workdir, config) method
 * 2. The 6 user-facing prompt functions are replaced with PromptBuilder calls
 * 3. Call sites in session-runner.ts and prompt.ts stage are updated
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { NaxConfig } from "../../../src/config/types";
import { PromptBuilder } from "../../../src/prompts/builder";
import type { UserStory } from "../../../src/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "PB-004",
    title: "Migrate call sites to PromptBuilder",
    description: "Replace 6 user-facing prompt functions with PromptBuilder calls.",
    acceptanceCriteria: [
      "All 6 user-facing prompt functions replaced with PromptBuilder calls",
      "Internal prompts remain unchanged",
      "No regression in generated prompt text",
    ],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    version: 1,
    models: {
      fast: { provider: "anthropic", model: "haiku" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
    },
    autoMode: {
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 3 }] },
    },
    routing: { strategy: "keyword" },
    execution: {
      maxIterations: 10,
      iterationDelayMs: 2000,
      costLimit: 5,
      sessionTimeoutSeconds: 600,
      verificationTimeoutSeconds: 300,
      maxStoriesPerFeature: 500,
      rectification: {
        enabled: true,
        maxRetries: 2,
        fullSuiteTimeoutSeconds: 120,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
      },
      regressionGate: { enabled: true, timeoutSeconds: 120 },
      contextProviderTokenBudget: 2000,
    },
    quality: {
      requireTypecheck: true,
      requireLint: true,
      requireTests: true,
      commands: {},
      forceExit: false,
      detectOpenHandles: true,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 5000,
      dangerouslySkipPermissions: true,
      drainTimeoutMs: 2000,
      shell: "/bin/sh",
      stripEnvVars: [],
      environmentalEscalationDivisor: 2,
    },
    tdd: {
      maxRetries: 2,
      autoVerifyIsolation: true,
      strategy: "auto",
      autoApproveVerifier: true,
    },
    constitution: { enabled: false, path: "constitution.md", maxTokens: 2000 },
    analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 5000 },
    review: { enabled: false, checks: [], commands: {} },
    plan: { model: "balanced", outputPath: "spec.md" },
    acceptance: { enabled: false, maxRetries: 2, generateTests: false, testPath: "acceptance.test.ts" },
    context: {
      testCoverage: {
        enabled: false,
        detail: "names-only",
        maxTokens: 500,
        testPattern: "**/*.test.ts",
        scopeToStory: false,
      },
      autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
    },
    ...overrides,
  } as NaxConfig;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nax-pb004-test-"));
});

afterEach(() => {
  try {
    // best-effort cleanup
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// 1. PromptBuilder.withLoader API — fails until withLoader is implemented
// ---------------------------------------------------------------------------

describe("PromptBuilder.withLoader(workdir, config)", () => {
  test("withLoader is chainable and returns a PromptBuilder", () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist on PromptBuilder
    const pb = (PromptBuilder.for("test-writer") as any).withLoader(tmpDir, config);
    expect(pb).toBeInstanceOf(PromptBuilder);
  });

  test("withLoader + no override in config: build succeeds and uses default", async () => {
    const config = makeConfig(); // no prompts.overrides
    const story = makeStory();
    // FAILS: withLoader does not exist on PromptBuilder
    const prompt = await (PromptBuilder.for("test-writer") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();
    expect(prompt).toContain(story.title);
  });

  test("withLoader reads override file when config.prompts.overrides is set", async () => {
    const overrideContent = "# CUSTOM_TEST_WRITER_OVERRIDE\nCustom role body from user override.";
    const relPath = ".nax/prompts/test-writer.md";
    const absPath = join(tmpDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, overrideContent);

    const config = makeConfig({ prompts: { overrides: { "test-writer": relPath } } });
    const story = makeStory();

    // FAILS: withLoader does not exist on PromptBuilder
    const prompt = await (PromptBuilder.for("test-writer") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("CUSTOM_TEST_WRITER_OVERRIDE");
    // Story context (non-overridable) must still appear
    expect(prompt).toContain(story.title);
  });

  test("withLoader falls back to default when override file is absent", async () => {
    const config = makeConfig({
      prompts: { overrides: { "test-writer": ".nax/prompts/nonexistent.md" } },
    });
    const story = makeStory({ title: "FALLBACK_STORY_TITLE" });

    // FAILS: withLoader does not exist on PromptBuilder
    const prompt = await (PromptBuilder.for("test-writer") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("FALLBACK_STORY_TITLE");
  });
});

// ---------------------------------------------------------------------------
// 2. Integration — 6 roles produce semantically correct output (no override)
//    Uses withLoader so it fails until migration is complete
// ---------------------------------------------------------------------------

describe("Integration: 6 roles with no override — story title and AC present", () => {
  const story = makeStory({
    title: "ROLE_INTEGRATION_TEST_STORY",
    acceptanceCriteria: ["CRITERIA_ONE", "CRITERIA_TWO"],
  });

  test("test-writer (strict isolation) contains story title and acceptance criteria", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("test-writer", { isolation: "strict" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
  });

  test("test-writer (strict) includes test-only isolation instructions", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("test-writer", { isolation: "strict" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    const lower = prompt.toLowerCase();
    // Must mention writing tests or test/ directory restriction
    const hasTestInstruction =
      lower.includes("test") &&
      (lower.includes("only") || lower.includes("do not") || lower.includes("don't") || lower.includes("src/"));
    expect(hasTestInstruction).toBe(true);
  });

  test("test-writer (lite) contains story title and acceptance criteria", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("test-writer", { isolation: "lite" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
  });

  test("test-writer (lite) mentions allowing src/ reads or stubs", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("test-writer", { isolation: "lite" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    const lower = prompt.toLowerCase();
    // Lite mode allows reading source files or creating stubs
    const hasLiteInstruction =
      lower.includes("stub") ||
      lower.includes("may read") ||
      lower.includes("read source") ||
      lower.includes("import from source");
    expect(hasLiteInstruction).toBe(true);
  });

  test("implementer (standard) contains story title and acceptance criteria", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("implementer", { variant: "standard" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
  });

  test("implementer (standard) includes implementation instructions", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("implementer", { variant: "standard" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    const lower = prompt.toLowerCase();
    const hasImplInstruction =
      lower.includes("implement") ||
      lower.includes("make") ||
      lower.includes("pass");
    expect(hasImplInstruction).toBe(true);
  });

  test("implementer (lite) contains story title and acceptance criteria", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("implementer", { variant: "lite" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
  });

  test("implementer (lite) mentions writing tests AND implementing", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("implementer", { variant: "lite" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    const lower = prompt.toLowerCase();
    const hasTests = lower.includes("test");
    const hasImpl = lower.includes("implement") || lower.includes("feature");
    expect(hasTests && hasImpl).toBe(true);
  });

  test("verifier contains story title and acceptance criteria", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("verifier") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
  });

  test("verifier includes verification instructions", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("verifier") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    const lower = prompt.toLowerCase();
    const hasVerifyInstruction = lower.includes("verify") || lower.includes("check") || lower.includes("ensure");
    expect(hasVerifyInstruction).toBe(true);
  });

  test("single-session contains story title and acceptance criteria", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("single-session") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
  });

  test("single-session includes both test and implementation instructions", async () => {
    const config = makeConfig();
    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("single-session") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    const lower = prompt.toLowerCase();
    const hasTests = lower.includes("test");
    const hasImpl = lower.includes("implement") || lower.includes("feature");
    expect(hasTests && hasImpl).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Structural: call sites no longer import the 6 old functions
//    FAILS until migration removes/replaces imports in call sites
// ---------------------------------------------------------------------------

describe("Structural: call sites migrated away from old prompt functions", () => {
  test("src/tdd/session-runner.ts does not import buildTestWriterPrompt from ./prompts", async () => {
    const source = await Bun.file(
      new URL("../../../src/tdd/session-runner.ts", import.meta.url).pathname,
    ).text();

    // After migration, session-runner should NOT import these old functions
    expect(source).not.toContain("buildTestWriterPrompt");
    expect(source).not.toContain("buildTestWriterLitePrompt");
    expect(source).not.toContain("buildImplementerPrompt");
    expect(source).not.toContain("buildImplementerLitePrompt");
    expect(source).not.toContain("buildVerifierPrompt");
  });

  test("src/tdd/session-runner.ts imports PromptBuilder after migration", async () => {
    const source = await Bun.file(
      new URL("../../../src/tdd/session-runner.ts", import.meta.url).pathname,
    ).text();

    // After migration, session-runner should use PromptBuilder
    expect(source).toContain("PromptBuilder");
  });

  test("src/pipeline/stages/prompt.ts does not import buildSingleSessionPrompt after migration", async () => {
    const source = await Bun.file(
      new URL("../../../src/pipeline/stages/prompt.ts", import.meta.url).pathname,
    ).text();

    // After migration, prompt stage should NOT use the old function
    expect(source).not.toContain("buildSingleSessionPrompt");
  });

  test("src/pipeline/stages/prompt.ts imports PromptBuilder after migration", async () => {
    const source = await Bun.file(
      new URL("../../../src/pipeline/stages/prompt.ts", import.meta.url).pathname,
    ).text();

    // After migration, prompt stage should use PromptBuilder
    expect(source).toContain("PromptBuilder");
  });

  test("src/cli/prompts.ts does not dynamically import buildTestWriterPrompt after migration", async () => {
    const source = await Bun.file(
      new URL("../../../src/cli/prompts.ts", import.meta.url).pathname,
    ).text();

    // cli/prompts.ts has a dynamic import of tdd/prompts — after migration it should use PromptBuilder
    expect(source).not.toContain("buildTestWriterPrompt");
    expect(source).not.toContain("buildImplementerPrompt");
    expect(source).not.toContain("buildVerifierPrompt");
  });
});

// ---------------------------------------------------------------------------
// 4. Internal prompts remain unchanged (regression guard — expected to PASS)
// ---------------------------------------------------------------------------

describe("Internal prompts: not migrated, still accessible", () => {
  test("buildImplementerRectificationPrompt still exported from src/tdd/prompts", async () => {
    const mod = await import("../../../src/tdd/prompts");
    expect(typeof mod.buildImplementerRectificationPrompt).toBe("function");
  });

  test("buildRectificationPrompt still exported from src/tdd/prompts", async () => {
    const mod = await import("../../../src/tdd/prompts");
    expect(typeof mod.buildRectificationPrompt).toBe("function");
  });

  test("buildBatchPrompt still exported from src/execution/prompts", async () => {
    const mod = await import("../../../src/execution/prompts");
    expect(typeof mod.buildBatchPrompt).toBe("function");
  });

  test("buildRoutingPrompt still exported from src/routing/strategies/llm-prompts", async () => {
    const mod = await import("../../../src/routing/strategies/llm-prompts");
    expect(typeof mod.buildRoutingPrompt).toBe("function");
  });

  test("buildBatchPrompt still exported from src/routing/strategies/llm-prompts", async () => {
    const mod = await import("../../../src/routing/strategies/llm-prompts");
    expect(typeof mod.buildBatchPrompt).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 5. withLoader override: context passed through correctly
// ---------------------------------------------------------------------------

describe("PromptBuilder.withLoader override content integration", () => {
  test("override for implementer role replaces role body", async () => {
    const overrideBody = "IMPLEMENTER_CUSTOM_ROLE_BODY_MARKER";
    const relPath = ".nax/prompts/implementer.md";
    const absPath = join(tmpDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, overrideBody);

    const config = makeConfig({ prompts: { overrides: { implementer: relPath } } });
    const story = makeStory({ title: "OVERRIDE_STORY_TITLE" });

    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("implementer", { variant: "standard" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain(overrideBody);
    // Story context still present (non-overridable)
    expect(prompt).toContain("OVERRIDE_STORY_TITLE");
  });

  test("override for verifier role replaces role body", async () => {
    const overrideBody = "VERIFIER_CUSTOM_ROLE_BODY_MARKER";
    const relPath = ".nax/prompts/verifier.md";
    const absPath = join(tmpDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, overrideBody);

    const config = makeConfig({ prompts: { overrides: { verifier: relPath } } });
    const story = makeStory({ title: "VERIFIER_OVERRIDE_TITLE" });

    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("verifier") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain(overrideBody);
    expect(prompt).toContain("VERIFIER_OVERRIDE_TITLE");
  });

  test("override for single-session role replaces role body", async () => {
    const overrideBody = "SINGLE_SESSION_CUSTOM_ROLE_BODY_MARKER";
    const relPath = ".nax/prompts/single-session.md";
    const absPath = join(tmpDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, overrideBody);

    const config = makeConfig({ prompts: { overrides: { "single-session": relPath } } });
    const story = makeStory({ title: "SINGLE_SESSION_OVERRIDE_TITLE" });

    // FAILS: withLoader does not exist
    const prompt = await (PromptBuilder.for("single-session") as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain(overrideBody);
    expect(prompt).toContain("SINGLE_SESSION_OVERRIDE_TITLE");
  });
});
