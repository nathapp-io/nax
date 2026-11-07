import { describe, expect, test } from "bun:test";
import type { UserStory } from "@/prd/types";
import * as sectionsBarrel from "@/prompts/sections";
import { applyProtocolRegions, buildStorySection, wrapAffordance } from "@/prompts/sections";
import { buildConventionsSection } from "@/prompts/sections/conventions";
import { buildIsolationSection } from "@/prompts/sections/isolation";

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

// ---------------------------------------------------------------------------
// US-002 (pipeline-surface-delete) — the barrel's surviving surface
// ---------------------------------------------------------------------------

describe("prompt-sections barrel surface", () => {
  // The TDD prompt builder was the last consumer of these; with it gone they
  // are removed outright, with no replacement aliases.
  test.each([
    "buildHermeticSection",
    "buildRoleTaskSection",
    "buildSelfVerificationSection",
    "buildTddLanguageSection",
    "buildTestBaselineSection",
    "MAX_BASELINE_SECTION_CHARS",
    "buildTestQualitySection",
    "buildVerdictSection",
    "buildBatchStorySection",
    "buildStoryReminderSection",
    "unwrapProtocolRegions",
  ])("no longer re-exports %s", (name) => {
    expect(name in sectionsBarrel).toBe(false);
  });

  test("still re-exports the integration symbols workflow mode uses", () => {
    expect(typeof sectionsBarrel.buildStorySection).toBe("function");
    expect(typeof sectionsBarrel.applyProtocolRegions).toBe("function");
    expect(typeof sectionsBarrel.wrapAffordance).toBe("function");
    expect(applyProtocolRegions("plain prompt", { protocol: "acp" })).toBe("plain prompt");
    expect(typeof wrapAffordance).toBe("function");
  });
});
