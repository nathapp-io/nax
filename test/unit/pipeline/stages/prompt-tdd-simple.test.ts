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
import { promptStage } from "../../../../src/pipeline/stages/prompt";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeNaxConfig } from "../../../helpers";

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

function makeConfig() {
}

function makeCtx(
  testStrategy: "no-test" | "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite",
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  const story = makeStory();
  return {
    config: makeNaxConfig(),
    prd: makePRD(),
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy,
      reasoning: "",
    },
    rootConfig: makeNaxConfig(),
    workdir: WORKDIR,
    projectDir: WORKDIR,
    hooks: {} as PipelineContext["hooks"],
    ...overrides,
  } as unknown as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// promptStage.enabled() — tdd-simple must NOT be skipped
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.enabled()", () => {
  test.each([
    ["tdd-simple", true],
    ["test-after", true],
    ["three-session-tdd", false],
    ["three-session-tdd-lite", false],
  ] as const)("returns %s for %s strategy", (strategy, expected) => {
    const ctx = makeCtx(strategy);
    expect(promptStage.enabled(ctx)).toBe(expected);
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

  test.each([
    ["RED phase instructions", /RED\s*[—-]/],
    ["GREEN phase instructions", /GREEN\s*[—-]/],
    ["REFACTOR phase instructions", /REFACTOR\s*[—-]/],
  ])("prompt contains %s", async (_label, pattern) => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toMatch(pattern);
  });

  test("prompt contains 'Write failing tests FIRST' instruction", async () => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("Write failing tests FIRST");
  });

  test.each([
    ["story context (story title)", "Implement login button"],
    ["story acceptance criteria", "Button is visible"],
  ])("prompt includes %s", async (_label, needle) => {
    const ctx = makeCtx("tdd-simple");
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain(needle);
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
    expect(ctx.prompt).toMatch(/RED\s*[—-]/);
  });
});

describe("promptStage.execute() — no-test strategy", () => {
  test("uses the no-test role", async () => {
    const ctx = makeCtx("no-test", {
      story: {
        ...makeStory(),
        routing: {
          testStrategy: "no-test",
          noTestJustification: "Pure style change",
        },
      } as PipelineContext["story"],
    });
    ctx.stories = [ctx.story];
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Role: Implementer (No Tests)");
  });

  test("does not include isolation rules", async () => {
    const ctx = makeCtx("no-test", {
      story: {
        ...makeStory(),
        routing: {
          testStrategy: "no-test",
          noTestJustification: "Pure style change",
        },
      } as PipelineContext["story"],
    });
    ctx.stories = [ctx.story];
    await promptStage.execute(ctx);
    expect(ctx.prompt).not.toContain("# Isolation Rules");
  });
});
