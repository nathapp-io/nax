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
import { makeTempDir } from "../../helpers/temp";

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
  test("PromptRole values are correct literals", () => {
    // This is a compile-time check — if types.ts exports correctly, import works
    const roles: PromptRole[] = ["test-writer", "implementer", "verifier", "single-session"];
    expect(roles).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 6. TS-002: tdd-simple PromptBuilder support (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("PromptBuilder — tdd-simple role", () => {
  test("PromptBuilder.for('tdd-simple') returns a PromptBuilder instance and resolves to non-empty string", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = PromptBuilder.for("tdd-simple" as any);
    expect(builder).toBeInstanceOf(PromptBuilder);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test.each([
    ["TDD instructions", "Write failing tests FIRST"],
    ["git commit instruction", "git commit -m"],
  ])("tdd-simple prompt contains %s", async (_label, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(prompt).toContain(expected);
  });

  test("tdd-simple prompt isolation section does not forbid src/ modification", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any)
      .story(makeStory())
      .build();
    expect(prompt).not.toContain("Only create or modify files in the test/ directory");
    expect(prompt).not.toContain("Do not modify test files");
  });

  test("tdd-simple prompt includes story context and conventions footer", async () => {
    const story = makeStory({ title: "TDD_SIMPLE_STORY_MARKER" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(story).build();
    expect(prompt).toContain("TDD_SIMPLE_STORY_MARKER");
    expect(prompt.toLowerCase()).toContain("conventions");
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

describe("src/prompts/types exports — tdd-simple", () => {
  test("PromptRole type should include 'tdd-simple' (5 roles total)", () => {
    // Once tdd-simple is added to PromptRole, this array should be valid TypeScript.
    // Until then, tdd-simple is cast to bypass the TS check; this test documents intent.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roles: PromptRole[] = ["test-writer", "implementer", "verifier", "single-session", "tdd-simple" as any];
    expect(roles).toContain("tdd-simple");
    expect(roles).toHaveLength(5);
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

  test("resolves to non-empty string with all story IDs, headings, batch instructions, conventions, no verdict", async () => {
    const prompt = await PromptBuilder.for("batch").stories(batchStories).build();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("BP-001");
    expect(prompt).toContain("BP-002");
    expect(prompt).toContain("## Story 1:");
    expect(prompt).toContain("## Story 2:");
    expect(prompt.toLowerCase()).not.toContain("verdict");
    expect(prompt.toLowerCase()).toMatch(/each story|implement.*story|story.*implement/);
    expect(prompt.toLowerCase()).toContain("conventions");
  });

  test("section order: role task before batch stories before conventions", async () => {
    const prompt = await PromptBuilder.for("batch")
      .stories(batchStories)
      .constitution("BATCH_CONSTITUTION_MARKER")
      .build();

    const constitutionIdx = prompt.indexOf("BATCH_CONSTITUTION_MARKER");
    const storyIdx = prompt.indexOf("BP-001");
    const conventionsIdx = prompt.lastIndexOf("conventions");

    expect(constitutionIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeGreaterThanOrEqual(0);
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

describe("src/prompts/types exports — batch", () => {
  test("PromptRole type includes 'batch' (6 roles total)", () => {
    const roles: PromptRole[] = ["test-writer", "implementer", "verifier", "single-session", "tdd-simple", "batch"];
    expect(roles).toContain("batch");
    expect(roles).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// US-001 AC4: PromptBuilder.acceptanceContext() — stores entries, builds section
// US-001 AC5: When acceptanceContext() not called, build() is identical to baseline
// ---------------------------------------------------------------------------

describe("PromptBuilder — acceptanceContext() method (US-001 AC4)", () => {
  test(".acceptanceContext() is chainable and build() includes acceptance test content and path", async () => {
    const entries = [{ testPath: "test/unit/my-feature.test.ts", content: "ACCEPTANCE_CONTENT_MARKER" }];
    const builder = PromptBuilder.for("implementer").story(makeStory()).acceptanceContext(entries);
    expect(builder).toBeInstanceOf(PromptBuilder);
    const prompt = await builder.build();
    expect(prompt).toContain("ACCEPTANCE_CONTENT_MARKER");
    expect(prompt).toContain("test/unit/my-feature.test.ts");
  });

  test("acceptance section appears after story section in build() output", async () => {
    const story = makeStory({ title: "STORY_BEFORE_ACCEPTANCE" });
    const entries = [{ testPath: "test.ts", content: "ACCEPTANCE_AFTER_STORY_MARKER" }];
    const prompt = await PromptBuilder.for("implementer")
      .story(story)
      .acceptanceContext(entries)
      .build();

    const storyIdx = prompt.indexOf("STORY_BEFORE_ACCEPTANCE");
    const acceptanceIdx = prompt.indexOf("ACCEPTANCE_AFTER_STORY_MARKER");
    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(acceptanceIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeLessThan(acceptanceIdx);
  });

  test("build() wraps acceptance content in a fenced TypeScript code block", async () => {
    const entries = [{ testPath: "test/foo.test.ts", content: "FENCED_CONTENT_MARKER" }];
    const prompt = await PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext(entries)
      .build();
    expect(prompt).toContain("```typescript");
    expect(prompt).toContain("FENCED_CONTENT_MARKER");
  });

  test("acceptanceContext() with multiple entries includes all test paths", async () => {
    const entries = [
      { testPath: "test/a.test.ts", content: "CONTENT_A" },
      { testPath: "test/b.test.ts", content: "CONTENT_B" },
    ];
    const prompt = await PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext(entries)
      .build();
    expect(prompt).toContain("test/a.test.ts");
    expect(prompt).toContain("test/b.test.ts");
    expect(prompt).toContain("CONTENT_A");
    expect(prompt).toContain("CONTENT_B");
  });
});

describe("PromptBuilder — no acceptance section when acceptanceContext() not called (US-001 AC5)", () => {
  test("build() without acceptanceContext() has no truncated marker and is deterministic", async () => {
    const story = makeStory({ title: "BASELINE_STORY_AC5" });
    const promptA = await PromptBuilder.for("implementer").story(story).build();
    expect(promptA).not.toContain("[truncated — full file at");
    const promptB = await PromptBuilder.for("implementer").story(story).build();
    expect(promptA).toBe(promptB);
  });

  test("build() without acceptanceContext() does not contain acceptance-only markers", async () => {
    const withAcceptance = await PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext([{ testPath: "test/x.test.ts", content: "UNIQUE_AC5_MARKER" }])
      .build();
    const withoutAcceptance = await PromptBuilder.for("implementer")
      .story(makeStory())
      .build();

    expect(withAcceptance).toContain("UNIQUE_AC5_MARKER");
    expect(withoutAcceptance).not.toContain("UNIQUE_AC5_MARKER");
  });
});
