/**
 * Unit tests for batch prompt stage behavior (BP-002)
 *
 * Covers:
 * - promptStage uses PromptBuilder.for('batch') for multiple stories
 * - Batch prompts include PromptBuilder sections (constitution tags, conventions, isolation)
 * - Single stories still use tdd-simple role
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promptStage } from "../../../../src/pipeline/stages/prompt";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { PRD, UserStory } from "../../../../src/prd";
import { makeNaxConfig } from "../../../helpers";

const WORKDIR = `/tmp/nax-test-prompt-batch-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(id: string = "US-001", title: string = "Implement login button"): UserStory {
  return {
    id,
    title,
    description: `Add a ${title.toLowerCase()}`,
    acceptanceCriteria: ["Button is visible", "Button navigates to login page"],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test",
    feature: "my-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(
  stories: UserStory[],
  testStrategy: "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite" = "tdd-simple",
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  return {
    config: makeNaxConfig({ quality: { commands: { test: "bun test" } } }),
    prd: makePRD(stories),
    story: stories[0],
    stories,
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
// Batch prompt tests — using PromptBuilder.for("batch")
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — batch (multiple stories)", () => {
  test("returns continue action for batch", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    const result = await promptStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("sets ctx.prompt to a non-empty string for batch", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toBeTruthy();
    expect(typeof ctx.prompt).toBe("string");
    expect(ctx.prompt!.length).toBeGreaterThan(0);
  });

  test("batch prompt contains 'Role: Batch Implementer' (from PromptBuilder)", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Role: Batch Implementer");
  });

  test("batch prompt contains TDD instructions ('write tests first')", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("Write failing tests FIRST");
  });

  test("batch prompt contains story context section with boundary tags", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Story Context");
    expect(ctx.prompt).toContain("<!-- USER-SUPPLIED DATA");
    expect(ctx.prompt).toContain("<!-- END USER-SUPPLIED DATA -->");
  });

  test("batch prompt lists all stories with story numbers and IDs", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("## Story 1: US-001");
    expect(ctx.prompt).toContain("## Story 2: US-002");
  });

  test("batch prompt includes all story descriptions and acceptance criteria", async () => {
    const stories = [
      { ...makeStory("US-001"), description: "First feature" },
      { ...makeStory("US-002"), description: "Second feature" },
    ];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("First feature");
    expect(ctx.prompt).toContain("Second feature");
    expect(ctx.prompt).toContain("Button is visible");
  });

  test("batch prompt includes conventions footer (from PromptBuilder)", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Conventions");
  });

  test("batch prompt includes isolation rules section (from PromptBuilder)", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Isolation Rules");
  });

  test("batch prompt includes constitution when present", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories, "tdd-simple", {
      constitution: { content: "Always write tests first.", tokens: 10, truncated: false },
    });
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# CONSTITUTION");
    expect(ctx.prompt).toContain("Always write tests first.");
  });

  test("batch prompt includes context markdown when present", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories, "tdd-simple", {
      contextMarkdown: "# Project Context\n\nUse Bun runtime.",
    });
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Project Context");
  });

  test("batch prompt mentions test command from config", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("bun test");
  });

  test("batch prompt does NOT include verdict section (batch-specific)", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    // Batch role should not have a verdict section (that's for verifier role)
    const verdictMatch = ctx.prompt!.match(/# Verdict/);
    expect(verdictMatch).toBeNull();
  });

  test("batch with 3 stories shows all three stories", async () => {
    const stories = [makeStory("US-001"), makeStory("US-002"), makeStory("US-003")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("## Story 1: US-001");
    expect(ctx.prompt).toContain("## Story 2: US-002");
    expect(ctx.prompt).toContain("## Story 3: US-003");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression test: single story must still use tdd-simple role
// ─────────────────────────────────────────────────────────────────────────────

describe("promptStage.execute() — single story (regression: should NOT use batch role)", () => {
  test("single story uses tdd-simple role, NOT batch role", async () => {
    const stories = [makeStory("US-001")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).toContain("# Role: TDD-Simple");
    expect(ctx.prompt).not.toContain("# Role: Batch Implementer");
  });

  test("single story does NOT list multiple stories", async () => {
    const stories = [makeStory("US-001")];
    const ctx = makeCtx(stories);
    await promptStage.execute(ctx);
    expect(ctx.prompt).not.toContain("## Story 1:");
    expect(ctx.prompt).not.toContain("## Story 2:");
  });
});
