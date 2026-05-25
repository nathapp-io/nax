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
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NaxConfig } from "../../../src/config/types";
import type { UserStory } from "../../../src/prd";
import { PromptBuilder } from "../../../src/prompts";
import { makeTempDir } from "../../helpers/temp";

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
        maxAttemptsTotal: 2,
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
  tmpDir = makeTempDir("nax-pb004-test-");
});

afterEach(async () => {
  try {
    // best-effort cleanup
    await rm(tmpDir, { recursive: true, force: true });
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
    const prompt = await (PromptBuilder.for("test-writer") as any).withLoader(tmpDir, config).story(story).build();
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
    const prompt = await (PromptBuilder.for("test-writer") as any).withLoader(tmpDir, config).story(story).build();

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
    const prompt = await (PromptBuilder.for("test-writer") as any).withLoader(tmpDir, config).story(story).build();

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

  test("test-writer (strict): contains story/criteria and test-only isolation instructions", async () => {
    const config = makeConfig();
    const prompt = await (PromptBuilder.for("test-writer", { isolation: "strict" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
    const lower = prompt.toLowerCase();
    const hasTestInstruction =
      lower.includes("test") &&
      (lower.includes("only") || lower.includes("do not") || lower.includes("don't") || lower.includes("src/"));
    expect(hasTestInstruction).toBe(true);
  });

  test("test-writer (lite): contains story/criteria and allows src/ reads or stubs", async () => {
    const config = makeConfig();
    const prompt = await (PromptBuilder.for("test-writer", { isolation: "lite" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    const lower = prompt.toLowerCase();
    const hasLiteInstruction =
      lower.includes("stub") ||
      lower.includes("may read") ||
      lower.includes("read source") ||
      lower.includes("import from source");
    expect(hasLiteInstruction).toBe(true);
  });

  test("implementer (standard): contains story/criteria and implementation instructions", async () => {
    const config = makeConfig();
    const prompt = await (PromptBuilder.for("implementer", { variant: "standard" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
    const lower = prompt.toLowerCase();
    expect(lower.includes("implement") || lower.includes("make") || lower.includes("pass")).toBe(true);
  });

  test("implementer (lite): contains story/criteria and mentions tests+implementing", async () => {
    const config = makeConfig();
    const prompt = await (PromptBuilder.for("implementer", { variant: "lite" }) as any)
      .withLoader(tmpDir, config)
      .story(story)
      .build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    const lower = prompt.toLowerCase();
    expect(lower.includes("test") && (lower.includes("implement") || lower.includes("feature"))).toBe(true);
  });

  test("verifier: contains story/criteria and verification instructions", async () => {
    const config = makeConfig();
    const prompt = await (PromptBuilder.for("verifier") as any).withLoader(tmpDir, config).story(story).build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
    const lower = prompt.toLowerCase();
    expect(lower.includes("verify") || lower.includes("check") || lower.includes("ensure")).toBe(true);
  });

  test("single-session: contains story/criteria and both test+implementation instructions", async () => {
    const config = makeConfig();
    const prompt = await (PromptBuilder.for("single-session") as any).withLoader(tmpDir, config).story(story).build();

    expect(prompt).toContain("ROLE_INTEGRATION_TEST_STORY");
    expect(prompt).toContain("CRITERIA_ONE");
    expect(prompt).toContain("CRITERIA_TWO");
    const lower = prompt.toLowerCase();
    expect(lower.includes("test") && (lower.includes("implement") || lower.includes("feature"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Structural: call sites no longer import the 6 old functions
//    FAILS until migration removes/replaces imports in call sites
// ---------------------------------------------------------------------------

describe("Structural: call sites migrated away from old prompt functions", () => {
  test("session-runner.ts deleted; prompt.ts uses PromptBuilder not old functions", async () => {
    const { existsSync } = require("fs");
    expect(existsSync(new URL("../../../src/tdd/session-runner.ts", import.meta.url).pathname)).toBe(false);

    const promptSrc = await Bun.file(new URL("../../../src/pipeline/stages/prompt.ts", import.meta.url).pathname).text();
    expect(promptSrc).not.toContain("buildSingleSessionPrompt");
    expect(promptSrc).not.toContain("buildBatchPrompt");
    expect(promptSrc).toContain("PromptBuilder");
  });

  test("src/cli/prompts.ts does not dynamically import buildTestWriterPrompt after migration", async () => {
    const source = await Bun.file(new URL("../../../src/cli/prompts.ts", import.meta.url).pathname).text();
    expect(source).not.toContain("buildTestWriterPrompt");
    expect(source).not.toContain("buildImplementerPrompt");
    expect(source).not.toContain("buildVerifierPrompt");
  });
});

// ---------------------------------------------------------------------------
// 4. Internal prompts — migration status (regression guard — expected to PASS)
// ---------------------------------------------------------------------------

describe("Internal prompts: not migrated, still accessible", () => {
  test("tdd/prompts.ts and execution/prompts.ts deleted; RectifierPromptBuilder exported (Phase 5)", async () => {
    let tddErr: unknown = null;
    try { await import("../../../src/tdd/prompts"); } catch (err) { tddErr = err; }
    expect(tddErr).not.toBeNull();

    const mod = await import("../../../src/prompts");
    expect(typeof mod.RectifierPromptBuilder).toBe("function");

    let execErr: unknown = null;
    try { await import("../../../src/execution/prompts"); } catch (err) { execErr = err; }
    expect(execErr).not.toBeNull();
  });

  // buildRoutingPrompt / buildBatchRoutingPrompt parity tests removed in Phase 6:
  // llm-prompts.ts was deleted; prompts now built via OneShotPromptBuilder in llm.ts.
});

// ---------------------------------------------------------------------------
// 5. withLoader override: context passed through correctly
// ---------------------------------------------------------------------------

describe("PromptBuilder.withLoader override content integration", () => {
  test("override for implementer, verifier, and single-session roles replaces role body", async () => {
    const scenarios = [
      { role: "implementer", opts: { variant: "standard" }, key: "implementer", marker: "IMPLEMENTER_CUSTOM_ROLE_BODY_MARKER", title: "OVERRIDE_STORY_TITLE" },
      { role: "verifier", opts: {}, key: "verifier", marker: "VERIFIER_CUSTOM_ROLE_BODY_MARKER", title: "VERIFIER_OVERRIDE_TITLE" },
      { role: "single-session", opts: {}, key: "single-session", marker: "SINGLE_SESSION_CUSTOM_ROLE_BODY_MARKER", title: "SINGLE_SESSION_OVERRIDE_TITLE" },
    ] as const;

    for (const { role, opts, key, marker, title } of scenarios) {
      const relPath = `.nax/prompts/${role}.md`;
      const absPath = join(tmpDir, relPath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, marker);
      const config = makeConfig({ prompts: { overrides: { [key]: relPath } } });
      const story = makeStory({ title });
      const prompt = await (PromptBuilder.for(role, opts as never) as any).withLoader(tmpDir, config).story(story).build();
      expect(prompt, role).toContain(marker);
      expect(prompt, role).toContain(title);
    }
  });
});
