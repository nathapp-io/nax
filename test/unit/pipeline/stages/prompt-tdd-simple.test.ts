/**
 * Unit tests for tdd-simple prompt stage behavior (TS-003)
 *
 * Covers:
 * - promptStage is enabled for tdd-simple strategy
 * - promptStage uses PromptBuilder.for('tdd-simple') for both tdd-simple and test-after
 * - tdd-simple prompt includes RED/GREEN/REFACTOR phase instructions
 * - tdd-simple prompt does NOT use 'Single-Session' role header
 * - test-after also uses tdd-simple prompt (unified single-session prompt)
 * - No regression: three-session-tdd still skips prompt stage
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "../../../../src/config";
import { promptStage } from "../../../../src/pipeline/stages/prompt";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";

const WORKDIR = `/tmp/nax-test-prompt-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Implement login button",
    description: "Add a login button to the homepage",
    acceptanceCriteria: ["Button is visible", "Button navigates to login page"],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
  };
}

function makePRD(): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [makeStory()],
  };
}

function makeConfig(): NaxConfig {
  return {
    autoMode: { defaultAgent: "test-agent" },
    models: {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-5",
    },
    execution: {
      sessionTimeoutSeconds: 60,
      dangerouslySkipPermissions: false,
      costLimit: 10,
      maxIterations: 10,
      rectification: { maxRetries: 3 },
    },
  } as unknown as NaxConfig;
}

function makeCtx(
  testStrategy: "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite",
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  const story = makeStory();
  return {
    config: makeConfig(),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy,
      reasoning: "",
    },
    workdir: WORKDIR,
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// promptStage.enabled() — tdd-simple must NOT be skipped
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.enabled()", () => {
  test("returns true for tdd-simple strategy", () => {
    const ctx = makeCtx("tdd-simple");
    expect(promptStage.enabled(ctx)).toBe(true);
  });

  test("returns true for test-after strategy", () => {
    const ctx = makeCtx("test-after");
    expect(promptStage.enabled(ctx)).toBe(true);
  });

  test("returns false for three-session-tdd strategy", () => {
    const ctx = makeCtx("three-session-tdd");
    expect(promptStage.enabled(ctx)).toBe(false);
  });

  test("returns false for three-session-tdd-lite strategy", () => {
    const ctx = makeCtx("three-session-tdd-lite");
    expect(promptStage.enabled(ctx)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// promptStage.execute() — tdd-simple must use 'tdd-simple' role in PromptBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — tdd-simple strategy", () => {
  test("returns continue action", async () => {
    const ctx = makeCtx("tdd-simple");
    const result = await promptStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("sets ctx.prompt to a non-empty string", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toBeTruthy();
    expect(typeof ctx.prompt).toBe("string");
    expect(ctx.prompt!.length).toBeGreaterThan(0);
  });

  test("prompt contains TDD-Simple role header (not Single-Session)", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Role: TDD-Simple");
    expect(ctx.prompt).not.toContain("# Role: Single-Session");
  });

  test("prompt contains RED phase instructions", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("RED phase");
  });

  test("prompt contains GREEN phase instructions", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("GREEN phase");
  });

  test("prompt contains REFACTOR phase instructions", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("REFACTOR phase");
  });

  test("prompt contains 'Write failing tests FIRST' instruction", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("Write failing tests FIRST");
  });

  test("prompt includes story context (story title)", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("Implement login button");
  });

  test("prompt includes story acceptance criteria", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("Button is visible");
  });

  test("prompt includes context markdown when present", async () => {
    const ctx = makeCtx("tdd-simple", { contextMarkdown: "# Project Context\n\nUse Bun runtime." });
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Project Context");
  });

  test("prompt includes constitution when present", async () => {
    const ctx = makeCtx("tdd-simple", {
      constitution: { content: "Always write tests first.", tokens: 10, truncated: false },
    });
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("Always write tests first.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// test-after now uses tdd-simple prompt (unified single-session prompt)
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — test-after strategy (unified with tdd-simple)", () => {
  test("returns continue action", async () => {
    const ctx = makeCtx("test-after");
    const result = await promptStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("test-after prompt uses TDD-Simple role (unified prompt)", async () => {
    const ctx = makeCtx("test-after");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Role: TDD-Simple");
    expect(ctx.prompt).not.toContain("# Role: Single-Session");
  });

  test("test-after prompt contains RED phase instructions (unified with tdd-simple)", async () => {
    const ctx = makeCtx("test-after");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("RED phase");
  });
});
