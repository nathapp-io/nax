import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { UserStory } from "@/prd/types";
import { buildStorySection } from "@/prompts/sections";

/** Lines that read as a rendered acceptance criterion (`1. something`). */
function numberedCriterionLines(text: string): string[] {
  return text.split("\n").filter((line) => /^\d+\.\s/.test(line));
}

describe("buildStorySection", () => {
  const mockStory = makeStory({
    id: "STORY-001",
    title: "Test Story",
    description: "This is a test story",
    acceptanceCriteria: ["Criterion 1", "Criterion 2", "Criterion 3"],
  });

  test("includes story title; includes story description", () => {
    const result = buildStorySection(mockStory);
    expect(result).toContain("Test Story");
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
    expect(numberedCriterionLines(result).length).toBe(3);
  });
});

// US-002 (pipeline-surface-delete) regression guards. `buildStorySection` is
// the one story-section builder that survives the deletion — its remaining
// caller, RectifierPromptBuilder, reaches it through the public
// `@/prompts/sections` barrel, so the barrel entry is what these pin.
describe("buildStorySection via the @/prompts/sections barrel", () => {
  const story = makeStory({ title: "Add login", acceptanceCriteria: ["AC-1: form renders"] });

  test("includes the story title", () => {
    expect(buildStorySection(story)).toContain("Add login");
  });

  test("includes the acceptance criterion verbatim", () => {
    expect(buildStorySection(story)).toContain("AC-1: form renders");
  });

  // Negative path: a story with no acceptance criteria must render no numbered
  // criterion line. The section keeps its "**Acceptance Criteria:**" heading
  // and renders nothing under it — it must not invent a requirement.
  test("renders no numbered acceptance-criterion line for a story with none", () => {
    const rendered = buildStorySection(
      makeStory({ title: "Add login", description: "Add a login form", acceptanceCriteria: [] }),
    );

    expect(numberedCriterionLines(rendered)).toEqual([]);
    expect(rendered).not.toContain("**Acceptance Criteria:**\n1.");
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

// nax single-frame redesign PR 2: the agent's file tools (Read/Write/Edit/Grep/
// Git) are now rooted at the REPO root, so a repo-rooted `modifiedFiles` entry
// is addressable as stored and must be rendered verbatim — no package reframe.
// The old nax#2085 package-frame re-spelling is gone.
describe("modifiedFiles rendered repo-rooted as stored (single-frame PR 2)", () => {
  const mod = (path: string, reason: string): { path: string; reason: string } => ({ path, reason });

  test("renders an in-package repo-rooted entry repo-rooted, not package-relative", () => {
    const rendered = buildStorySection(
      makeStory({
        workdir: "packages/api",
        workdirSource: "stated",
        acceptanceCriteria: ["works"],
        modifiedFiles: [mod("packages/api/src/foo.ts", "the assertion moved")],
      }),
    );

    expect(rendered).toContain("- `packages/api/src/foo.ts` — the assertion moved");
    expect(rendered).not.toContain("- `src/foo.ts`");
  });

  // A legacy (pre-nax#2067) story has a workdir but no `workdirSource` stamp.
  // Its package-relative entry is passed through untouched: rendering as stored
  // never drops or rewrites an entry, so the authorisation survives.
  test("leaves a legacy story's package-relative path untouched", () => {
    const rendered = buildStorySection(
      makeStory({
        workdir: "packages/api",
        acceptanceCriteria: ["works"],
        modifiedFiles: [mod("src/x.ts", "legacy frame")],
      }),
    );
    expect(rendered).toContain("- `src/x.ts` — legacy frame");
  });

  test("renders an out-of-package entry unchanged — never dropped, never marked (Ruling F)", () => {
    const rendered = buildStorySection(
      makeStory({
        workdir: "packages/api",
        workdirSource: "stated",
        acceptanceCriteria: ["works"],
        modifiedFiles: [mod("packages/web/src/x.ts", "neighbour change")],
      }),
    );
    expect(rendered).toContain("- `packages/web/src/x.ts` — neighbour change");
    expect(rendered).not.toContain("not readable");
  });

  test("leaves a root story's entries unchanged", () => {
    const rendered = buildStorySection(
      makeStory({
        workdir: ".",
        workdirSource: "stated",
        acceptanceCriteria: ["works"],
        modifiedFiles: [mod("packages/api/src/x.ts", "root frame")],
      }),
    );
    expect(rendered).toContain("- `packages/api/src/x.ts` — root frame");
  });

  // A story's `modifiedFiles` list can carry more than one entry. Every case
  // above has exactly one, so reason/path pairing across entries was never
  // exercised — a desync would attach the wrong reason to the wrong path
  // without any of those tests noticing.
  test("keeps each reason paired with its own path across multiple entries", () => {
    const rendered = buildStorySection(
      makeStory({
        workdir: "packages/api",
        workdirSource: "stated",
        acceptanceCriteria: ["works"],
        modifiedFiles: [
          mod("packages/api/src/in-package.ts", "in-package reason"),
          mod("packages/web/src/out-of-package.ts", "out-of-package reason"),
        ],
      }),
    );
    expect(rendered).toContain("- `packages/api/src/in-package.ts` — in-package reason");
    expect(rendered).toContain("- `packages/web/src/out-of-package.ts` — out-of-package reason");
    expect(rendered).not.toContain("undefined");
  });
});
