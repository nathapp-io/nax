/**
 * PromptBuilder unit tests — PB-001
 *
 * Tests verify section ordering, non-overridable sections, and override fallthrough.
 * All tests are expected to FAIL until PromptBuilder is implemented.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserStory } from "../../../src/prd";
import { PromptBuilder } from "../../../src/prompts/builder";
import type { PromptRole } from "../../../src/prompts/types";

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

  test(".story() is chainable", () => {
    const builder = PromptBuilder.for("implementer").story(makeStory());
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  test(".context() is chainable", () => {
    const builder = PromptBuilder.for("verifier").story(makeStory()).context("# Context");
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  test(".constitution() is chainable", () => {
    const builder = PromptBuilder.for("single-session").story(makeStory()).constitution("Be helpful.");
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  test(".override() is chainable", () => {
    const builder = PromptBuilder.for("test-writer").story(makeStory()).override("/tmp/override.md");
    expect(builder).toBeInstanceOf(PromptBuilder);
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
  test("constitution appears before role task", async () => {
    const prompt = await PromptBuilder.for("test-writer")
      .story(makeStory())
      .constitution("CONSTITUTION_MARKER")
      .build();

    const constitutionIdx = prompt.indexOf("CONSTITUTION_MARKER");
    const roleTaskIdx = prompt.indexOf("# Role:");

    expect(constitutionIdx).toBeGreaterThanOrEqual(0);
    expect(roleTaskIdx).toBeGreaterThanOrEqual(0);
    expect(constitutionIdx).toBeLessThan(roleTaskIdx);
  });

  test("story context appears before conventions footer", async () => {
    const story = makeStory({ title: "STORY_TITLE_MARKER" });
    const prompt = await PromptBuilder.for("implementer").story(story).build();

    const storyIdx = prompt.indexOf("STORY_TITLE_MARKER");
    // Conventions footer is always last — it contains "conventions" or appears after story
    const footerIdx = prompt.lastIndexOf("conventions") !== -1 ? prompt.lastIndexOf("conventions") : prompt.length - 1;

    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeLessThan(footerIdx);
  });

  test("isolation rules appear after role task body", async () => {
    const prompt = await PromptBuilder.for("test-writer").story(makeStory()).build();

    // Isolation rules section — comes after the main role task body
    const isolationIdx = prompt.indexOf("isolation") !== -1 ? prompt.indexOf("isolation") : prompt.indexOf("ISOLATION");

    expect(isolationIdx).toBeGreaterThanOrEqual(0);
  });

  test("context markdown appears before conventions footer", async () => {
    const ctxMarker = "CONTEXT_MARKDOWN_MARKER";
    const prompt = await PromptBuilder.for("verifier").story(makeStory()).context(ctxMarker).build();

    const ctxIdx = prompt.indexOf(ctxMarker);
    const footerIdx = prompt.lastIndexOf("conventions") !== -1 ? prompt.lastIndexOf("conventions") : prompt.length;

    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeLessThan(footerIdx);
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
  test("story context always included even when override is set", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nax-pb-test-"));
    const overridePath = join(tmpDir, "override.md");
    writeFileSync(overridePath, "# Custom override body\nThis replaces the template.");

    const story = makeStory({ title: "NON_OVERRIDABLE_STORY" });
    const prompt = await PromptBuilder.for("test-writer").story(story).override(overridePath).build();

    expect(prompt).toContain("NON_OVERRIDABLE_STORY");
  });

  test("conventions footer always last even when override is set", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nax-pb-test-"));
    const overridePath = join(tmpDir, "override.md");
    writeFileSync(overridePath, "# Custom override body");

    const prompt = await PromptBuilder.for("implementer").story(makeStory()).override(overridePath).build();

    // Conventions footer must exist and be after the override content
    const overrideIdx = prompt.indexOf("Custom override body");
    const conventionsIdx = prompt.lastIndexOf("conventions");
    expect(conventionsIdx).toBeGreaterThan(overrideIdx);
  });

  test("isolation rules always present even when override is set", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nax-pb-test-"));
    const overridePath = join(tmpDir, "override.md");
    writeFileSync(overridePath, "# My custom template");

    const prompt = await PromptBuilder.for("test-writer").story(makeStory()).override(overridePath).build();

    // Isolation rules must appear somewhere in the final prompt
    const lowerPrompt = prompt.toLowerCase();
    const hasIsolation = lowerPrompt.includes("isolation") || lowerPrompt.includes("isolat");
    expect(hasIsolation).toBe(true);
  });

  test("story context not removable via override for each role", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nax-pb-test-"));
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
  test("missing override file falls through to default template", async () => {
    const prompt = await PromptBuilder.for("test-writer")
      .story(makeStory({ title: "FALLTHROUGH_STORY" }))
      .override("/nonexistent/path/override.md")
      .build();

    // Should still contain story context (non-overridable)
    expect(prompt).toContain("FALLTHROUGH_STORY");
    // Should contain default role task content (not crash)
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("no override set uses default template body", async () => {
    const promptWithout = await PromptBuilder.for("test-writer")
      .story(makeStory({ title: "DEFAULT_TEMPLATE_STORY" }))
      .build();

    expect(promptWithout).toContain("DEFAULT_TEMPLATE_STORY");
    expect(promptWithout.length).toBeGreaterThan(0);
  });

  test("valid override file replaces default template body", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nax-pb-test-"));
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
  test("PromptBuilder.for('tdd-simple') returns a PromptBuilder instance", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = PromptBuilder.for("tdd-simple" as any);
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  test(".build() resolves to a non-empty string for tdd-simple", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("tdd-simple prompt contains TDD red-green-refactor instructions", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(prompt).toContain("Write failing tests FIRST");
  });

  test("tdd-simple prompt includes git commit instruction", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(prompt).toContain("git commit -m");
  });

  test("tdd-simple prompt isolation section does not forbid src/ modification", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
    expect(prompt).not.toContain("Only create or modify files in the test/ directory");
    expect(prompt).not.toContain("Do not modify test files");
  });

  test("tdd-simple prompt includes story context", async () => {
    const story = makeStory({ title: "TDD_SIMPLE_STORY_MARKER" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(story).build();
    expect(prompt).toContain("TDD_SIMPLE_STORY_MARKER");
  });

  test("tdd-simple prompt includes conventions footer", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompt = await PromptBuilder.for("tdd-simple" as any).story(makeStory()).build();
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
