/**
 * PromptBuilder unit tests — PB-001
 *
 * Tests verify section ordering, non-overridable sections, and override fallthrough.
 * All tests are expected to FAIL until PromptBuilder is implemented.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserStory } from "../../../src/prd";
import { PromptBuilder } from "../../../src/prompts";
import type { PromptRole } from "../../../src/prompts";
import { makeTempDir } from "@test/helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Example story",
    description: "Do the thing",
    acceptanceCriteria: ["Criterion 1", "Criterion 2"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

const ROLES: PromptRole[] = ["test-writer", "implementer", "verifier", "single-session"];

// ---------------------------------------------------------------------------
// 1. Fluent API — builder returns itself for chaining
// ---------------------------------------------------------------------------

describe("PromptBuilder fluent API", () => {
  test("PromptBuilder.for() returns a PromptBuilder instance", () => {
    const builder = PromptBuilder.for("test-writer");
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  test.each([
    [".story()", () => PromptBuilder.for("implementer").story(makeStory())],
    [".context()", () => PromptBuilder.for("verifier").story(makeStory()).context("# Context")],
    [".constitution()", () => PromptBuilder.for("single-session").story(makeStory()).constitution("Be helpful.")],
    [".override()", () => PromptBuilder.for("test-writer").story(makeStory()).override("/tmp/override.md")],
  ])("%s is chainable", (_name, build) => {
    expect(build()).toBeInstanceOf(PromptBuilder);
  });

  test(".build() returns a Promise<string>", async () => {
    const result = PromptBuilder.for("test-writer").story(makeStory()).build();
    expect(result).toBeInstanceOf(Promise);
    const text = await result;
    expect(typeof text).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 2. Section ordering
// ---------------------------------------------------------------------------

describe("PromptBuilder section order", () => {
  test("constitution before role task; story before footer; context before footer; isolation present", async () => {
    const ctxMarker = "CONTEXT_MARKDOWN_MARKER";
    const prompt = await PromptBuilder.for("test-writer")
      .story(makeStory({ title: "STORY_TITLE_MARKER" }))
      .constitution("CONSTITUTION_MARKER")
      .context(ctxMarker)
      .build();
    const constitutionIdx = prompt.indexOf("CONSTITUTION_MARKER");
    const roleTaskIdx = prompt.indexOf("# Role:");
    const storyIdx = prompt.indexOf("STORY_TITLE_MARKER");
    const ctxIdx = prompt.indexOf(ctxMarker);
    const footerIdx = prompt.lastIndexOf("conventions") !== -1 ? prompt.lastIndexOf("conventions") : prompt.length - 1;
    const isolationIdx = prompt.indexOf("isolation") !== -1 ? prompt.indexOf("isolation") : prompt.indexOf("ISOLATION");
    expect(constitutionIdx).toBeGreaterThanOrEqual(0);
    expect(roleTaskIdx).toBeGreaterThanOrEqual(0);
    expect(constitutionIdx).toBeLessThan(roleTaskIdx);
    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeLessThan(footerIdx);
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeLessThan(footerIdx);
    expect(isolationIdx).toBeGreaterThanOrEqual(0);
  });

  describe("section order for each role", () => {
    for (const role of ROLES) {
      test(`role ${role}: constitution → role task → story context → isolation rules → context md → conventions footer`, async () => {
        const story = makeStory({ title: `STORY_${role.toUpperCase()}` });
        const ctxMd = `CTXMD_${role.toUpperCase()}`;
        const prompt = await PromptBuilder.for(role)
          .story(story)
          .constitution("CONSTITUTION_BLOCK")
          .context(ctxMd)
          .build();

        const constitutionIdx = prompt.indexOf("CONSTITUTION_BLOCK");
        const storyIdx = prompt.indexOf(`STORY_${role.toUpperCase()}`);
        const ctxIdx = prompt.indexOf(ctxMd);

        // All markers present
        expect(constitutionIdx).toBeGreaterThanOrEqual(0);
        expect(storyIdx).toBeGreaterThanOrEqual(0);
        expect(ctxIdx).toBeGreaterThanOrEqual(0);

        // Ordering: constitution < story < ctx
        expect(constitutionIdx).toBeLessThan(storyIdx);
        expect(storyIdx).toBeLessThan(ctxIdx);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Non-overridable sections always present
// ---------------------------------------------------------------------------

describe("PromptBuilder non-overridable sections", () => {
  test("override preserves story context, conventions footer order, and isolation rules", async () => {
    const tmpDir = makeTempDir("nax-pb-test-");
    const overridePath = join(tmpDir, "override.md");
    writeFileSync(overridePath, "# Custom override body");

    const story = makeStory({ title: "NON_OVERRIDABLE_STORY" });
    const prompt = await PromptBuilder.for("test-writer").story(story).override(overridePath).build();

    expect(prompt).toContain("NON_OVERRIDABLE_STORY");
    const overrideIdx = prompt.indexOf("Custom override body");
    const conventionsIdx = prompt.lastIndexOf("conventions");
    expect(conventionsIdx).toBeGreaterThan(overrideIdx);
    const lowerPrompt = prompt.toLowerCase();
    expect(lowerPrompt.includes("isolation") || lowerPrompt.includes("isolat")).toBe(true);
  });

  test("story context not removable via override for each role", async () => {
    const tmpDir = makeTempDir("nax-pb-test-");
    const overridePath = join(tmpDir, "override.md");
    writeFileSync(overridePath, "Override that attempts to hide story context.");

    for (const role of ROLES) {
      const story = makeStory({ title: `ROLE_${role}_TITLE` });
      const prompt = await PromptBuilder.for(role).story(story).override(overridePath).build();
      expect(prompt).toContain(`ROLE_${role}_TITLE`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Override fallthrough to default template
// ---------------------------------------------------------------------------

describe("PromptBuilder override fallthrough", () => {
  test.each([
    ["missing override falls through to default", "/nonexistent/path/override.md", "FALLTHROUGH_STORY"],
    ["no override uses default template", undefined, "DEFAULT_TEMPLATE_STORY"],
  ] as const)("%s", async (_label, overridePath, marker) => {
    let builder = PromptBuilder.for("test-writer").story(makeStory({ title: marker }));
    if (overridePath) builder = builder.override(overridePath);
    const prompt = await builder.build();
    expect(prompt).toContain(marker);
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("valid override file replaces default template body", async () => {
    const tmpDir = makeTempDir("nax-pb-test-");
    const overridePath = join(tmpDir, "override.md");
    const overrideBody = "UNIQUE_OVERRIDE_BODY_CONTENT";
    writeFileSync(overridePath, overrideBody);

    const prompt = await PromptBuilder.for("implementer").story(makeStory()).override(overridePath).build();

    expect(prompt).toContain(overrideBody);
  });
});

// ---------------------------------------------------------------------------
// 5. Types exported correctly
// ---------------------------------------------------------------------------

describe("src/prompts/types exports", () => {
  test("PromptRole includes all roles: 4 base + tdd-simple + batch = 6 total", () => {
    const baseRoles: PromptRole[] = ["test-writer", "implementer", "verifier", "single-session"];
    expect(baseRoles).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withTddSimple: PromptRole[] = [...baseRoles, "tdd-simple" as any];
    expect(withTddSimple).toContain("tdd-simple");
    expect(withTddSimple).toHaveLength(5);
    const withBatch: PromptRole[] = [...withTddSimple, "batch"];
    expect(withBatch).toContain("batch");
    expect(withBatch).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// 6. TS-002: tdd-simple PromptBuilder support (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("PromptBuilder — tdd-simple role", () => {
  test("returns PromptBuilder instance; non-empty; isolation ok; story + conventions present", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = PromptBuilder.for("tdd-simple" as any);
    expect(builder).toBeInstanceOf(PromptBuilder);
    const story = makeStory({ title: "TDD_SIMPLE_STORY_MARKER" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(story).build();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain("Only create or modify files in the test/ directory");
    expect(prompt).not.toContain("Do not modify test files");
    expect(prompt).toContain("TDD_SIMPLE_STORY_MARKER");
    expect(prompt.toLowerCase()).toContain("conventions");
  });

  test.each([
    ["TDD instructions", "Write failing tests FIRST"],
    ["git commit instruction", "git commit -m"],
  ])("tdd-simple prompt contains %s", async (_label, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(prompt).toContain(expected);
  });

  test("tdd-simple prompt section order: role task before story before conventions", async () => {
    const story = makeStory({ title: "TDD_SIMPLE_ORDER_MARKER" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any)
      .story(story)
      .constitution("TDD_SIMPLE_CONSTITUTION")
      .build();

    const constitutionIdx = prompt.indexOf("TDD_SIMPLE_CONSTITUTION");
    const storyIdx = prompt.indexOf("TDD_SIMPLE_ORDER_MARKER");
    const conventionsIdx = prompt.lastIndexOf("conventions");

    expect(constitutionIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(constitutionIdx).toBeLessThan(storyIdx);
    expect(storyIdx).toBeLessThan(conventionsIdx);
  });

  test("single-story prompt repeats acceptance criteria in the final reminder, which is the final section", async () => {
    const criterion = "UNIQUE_FINAL_REMINDER_AC";
    const story = makeStory({ acceptanceCriteria: [criterion, "UNIQUE_TOP_AND_BOTTOM_AC_TWO"] });
    const prompt = await PromptBuilder.for("tdd-simple")
      .story(story)
      .constitution("REMINDER_ORDER_CONSTITUTION")
      .context("REMINDER_ORDER_CONTEXT")
      .hermeticConfig({ hermetic: true })
      .build();
    for (const ac of story.acceptanceCriteria) {
      expect(prompt.indexOf(ac)).toBeGreaterThanOrEqual(0);
      expect(prompt.lastIndexOf(ac)).toBeGreaterThan(prompt.indexOf(ac));
    }
    const conventionsIdx = prompt.lastIndexOf("conventions");
    const finalCriterionIdx = prompt.lastIndexOf(criterion);
    expect(conventionsIdx).toBeGreaterThanOrEqual(0);
    expect(finalCriterionIdx).toBeGreaterThan(conventionsIdx);
    expect(prompt.trim().endsWith("<!-- END USER-SUPPLIED DATA -->")).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// BP-001: batch role support (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("PromptBuilder — batch role: .stories() method", () => {
  test.each([
    ["single story", [makeStory()]],
    ["multiple stories", [makeStory({ id: "B-001" }), makeStory({ id: "B-002" })]],
    ["empty array", [] as UserStory[]],
  ])(".stories() with %s is chainable", (_label, stories) => {
    expect(PromptBuilder.for("batch").stories(stories)).toBeInstanceOf(PromptBuilder);
  });
});

describe("PromptBuilder — batch role: build()", () => {
  const batchStories = [
    makeStory({ id: "BP-001", title: "First Batch Story" }),
    makeStory({ id: "BP-002", title: "Second Batch Story" }),
  ];

  test("story IDs/headings/instructions/conventions present, no verdict; section order: constitution < stories < conventions", async () => {
    const prompt = await PromptBuilder.for("batch").stories(batchStories).constitution("BATCH_CONSTITUTION_MARKER").build();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("BP-001");
    expect(prompt).toContain("BP-002");
    expect(prompt).toContain("## Story 1:");
    expect(prompt).toContain("## Story 2:");
    expect(prompt.toLowerCase()).not.toContain("verdict");
    expect(prompt.toLowerCase()).toMatch(/each story|implement.*story|story.*implement/);
    expect(prompt.toLowerCase()).toContain("conventions");
    const constitutionIdx = prompt.indexOf("BATCH_CONSTITUTION_MARKER");
    const storyIdx = prompt.indexOf("BP-001");
    const conventionsIdx = prompt.lastIndexOf("conventions");
    expect(constitutionIdx).toBeGreaterThanOrEqual(0);
    expect(constitutionIdx).toBeLessThan(storyIdx);
    expect(storyIdx).toBeLessThan(conventionsIdx);
  });

  test("includes test framework hint from testCommand in role-task section", async () => {
    const prompt = await PromptBuilder.for("batch").stories(batchStories).testCommand("pytest").build();
    expect(prompt).toContain("pytest");
  });

  test("does not add a single-story reminder", async () => {
    const prompt = await PromptBuilder.for("batch").stories(batchStories).build();

    expect(prompt).not.toContain("Your task is to implement the story below");
    expect(prompt).not.toContain("mirrored acceptance criterion");
  });
});

// ---------------------------------------------------------------------------
// Test-quality pre-brief wiring (July 2026 audit recommendation #1)
// ---------------------------------------------------------------------------

describe("PromptBuilder — test-quality pre-brief section", () => {
  test.each(["test-writer", "single-session", "tdd-simple"] as PromptRole[])(
    "%s prompt contains the Review-Proof Tests pre-brief with the story ID pinned",
    async (role) => {
      const prompt = await PromptBuilder.for(role).story(makeStory({ id: "US-007" })).build();
      expect(prompt).toContain("# Review-Proof Tests");
      expect(prompt).toContain("(US-007)");
    },
  );

  test("batch prompt contains the pre-brief (no per-story ID pin)", async () => {
    const prompt = await PromptBuilder.for("batch").stories([makeStory({ id: "B-001" })]).build();
    expect(prompt).toContain("# Review-Proof Tests");
  });

  test("implementer lite variant (fills coverage gaps) receives the pre-brief and relaxed isolation", async () => {
    const prompt = await PromptBuilder.for("implementer", { variant: "lite" }).story(makeStory()).build();
    expect(prompt).toContain("# Review-Proof Tests");
    // Isolation must not contradict the pre-brief: lite may add tests for uncovered ACs.
    expect(prompt).toContain("MAY add tests");
    expect(prompt).not.toMatch(/do not modify test files/i);
  });

  test.each([
    ["implementer standard — does not author tests", "implementer", { variant: "standard" as const }],
    ["verifier — reviews, never authors", "verifier", undefined],
    ["no-test — never writes tests", "no-test", undefined],
  ])("%s prompt omits the pre-brief", async (_label, role, options) => {
    const prompt = await PromptBuilder.for(role as PromptRole, options).story(makeStory()).build();
    expect(prompt).not.toContain("# Review-Proof Tests");
  });
});


