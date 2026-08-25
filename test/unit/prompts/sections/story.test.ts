import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { UserStory } from "@/prd/types";
import { buildBatchStorySection, buildStoryReminderSection, buildStorySection } from "@/prompts/sections/story";

describe("buildStorySection", () => {
  const mockStory = makeStory({
    id: "STORY-001",
    title: "Test Story",
    description: "This is a test story",
    acceptanceCriteria: ["Criterion 1", "Criterion 2", "Criterion 3"],
  });

  test("includes story title", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("Test Story");
  });

  test("includes story description", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("This is a test story");
  });

  test("includes numbered acceptance criteria", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("1. Criterion 1");
    expect(result).toContain("2. Criterion 2");
    expect(result).toContain("3. Criterion 3");
  });

  test("formats criteria with numeric prefixes", () => {
    const result = buildStorySection(mockStory);
    const lines = result.split("\n");
    const criteriaLines = lines.filter((l) => /^\d+\./.test(l.trim()));
    expect(criteriaLines.length).toBe(3);
  });
});

describe("buildStoryReminderSection", () => {
  test("mirrors numbered acceptance criteria", () => {
    const story = makeStory({
      title: "Reminder Recency Story",
      acceptanceCriteria: ["Save the reminder AC", "Render it near the bottom"],
    });

    const result = buildStoryReminderSection(story);

    expect(result).toContain("Reminder Recency Story");
    expect(result).toContain("1. Save the reminder AC");
    expect(result).toContain("2. Render it near the bottom");
  });

  test("wraps mirrored criteria as user-supplied data", () => {
    const criterion = "Boundary-protected AC";
    const result = buildStoryReminderSection(makeStory({ acceptanceCriteria: [criterion] }));

    const boundaryStartIdx = result.indexOf("<!-- USER-SUPPLIED DATA");
    const criterionIdx = result.indexOf(criterion);
    const boundaryEndIdx = result.indexOf("<!-- END USER-SUPPLIED DATA -->");

    expect(boundaryStartIdx).toBeGreaterThanOrEqual(0);
    expect(criterionIdx).toBeGreaterThan(boundaryStartIdx);
    expect(boundaryEndIdx).toBeGreaterThan(criterionIdx);
  });

  test("falls back cleanly with no acceptance criteria", () => {
    const result = buildStoryReminderSection(makeStory({ title: "Empty AC Story", acceptanceCriteria: [] }));

    expect(result).toBe(
      "---\n\n**Reminder:** Your task is to implement **Empty AC Story**. Satisfy every acceptance criterion listed above before finishing.",
    );
    expect(result).not.toContain("**Acceptance Criteria:**");
  });

  test("preserves acceptance criterion text verbatim", () => {
    const criterion = "Preserve **markdown-ish** text, punctuation, and `code()` exactly.";
    const result = buildStoryReminderSection(makeStory({ acceptanceCriteria: [criterion] }));

    expect(result).toContain(`1. ${criterion}`);
  });
});

// ---------------------------------------------------------------------------
// BP-001: buildBatchStorySection tests (RED phase — will fail until implemented)
// ---------------------------------------------------------------------------

describe("buildBatchStorySection", () => {
  const storyA = makeStory({
    id: "BP-001",
    title: "First Batch Story",
    description: "Description for first story",
    acceptanceCriteria: ["AC 1a", "AC 1b"],
  });

  const storyB = makeStory({
    id: "BP-002",
    title: "Second Batch Story",
    description: "Description for second story",
    acceptanceCriteria: ["AC 2a"],
  });

  test("includes USER-SUPPLIED DATA opening boundary tag", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result).toContain("<!-- USER-SUPPLIED DATA:");
  });

  test("includes END USER-SUPPLIED DATA closing boundary tag", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result).toContain("<!-- END USER-SUPPLIED DATA -->");
  });

  test("formats each story heading as '## Story N: {id} - {title}'", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result).toContain("## Story 1: BP-001 - First Batch Story");
    expect(result).toContain("## Story 2: BP-002 - Second Batch Story");
  });

  test("includes description for each story", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result).toContain("Description for first story");
    expect(result).toContain("Description for second story");
  });

  test("includes numbered acceptance criteria for each story", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    expect(result).toContain("1. AC 1a");
    expect(result).toContain("2. AC 1b");
    expect(result).toContain("1. AC 2a");
  });

  test("renders all story IDs in order", () => {
    const result = buildBatchStorySection([storyA, storyB]);
    const idxA = result.indexOf("BP-001");
    const idxB = result.indexOf("BP-002");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });

  test("single story uses heading '## Story 1: {id} - {title}'", () => {
    const result = buildBatchStorySection([storyA]);
    expect(result).toContain("## Story 1: BP-001 - First Batch Story");
  });
});

describe("out-of-scope rendering", () => {
  const withExclusions = (): UserStory =>
    makeStory({
      id: "STORY-001",
      title: "Test Story",
      description: "This is a test story",
      acceptanceCriteria: ["Criterion 1"],
      outOfScope: ["An interactive Ink TUI", "Per-story checkpoints"],
    });

  test("buildStorySection renders a labelled out-of-scope block", () => {
    const result = buildStorySection(withExclusions());
    expect(result).toContain("**Out of Scope — do NOT implement these:**");
    expect(result).toContain("- An interactive Ink TUI");
    expect(result).toContain("- Per-story checkpoints");
  });

  test("buildStoryReminderSection repeats the out-of-scope block", () => {
    expect(buildStoryReminderSection(withExclusions())).toContain("- An interactive Ink TUI");
  });

  test("buildBatchStorySection renders each story's own exclusions", () => {
    const result = buildBatchStorySection([
      withExclusions(),
      makeStory({ id: "STORY-002", outOfScope: ["No caching"] }),
    ]);
    expect(result).toContain("- An interactive Ink TUI");
    expect(result).toContain("- No caching");
  });

  test("omits the block entirely when the story declares no exclusions", () => {
    const result = buildStorySection(makeStory({ id: "STORY-003", acceptanceCriteria: ["Criterion 1"] }));
    expect(result).not.toContain("Out of Scope");
  });

  test("keeps exclusions outside the acceptance-criteria list", () => {
    const result = buildStorySection(withExclusions());
    const acIndex = result.indexOf("**Acceptance Criteria:**");
    const oosIndex = result.indexOf("**Out of Scope");
    expect(acIndex).toBeGreaterThan(-1);
    expect(oosIndex).toBeGreaterThan(acIndex);
    expect(result).not.toContain("2. An interactive Ink TUI");
  });
});
