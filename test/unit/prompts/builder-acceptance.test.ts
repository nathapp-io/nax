/**
 * Unit tests for PromptBuilder.acceptanceContext() — US-001 AC4–AC5
 *
 * RED phase: tests will fail until buildAcceptanceSection() is implemented
 * and PromptBuilder.build() emits the acceptance section after the story section.
 */

import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../src/prd";
import { PromptBuilder } from "../../../src/prompts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Build acceptance bridge",
    description: "Inject acceptance tests into the implementer prompt",
    acceptanceCriteria: ["AC1", "AC2"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC4: acceptanceContext() is chainable
// ─────────────────────────────────────────────────────────────────────────────

describe("PromptBuilder.acceptanceContext() — fluent API", () => {
  test("acceptanceContext() returns PromptBuilder instance (chainable)", () => {
    const builder = PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext([]);
    expect(builder).toBeInstanceOf(PromptBuilder);
  });

  test("acceptanceContext() can be chained with story() and build()", async () => {
    const result = PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext([{ testPath: "foo.test.ts", content: "// test" }])
      .build();
    expect(result).toBeInstanceOf(Promise);
    const text = await result;
    expect(typeof text).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: build() includes acceptance section when acceptanceContext() is called
// ─────────────────────────────────────────────────────────────────────────────

describe("PromptBuilder.build() — with acceptanceContext()", () => {
  test("build() output contains the test path when acceptanceContext() is called", async () => {
    const prompt = await PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext([{ testPath: "test/unit/foo.test.ts", content: "// file content" }])
      .build();

    expect(prompt).toContain("test/unit/foo.test.ts");
  });

  test("build() output contains the test content when acceptanceContext() is called", async () => {
    const prompt = await PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext([
        { testPath: "acceptance.test.ts", content: "ACCEPTANCE_CONTENT_MARKER" },
      ])
      .build();

    expect(prompt).toContain("ACCEPTANCE_CONTENT_MARKER");
  });

  test("acceptance section appears after the story section in build() output", async () => {
    const story = makeStory({ title: "STORY_TITLE_FOR_ORDER_TEST" });
    const prompt = await PromptBuilder.for("implementer")
      .story(story)
      .acceptanceContext([{ testPath: "order.test.ts", content: "ACCEPTANCE_ORDER_MARKER" }])
      .build();

    const storyIdx = prompt.indexOf("STORY_TITLE_FOR_ORDER_TEST");
    const acceptanceIdx = prompt.indexOf("ACCEPTANCE_ORDER_MARKER");

    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(acceptanceIdx).toBeGreaterThanOrEqual(0);
    expect(storyIdx).toBeLessThan(acceptanceIdx);
  });

  test("acceptance section appears before conventions footer", async () => {
    const prompt = await PromptBuilder.for("implementer")
      .story(makeStory())
      .acceptanceContext([{ testPath: "a.test.ts", content: "BEFORE_CONVENTIONS" }])
      .build();

    const acceptanceIdx = prompt.indexOf("BEFORE_CONVENTIONS");
    const conventionsIdx = prompt.lastIndexOf("conventions");

    expect(acceptanceIdx).toBeGreaterThanOrEqual(0);
    expect(conventionsIdx).toBeGreaterThanOrEqual(0);
    expect(acceptanceIdx).toBeLessThan(conventionsIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: when acceptanceContext() is NOT called, build() is identical to current behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("PromptBuilder.build() — without acceptanceContext()", () => {
  test("build() does not emit an acceptance section when acceptanceContext() is not called", async () => {
    const story = makeStory({ title: "NO_ACCEPTANCE_CONTEXT_STORY" });

    const withoutAcceptance = await PromptBuilder.for("implementer").story(story).build();
    const withAcceptance = await PromptBuilder.for("implementer")
      .story(story)
      .acceptanceContext([{ testPath: "t.test.ts", content: "ACCEPTANCE_MARKER" }])
      .build();

    // Without acceptanceContext: no acceptance marker in output
    expect(withoutAcceptance).not.toContain("ACCEPTANCE_MARKER");
    // With acceptanceContext: marker IS present (will fail until implemented — RED)
    expect(withAcceptance).toContain("ACCEPTANCE_MARKER");
  });

  test("build() output without acceptanceContext matches build() with empty entries", async () => {
    const story = makeStory({ title: "EMPTY_ENTRIES_STORY" });

    const withoutMethod = await PromptBuilder.for("tdd-simple").story(story).build();
    const withEmpty = await PromptBuilder.for("tdd-simple")
      .story(story)
      .acceptanceContext([])
      .build();

    expect(withoutMethod).toBe(withEmpty);
  });

  test("story section still present when acceptanceContext() is not called", async () => {
    const story = makeStory({ title: "STORY_PRESENT_WITHOUT_ACCEPTANCE" });
    const prompt = await PromptBuilder.for("implementer").story(story).build();
    expect(prompt).toContain("STORY_PRESENT_WITHOUT_ACCEPTANCE");
  });
});
