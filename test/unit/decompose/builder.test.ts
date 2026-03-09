/**
 * Tests for DecomposeBuilder fluent API.
 *
 * Covers AC:
 * - DecomposeBuilder.for(story) returns builder instance
 * - Fluent API: .prd(), .codebase(), .config() all return builder (chainable)
 * - .buildPrompt() composes all 4 sections with SECTION_SEP separators
 * - Target story section includes full story details
 * - Sibling stories section includes all other PRD stories
 * - Constraints section includes max substories, max complexity, JSON schema, nonOverlapJustification
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { DecomposeBuilder, SECTION_SEP } from "../../../src/decompose/builder";
import type { DecomposeAdapter, DecomposeConfig } from "../../../src/decompose/types";
import type { UserStory, PRD } from "../../../src/prd";
import type { CodebaseScan } from "../../../src/analyze/types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "SD-001",
    title: "Core decompose builder",
    description: "Create the fluent decompose builder",
    acceptanceCriteria: ["Builder returns instance", "Prompt contains story details"],
    tags: ["architecture", "core"],
    dependencies: ["SD-000"],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makeSiblingStory(id: string, status: UserStory["status"] = "pending"): UserStory {
  return {
    id,
    title: `Sibling story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC one", "AC two"],
    tags: [],
    dependencies: [],
    status,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(targetStory: UserStory, siblings: UserStory[] = []): PRD {
  return {
    project: "nax",
    feature: "story-decompose",
    branchName: "feat/story-decompose",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: [targetStory, ...siblings],
  };
}

function makeCodebaseScan(): CodebaseScan {
  return {
    fileTree: "src/\n  decompose/\n    builder.ts",
    dependencies: { typescript: "5.0.0" },
    devDependencies: { biome: "1.0.0" },
    testPatterns: ["bun:test", "test/unit/"],
  };
}

function makeConfig(overrides: Partial<DecomposeConfig> = {}): DecomposeConfig {
  return {
    maxSubStories: 5,
    maxComplexity: "complex",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DecomposeBuilder.for()
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.for()", () => {
  test("returns a DecomposeBuilder instance", () => {
    const story = makeStory();
    const builder = DecomposeBuilder.for(story);
    expect(builder).toBeInstanceOf(DecomposeBuilder);
  });

  test("returns a different instance each call", () => {
    const story = makeStory();
    const b1 = DecomposeBuilder.for(story);
    const b2 = DecomposeBuilder.for(story);
    expect(b1).not.toBe(b2);
  });
});

// ---------------------------------------------------------------------------
// Fluent API chainability
// ---------------------------------------------------------------------------

describe("DecomposeBuilder fluent API", () => {
  let story: UserStory;
  let prd: PRD;
  let scan: CodebaseScan;
  let cfg: DecomposeConfig;
  let builder: DecomposeBuilder;

  beforeEach(() => {
    story = makeStory();
    prd = makePrd(story);
    scan = makeCodebaseScan();
    cfg = makeConfig();
    builder = DecomposeBuilder.for(story);
  });

  test(".prd() returns the same builder instance (chainable)", () => {
    const result = builder.prd(prd);
    expect(result).toBe(builder);
  });

  test(".codebase() returns the same builder instance (chainable)", () => {
    const result = builder.codebase(scan);
    expect(result).toBe(builder);
  });

  test(".config() returns the same builder instance (chainable)", () => {
    const result = builder.config(cfg);
    expect(result).toBe(builder);
  });

  test("full chain returns builder at each step", () => {
    const b1 = DecomposeBuilder.for(story);
    const b2 = b1.prd(prd);
    const b3 = b2.codebase(scan);
    const b4 = b3.config(cfg);

    expect(b1).toBe(b2);
    expect(b2).toBe(b3);
    expect(b3).toBe(b4);
  });

  test("methods can be chained in one expression without error", () => {
    expect(() => {
      DecomposeBuilder.for(story).prd(prd).codebase(scan).config(cfg);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildPrompt() — section composition
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.buildPrompt()", () => {
  let story: UserStory;
  let sibling: UserStory;
  let prd: PRD;
  let scan: CodebaseScan;
  let cfg: DecomposeConfig;
  let prompt: string;

  beforeEach(() => {
    story = makeStory();
    sibling = makeSiblingStory("SD-002", "passed");
    prd = makePrd(story, [sibling]);
    scan = makeCodebaseScan();
    cfg = makeConfig();

    prompt = DecomposeBuilder.for(story).prd(prd).codebase(scan).config(cfg).buildPrompt();
  });

  test("returns a non-empty string", () => {
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("sections are joined with SECTION_SEP", () => {
    expect(prompt).toContain(SECTION_SEP);
  });

  test("contains at least 3 SECTION_SEP separators (4 sections)", () => {
    const parts = prompt.split(SECTION_SEP);
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });

  // --- Target story section ---

  test("target story section includes the story ID", () => {
    expect(prompt).toContain("SD-001");
  });

  test("target story section includes the story title", () => {
    expect(prompt).toContain("Core decompose builder");
  });

  test("target story section includes the story description", () => {
    expect(prompt).toContain("Create the fluent decompose builder");
  });

  test("target story section includes acceptance criteria", () => {
    expect(prompt).toContain("Builder returns instance");
    expect(prompt).toContain("Prompt contains story details");
  });

  test("target story section includes tags", () => {
    expect(prompt).toContain("architecture");
    expect(prompt).toContain("core");
  });

  test("target story section includes dependencies", () => {
    expect(prompt).toContain("SD-000");
  });

  test("target story section includes a decompose instruction", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("decompose");
  });

  // --- Sibling stories section ---

  test("sibling stories section includes other story IDs", () => {
    expect(prompt).toContain("SD-002");
  });

  test("sibling stories section includes sibling title", () => {
    expect(prompt).toContain("Sibling story SD-002");
  });

  test("sibling stories section includes sibling status", () => {
    expect(prompt).toContain("passed");
  });

  test("sibling stories section includes sibling AC summary", () => {
    expect(prompt).toContain("AC one");
  });

  test("sibling stories section does NOT repeat the target story", () => {
    // Target story should appear in target section; but sibling section
    // should only list OTHER stories. We check SD-001 is not listed as a sibling.
    const siblingSection = extractSiblingSection(prompt);
    // The sibling section should not contain SD-001 as a sibling entry
    // (it may appear in the target section, but not in sibling list)
    expect(siblingSection).not.toContain("SD-001");
  });

  // --- Constraints section ---

  test("constraints section includes max substories value", () => {
    expect(prompt).toContain("5");
  });

  test("constraints section mentions max substories concept", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/max.*sub.?stor|sub.?stor.*max/);
  });

  test("constraints section includes max complexity", () => {
    expect(prompt).toContain("complex");
  });

  test("constraints section includes JSON output schema", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("json");
    // Must include schema field names
    expect(prompt).toContain("nonOverlapJustification");
  });

  test("constraints section requires nonOverlapJustification", () => {
    expect(prompt).toContain("nonOverlapJustification");
  });

  test("constraints section includes parentStoryId in schema", () => {
    expect(prompt).toContain("parentStoryId");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt() — edge cases
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.buildPrompt() — edge cases", () => {
  test("works with a story that has no dependencies", () => {
    const story = makeStory({ dependencies: [] });
    const prd = makePrd(story);
    const prompt = DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).buildPrompt();
    expect(prompt).toBeTruthy();
  });

  test("works with a story that has no tags", () => {
    const story = makeStory({ tags: [] });
    const prd = makePrd(story);
    const prompt = DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).buildPrompt();
    expect(prompt).toBeTruthy();
  });

  test("works when PRD has no sibling stories", () => {
    const story = makeStory();
    const prd = makePrd(story, []);
    const prompt = DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).buildPrompt();
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("SD-001");
  });

  test("works with multiple siblings", () => {
    const story = makeStory();
    const siblings = [
      makeSiblingStory("SD-002"),
      makeSiblingStory("SD-003", "in-progress"),
      makeSiblingStory("SD-004", "failed"),
    ];
    const prd = makePrd(story, siblings);
    const prompt = DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).buildPrompt();

    expect(prompt).toContain("SD-002");
    expect(prompt).toContain("SD-003");
    expect(prompt).toContain("SD-004");
    expect(prompt).toContain("in-progress");
    expect(prompt).toContain("failed");
  });
});

// ---------------------------------------------------------------------------
// decompose() — adapter integration
// ---------------------------------------------------------------------------

describe("DecomposeBuilder.decompose()", () => {
  test("calls adapter.decompose() with the built prompt", async () => {
    const story = makeStory();
    const prd = makePrd(story);
    const scan = makeCodebaseScan();
    const cfg = makeConfig();

    const rawResponse = JSON.stringify([
      {
        id: "SD-001-1",
        parentStoryId: "SD-001",
        title: "Sub-story one",
        description: "First sub-story",
        acceptanceCriteria: ["AC one"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "Covers only the builder interface",
      },
    ]);

    let capturedPrompt: string | undefined;
    const adapter: DecomposeAdapter = {
      decompose: mock(async (p: string) => {
        capturedPrompt = p;
        return rawResponse;
      }),
    };

    const builder = DecomposeBuilder.for(story).prd(prd).codebase(scan).config(cfg);
    const expectedPrompt = builder.buildPrompt();

    await builder.decompose(adapter);

    expect(capturedPrompt).toBe(expectedPrompt);
    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });

  test("returns DecomposeResult with subStories array", async () => {
    const story = makeStory();
    const prd = makePrd(story);

    const rawResponse = JSON.stringify([
      {
        id: "SD-001-1",
        parentStoryId: "SD-001",
        title: "Sub-story one",
        description: "First sub-story",
        acceptanceCriteria: ["AC one"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "No overlap",
      },
    ]);

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => rawResponse),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).decompose(adapter);

    expect(result).toHaveProperty("subStories");
    expect(Array.isArray(result.subStories)).toBe(true);
    expect(result.subStories.length).toBe(1);
  });

  test("returned sub-story includes parentStoryId", async () => {
    const story = makeStory();
    const prd = makePrd(story);

    const rawResponse = JSON.stringify([
      {
        id: "SD-001-1",
        parentStoryId: "SD-001",
        title: "Sub-story one",
        description: "First sub-story",
        acceptanceCriteria: ["AC one"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "No overlap",
      },
    ]);

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => rawResponse),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).decompose(adapter);

    expect(result.subStories[0].parentStoryId).toBe("SD-001");
  });

  test("returned sub-story includes nonOverlapJustification", async () => {
    const story = makeStory();
    const prd = makePrd(story);

    const rawResponse = JSON.stringify([
      {
        id: "SD-001-1",
        parentStoryId: "SD-001",
        title: "Sub-story one",
        description: "First sub-story",
        acceptanceCriteria: ["AC one"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "Covers only the builder interface",
      },
    ]);

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => rawResponse),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).decompose(adapter);

    expect(result.subStories[0].nonOverlapJustification).toBe("Covers only the builder interface");
  });

  test("returns validation object", async () => {
    const story = makeStory();
    const prd = makePrd(story);

    const rawResponse = JSON.stringify([
      {
        id: "SD-001-1",
        parentStoryId: "SD-001",
        title: "Sub-story one",
        description: "First sub-story",
        acceptanceCriteria: ["AC one"],
        tags: [],
        dependencies: [],
        complexity: "simple",
        nonOverlapJustification: "No overlap",
      },
    ]);

    const adapter: DecomposeAdapter = {
      decompose: mock(async () => rawResponse),
    };

    const result = await DecomposeBuilder.for(story).prd(prd).codebase(makeCodebaseScan()).config(makeConfig()).decompose(adapter);

    expect(result).toHaveProperty("validation");
    expect(typeof result.validation.valid).toBe("boolean");
    expect(Array.isArray(result.validation.errors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exports from src/decompose/index.ts
// ---------------------------------------------------------------------------

describe("src/decompose/index.ts exports", () => {
  test("exports DecomposeBuilder", async () => {
    const mod = await import("../../../src/decompose/index");
    expect(mod.DecomposeBuilder).toBeDefined();
  });

  test("exports SECTION_SEP", async () => {
    const mod = await import("../../../src/decompose/index");
    expect(mod.SECTION_SEP).toBe("\n\n---\n\n");
  });

  test("exports section builders", async () => {
    const mod = await import("../../../src/decompose/index");
    expect(mod.buildTargetStorySection).toBeDefined();
    expect(mod.buildSiblingStoriesSection).toBeDefined();
    expect(mod.buildCodebaseSection).toBeDefined();
    expect(mod.buildConstraintsSection).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the section of the prompt that lists sibling stories.
 * Uses SECTION_SEP to split and finds the section that does NOT contain
 * the target story ID but does contain sibling IDs.
 */
function extractSiblingSection(prompt: string): string {
  const sections = prompt.split(SECTION_SEP);
  // Find section that contains "SD-002" but not a section header that is the target story
  return sections.find((s) => s.includes("SD-002") && !s.includes("Core decompose builder")) ?? "";
}
