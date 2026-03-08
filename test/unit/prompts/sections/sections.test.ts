import { describe, expect, test } from "bun:test";
import type { UserStory } from "../../../../src/prd/types";
import { buildConventionsSection } from "../../../../src/prompts/sections/conventions";
import { buildIsolationSection } from "../../../../src/prompts/sections/isolation";
import { buildRoleTaskSection } from "../../../../src/prompts/sections/role-task";
import { buildStorySection } from "../../../../src/prompts/sections/story";
import { buildVerdictSection } from "../../../../src/prompts/sections/verdict";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: UserStory = {
  id: "PB-001",
  title: "Create PromptBuilder class",
  description: "Build a class that composes agent prompts from ordered sections.",
  acceptanceCriteria: [
    "Exports PromptBuilder class",
    "Supports chained setters for story, context, constitution, override",
    "build() returns a string with all sections joined",
  ],
  tags: ["feature", "prompts"],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

// ---------------------------------------------------------------------------
// buildIsolationSection
// ---------------------------------------------------------------------------

describe("buildIsolationSection", () => {
  test("returns a string for strict mode", () => {
    const result = buildIsolationSection("strict");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns a string for lite mode", () => {
    const result = buildIsolationSection("lite");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("strict mode does NOT contain 'MAY read'", () => {
    const result = buildIsolationSection("strict");
    expect(result).not.toContain("MAY read");
  });

  test("lite mode contains 'MAY read src/'", () => {
    const result = buildIsolationSection("lite");
    expect(result).toContain("MAY read src/");
  });

  test("strict mode forbids src/ modification", () => {
    const result = buildIsolationSection("strict");
    expect(result).toMatch(/src\//);
    // Should mention restriction / not modify / do not modify
    expect(result.toLowerCase()).toMatch(/do not|forbidden|must not|not modify|no.*src/);
  });

  test("lite mode allows creating stubs in src/", () => {
    const result = buildIsolationSection("lite");
    expect(result.toLowerCase()).toMatch(/stub|create.*src|src.*stub/);
  });

  test("is a pure function — same mode returns same output", () => {
    expect(buildIsolationSection("strict")).toBe(buildIsolationSection("strict"));
    expect(buildIsolationSection("lite")).toBe(buildIsolationSection("lite"));
  });
});

// ---------------------------------------------------------------------------
// buildRoleTaskSection
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection", () => {
  test("returns a string for standard variant", () => {
    const result = buildRoleTaskSection("standard");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns a string for lite variant", () => {
    const result = buildRoleTaskSection("lite");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("standard contains 'Do NOT modify test files'", () => {
    const result = buildRoleTaskSection("standard");
    expect(result).toContain("Do NOT modify test files");
  });

  test("standard contains instruction to make failing tests pass", () => {
    const result = buildRoleTaskSection("standard");
    expect(result.toLowerCase()).toMatch(/make.*fail.*test.*pass|failing tests pass/);
  });

  test("lite contains 'Write tests first'", () => {
    const result = buildRoleTaskSection("lite");
    expect(result).toContain("Write tests first");
  });

  test("lite contains instruction to implement", () => {
    const result = buildRoleTaskSection("lite");
    expect(result.toLowerCase()).toMatch(/implement|then implement/);
  });

  test("is a pure function — same variant returns same output", () => {
    expect(buildRoleTaskSection("standard")).toBe(buildRoleTaskSection("standard"));
    expect(buildRoleTaskSection("lite")).toBe(buildRoleTaskSection("lite"));
  });
});

// ---------------------------------------------------------------------------
// buildStorySection
// ---------------------------------------------------------------------------

describe("buildStorySection", () => {
  test("returns a non-empty string", () => {
    const result = buildStorySection(STORY);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes the story title", () => {
    const result = buildStorySection(STORY);
    expect(result).toContain(STORY.title);
  });

  test("includes the story description", () => {
    const result = buildStorySection(STORY);
    expect(result).toContain(STORY.description);
  });

  test("formats acceptance criteria as numbered list", () => {
    const result = buildStorySection(STORY);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
    expect(result).toContain(STORY.acceptanceCriteria[0]);
    expect(result).toContain(STORY.acceptanceCriteria[1]);
    expect(result).toContain(STORY.acceptanceCriteria[2]);
  });

  test("is pure — same story returns same output", () => {
    expect(buildStorySection(STORY)).toBe(buildStorySection(STORY));
  });

  test("single acceptance criterion is numbered '1.'", () => {
    const singleAC: UserStory = { ...STORY, acceptanceCriteria: ["Only criterion"] };
    const result = buildStorySection(singleAC);
    expect(result).toContain("1. Only criterion");
  });
});

// ---------------------------------------------------------------------------
// buildVerdictSection
// ---------------------------------------------------------------------------

describe("buildVerdictSection", () => {
  test("returns a non-empty string", () => {
    const result = buildVerdictSection(STORY);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes the verdict file name .nax-verifier-verdict.json", () => {
    const result = buildVerdictSection(STORY);
    expect(result).toContain(".nax-verifier-verdict.json");
  });

  test("includes JSON schema example with required fields", () => {
    const result = buildVerdictSection(STORY);
    expect(result).toContain('"version"');
    expect(result).toContain('"approved"');
    expect(result).toContain('"tests"');
    expect(result).toContain('"acceptanceCriteria"');
    expect(result).toContain('"quality"');
  });

  test("includes approved: true and approved: false conditions", () => {
    const result = buildVerdictSection(STORY);
    expect(result).toContain("approved: true");
    expect(result).toContain("approved: false");
  });

  test("includes quality rating values", () => {
    const result = buildVerdictSection(STORY);
    expect(result).toContain('"good"');
    expect(result).toContain('"acceptable"');
    expect(result).toContain('"poor"');
  });

  test("includes commit instruction referencing the story title", () => {
    const result = buildVerdictSection(STORY);
    expect(result).toContain(STORY.title);
  });

  test("is pure — same story returns same output", () => {
    expect(buildVerdictSection(STORY)).toBe(buildVerdictSection(STORY));
  });
});

// ---------------------------------------------------------------------------
// buildConventionsSection
// ---------------------------------------------------------------------------

describe("buildConventionsSection", () => {
  test("returns a non-empty string", () => {
    const result = buildConventionsSection();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes bun test scoping warning", () => {
    const result = buildConventionsSection();
    expect(result).toContain("bun test");
    expect(result).toMatch(/NEVER run `bun test` without a file filter|without a file filter/);
  });

  test("includes context window flood warning", () => {
    const result = buildConventionsSection();
    expect(result.toLowerCase()).toMatch(/flood|context window/);
  });

  test("includes commit message instruction", () => {
    const result = buildConventionsSection();
    expect(result.toLowerCase()).toMatch(/commit/);
  });

  test("is a pure function — returns same output each call", () => {
    expect(buildConventionsSection()).toBe(buildConventionsSection());
  });
});
