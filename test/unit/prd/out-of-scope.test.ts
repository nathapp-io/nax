import { describe, expect, test } from "bun:test";
import {
  MAX_OUT_OF_SCOPE_ITEMS,
  applyOutOfScopeFallback,
  extractSpecOutOfScope,
  findMissingOutOfScope,
  propagateOutOfScopeToStories,
  stripPropagatedOutOfScope,
} from "@/prd";
import type { PRD, UserStory } from "@/prd/types";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Story",
    description: "desc",
    acceptanceCriteria: ["does a thing"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makePrd(overrides: Partial<PRD> = {}): PRD {
  return {
    project: "p",
    feature: "f",
    branchName: "feat/f",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: [makeStory()],
    ...overrides,
  };
}

describe("extractSpecOutOfScope", () => {
  test("extracts bullets from an `## Out of Scope` heading section", () => {
    const spec = [
      "# Feature",
      "",
      "## Out of Scope",
      "",
      "- An interactive Ink TUI",
      "- Per-story diffs or checkpoints",
      "",
      "## Design",
      "",
      "- This bullet is in scope",
    ].join("\n");

    expect(extractSpecOutOfScope(spec)).toEqual(["An interactive Ink TUI", "Per-story diffs or checkpoints"]);
  });

  test("stops at a sibling or higher-level heading, not at a deeper one", () => {
    const spec = [
      "## Out of Scope",
      "",
      "- top level item",
      "",
      "### Deferred arcs",
      "",
      "- nested item still out of scope",
      "",
      "## Design",
      "",
      "- in scope",
    ].join("\n");

    expect(extractSpecOutOfScope(spec)).toEqual(["top level item", "nested item still out of scope"]);
  });

  test("recognises Non-Goals and Not In Scope heading variants", () => {
    expect(extractSpecOutOfScope("### Non-Goals\n\n- no caching\n")).toEqual(["no caching"]);
    expect(extractSpecOutOfScope("## Non Goals\n\n- no caching\n")).toEqual(["no caching"]);
    expect(extractSpecOutOfScope("## Not In Scope\n\n- no caching\n")).toEqual(["no caching"]);
    expect(extractSpecOutOfScope("## Out-of-scope\n\n- no caching\n")).toEqual(["no caching"]);
  });

  test("falls back to paragraph text when the section has no bullets", () => {
    const spec = ["## Out of Scope", "", "Anything touching the billing service is deferred", "to a later arc.", ""].join(
      "\n",
    );

    expect(extractSpecOutOfScope(spec)).toEqual(["Anything touching the billing service is deferred to a later arc."]);
  });

  test("extracts inline bold lead-ins outside any heading section", () => {
    const spec = [
      "Some prose about the feature.",
      "",
      "**Out of scope (deferred):** mid-*phase* resume within a single phase",
      "and any change to the persisted log format.",
      "",
      "## Design",
    ].join("\n");

    expect(extractSpecOutOfScope(spec)).toEqual([
      "mid-*phase* resume within a single phase and any change to the persisted log format.",
    ]);
  });

  test("preserves backticked identifiers verbatim", () => {
    const spec = "## Out of Scope\n\n- changes to `src/replay/report.ts`\n";
    expect(extractSpecOutOfScope(spec)).toEqual(["changes to `src/replay/report.ts`"]);
  });

  test("deduplicates repeated items", () => {
    const spec = "## Out of Scope\n\n- no caching\n- no caching\n\n**Out of scope:** no caching\n";
    expect(extractSpecOutOfScope(spec)).toEqual(["no caching"]);
  });

  test("caps the number of extracted items", () => {
    const bullets = Array.from({ length: MAX_OUT_OF_SCOPE_ITEMS + 10 }, (_, i) => `- item ${i}`).join("\n");
    const extracted = extractSpecOutOfScope(`## Out of Scope\n\n${bullets}\n`);
    expect(extracted).toHaveLength(MAX_OUT_OF_SCOPE_ITEMS);
  });

  test("returns an empty array when the spec declares no out-of-scope section", () => {
    expect(extractSpecOutOfScope("# Feature\n\n## Design\n\n- build it\n")).toEqual([]);
    expect(extractSpecOutOfScope("")).toEqual([]);
  });

  test("does not treat prose merely mentioning out of scope as a declaration", () => {
    const spec = "The diff rendering is out of scope for this story because nothing persists it.\n";
    expect(extractSpecOutOfScope(spec)).toEqual([]);
  });
});

describe("findMissingOutOfScope", () => {
  test("returns spec items absent from the PRD", () => {
    const spec = "## Out of Scope\n\n- An interactive Ink TUI\n- Per-story checkpoints\n";
    const prd = makePrd({ outOfScope: ["An interactive Ink TUI"] });

    expect(findMissingOutOfScope(spec, prd)).toEqual(["Per-story checkpoints"]);
  });

  test("returns an empty array when every item is preserved", () => {
    const spec = "## Out of Scope\n\n- An interactive Ink TUI\n";
    const prd = makePrd({ outOfScope: ["An interactive Ink TUI (deferred to a later arc)"] });

    expect(findMissingOutOfScope(spec, prd)).toEqual([]);
  });

  test("matches case-insensitively and ignores backtick/whitespace formatting", () => {
    const spec = "## Out of Scope\n\n- changes to `src/replay/report.ts`\n";
    const prd = makePrd({ outOfScope: ["Changes to    src/replay/report.ts"] });

    expect(findMissingOutOfScope(spec, prd)).toEqual([]);
  });

  test("reports every item when the PRD has no outOfScope field at all", () => {
    const spec = "## Out of Scope\n\n- a\n- b\n";
    expect(findMissingOutOfScope(spec, makePrd())).toEqual(["a", "b"]);
  });

  test("returns an empty array when the spec declares nothing", () => {
    expect(findMissingOutOfScope("# Feature\n", makePrd())).toEqual([]);
  });
});

describe("applyOutOfScopeFallback", () => {
  test("backfills the root field when the planner omitted it", () => {
    const spec = "## Out of Scope\n\n- An interactive Ink TUI\n";
    const result = applyOutOfScopeFallback(makePrd(), spec);

    expect(result.outOfScope).toEqual(["An interactive Ink TUI"]);
  });

  test("appends only the items the planner dropped, keeping its own wording first", () => {
    const spec = "## Out of Scope\n\n- item a\n- item b\n";
    const prd = makePrd({ outOfScope: ["item a — deferred to arc 2"] });
    const result = applyOutOfScopeFallback(prd, spec);

    expect(result.outOfScope).toEqual(["item a — deferred to arc 2", "item b"]);
  });

  test("returns the same PRD reference when nothing is missing", () => {
    const spec = "## Out of Scope\n\n- item a\n";
    const prd = makePrd({ outOfScope: ["item a"] });

    expect(applyOutOfScopeFallback(prd, spec)).toBe(prd);
  });

  test("returns the same PRD reference when the spec declares nothing", () => {
    const prd = makePrd();
    expect(applyOutOfScopeFallback(prd, "# Feature\n")).toBe(prd);
  });

  test("does not mutate the input PRD", () => {
    const prd = makePrd();
    applyOutOfScopeFallback(prd, "## Out of Scope\n\n- item a\n");
    expect(prd.outOfScope).toBeUndefined();
  });
});

describe("propagateOutOfScopeToStories", () => {
  test("copies the feature-level list onto every story", () => {
    const prd = makePrd({
      outOfScope: ["no Ink TUI"],
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
    });
    const result = propagateOutOfScopeToStories(prd);

    expect(result.userStories.map((s) => s.outOfScope)).toEqual([["no Ink TUI"], ["no Ink TUI"]]);
  });

  test("merges feature-level items after story-level ones without duplicating", () => {
    const prd = makePrd({
      outOfScope: ["no Ink TUI", "no checkpoints"],
      userStories: [makeStory({ outOfScope: ["no checkpoints", "no CLI wiring"] })],
    });
    const result = propagateOutOfScopeToStories(prd);

    expect(result.userStories[0].outOfScope).toEqual(["no checkpoints", "no CLI wiring", "no Ink TUI"]);
  });

  test("returns the same PRD reference when there is nothing to propagate", () => {
    const prd = makePrd();
    expect(propagateOutOfScopeToStories(prd)).toBe(prd);
  });

  test("does not mutate the input stories", () => {
    const prd = makePrd({ outOfScope: ["no Ink TUI"] });
    propagateOutOfScopeToStories(prd);
    expect(prd.userStories[0].outOfScope).toBeUndefined();
  });
});

describe("stripPropagatedOutOfScope", () => {
  test("round-trips with propagateOutOfScopeToStories", () => {
    const prd = makePrd({
      outOfScope: ["no Ink TUI"],
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
    });

    expect(stripPropagatedOutOfScope(propagateOutOfScopeToStories(prd))).toEqual(prd);
  });

  test("keeps story-specific entries and drops only the mirrored feature-level ones", () => {
    const prd = makePrd({
      outOfScope: ["no Ink TUI"],
      userStories: [makeStory({ outOfScope: ["no CLI wiring", "no Ink TUI"] })],
    });

    expect(stripPropagatedOutOfScope(prd).userStories[0].outOfScope).toEqual(["no CLI wiring"]);
  });

  test("omits the story key entirely when nothing story-specific remains", () => {
    const prd = makePrd({ outOfScope: ["no Ink TUI"], userStories: [makeStory({ outOfScope: ["no Ink TUI"] })] });

    expect("outOfScope" in stripPropagatedOutOfScope(prd).userStories[0]).toBe(false);
  });

  test("returns the same PRD reference when there is nothing to strip", () => {
    const prd = makePrd({ outOfScope: ["no Ink TUI"] });
    expect(stripPropagatedOutOfScope(prd)).toBe(prd);
    const noFeatureLevel = makePrd({ userStories: [makeStory({ outOfScope: ["no CLI wiring"] })] });
    expect(stripPropagatedOutOfScope(noFeatureLevel)).toBe(noFeatureLevel);
  });
});
