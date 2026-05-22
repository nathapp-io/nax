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
  test("strict mode: no MAY read, forbids src/ modification; is pure", () => {
    const result = buildIsolationSection("strict");
    expect(result).not.toContain("MAY read");
    expect(result).toMatch(/src\//);
    expect(result.toLowerCase()).toMatch(/do not|forbidden|must not|not modify|no.*src/);
    expect(buildIsolationSection("strict")).toBe(buildIsolationSection("strict"));
  });

  test("lite mode: MAY read src/, allows stubs; is pure", () => {
    const result = buildIsolationSection("lite");
    expect(result).toContain("MAY read src/");
    expect(result.toLowerCase()).toMatch(/stub|create.*src|src.*stub/);
    expect(buildIsolationSection("lite")).toBe(buildIsolationSection("lite"));
  });
});

// ---------------------------------------------------------------------------
// buildRoleTaskSection
// ---------------------------------------------------------------------------

describe("buildRoleTaskSection", () => {
  test("standard: Do NOT modify test files, make failing tests pass; is pure", () => {
    const result = buildRoleTaskSection("standard");
    expect(result).toContain("Do NOT modify test files");
    expect(result.toLowerCase()).toMatch(/make.*fail.*test.*pass|failing tests pass/);
    expect(buildRoleTaskSection("standard")).toBe(buildRoleTaskSection("standard"));
  });

  test("lite: test-writer session, implements; is pure", () => {
    const result = buildRoleTaskSection("lite");
    expect(result).toContain("test-writer session");
    expect(result.toLowerCase()).toMatch(/implement|then implement/);
    expect(buildRoleTaskSection("lite")).toBe(buildRoleTaskSection("lite"));
  });
});

// ---------------------------------------------------------------------------
// buildStorySection
// ---------------------------------------------------------------------------

describe("buildStorySection", () => {
  test("includes title, description, and numbered acceptance criteria; is pure", () => {
    const result = buildStorySection(STORY);
    expect(result).toContain(STORY.title);
    expect(result).toContain(STORY.description);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
    for (const ac of STORY.acceptanceCriteria) {
      expect(result).toContain(ac);
    }
    expect(buildStorySection(STORY)).toBe(buildStorySection(STORY));
  });

  test("single acceptance criterion is numbered '1.'", () => {
    const result = buildStorySection({ ...STORY, acceptanceCriteria: ["Only criterion"] });
    expect(result).toContain("1. Only criterion");
  });
});

// ---------------------------------------------------------------------------
// buildVerdictSection
// ---------------------------------------------------------------------------

describe("buildVerdictSection", () => {
  test("includes verdict file, schema fields, approved conditions, quality values, no-commit instruction; is pure", () => {
    const result = buildVerdictSection(STORY);
    expect(result).toContain(".nax-verifier-verdict.json");
    expect(result).toContain('"version"');
    expect(result).toContain('"approved"');
    expect(result).toContain('"tests"');
    expect(result).toContain('"acceptanceCriteria"');
    expect(result).toContain('"quality"');
    expect(result).toContain("approved: true");
    expect(result).toContain("approved: false");
    expect(result).toContain('"good"');
    expect(result).toContain('"acceptable"');
    expect(result).toContain('"poor"');
    expect(result).toContain("do not commit code changes");
    expect(buildVerdictSection(STORY)).toBe(buildVerdictSection(STORY));
  });
});

// ---------------------------------------------------------------------------
// buildConventionsSection
// ---------------------------------------------------------------------------

describe("buildConventionsSection", () => {
  test("includes code patterns, maintainability, commit guidance; is pure", () => {
    const result = buildConventionsSection();
    expect(result).toContain("code patterns");
    expect(result.toLowerCase()).toMatch(/idiomatic|maintainable/);
    expect(result.toLowerCase()).toMatch(/commit/);
    expect(buildConventionsSection()).toBe(buildConventionsSection());
  });
});
