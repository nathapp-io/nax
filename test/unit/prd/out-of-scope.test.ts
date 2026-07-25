import { describe, expect, test } from "bun:test";
import {
  MAX_OUT_OF_SCOPE_ITEMS,
  applyOutOfScopeFallback,
  extractSpecOutOfScope,
  findMissingOutOfScope,
  propagateOutOfScopeToStories,
  stripPropagatedOutOfScope,
} from "@/prd";
import { makePRD, makeStory } from "@test/helpers";

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

  test("recognises a heading wrapped in emphasis", () => {
    // `## **Out of Scope**` is the same heading; not matching it silently dropped
    // the whole section — the exact failure this module exists to prevent.
    expect(extractSpecOutOfScope("## **Out of Scope**\n\n- item\n")).toEqual(["item"]);
    expect(extractSpecOutOfScope("## `Non-Goals`\n\n- item\n")).toEqual(["item"]);
    expect(extractSpecOutOfScope("## Out of Scope:\n\n- item\n")).toEqual(["item"]);
  });

  test("recognises a setext-underlined heading", () => {
    expect(extractSpecOutOfScope("Out of Scope\n------------\n\n- a\n- b\n\nDesign\n------\n\n- in scope\n")).toEqual([
      "a",
      "b",
    ]);
  });

  test("an H1 section ends at the next heading of any depth", () => {
    // Every other section nests under an H1, so folding them in would push the
    // whole document into every story prompt.
    expect(extractSpecOutOfScope("Out of Scope\n============\n\n- a\n\n## Design\n\n- in scope\n")).toEqual(["a"]);
  });

  test("skips fenced code blocks instead of folding them into an item", () => {
    const spec = "## Out of Scope\n\n- no `foo()` support\n\n```ts\nconst x = 1;\n```\n\n## Design\n- in scope\n";
    expect(extractSpecOutOfScope(spec)).toEqual(["no `foo()` support"]);
  });

  test("reads a table as one item per data row, skipping the header", () => {
    const spec = "## Out of Scope\n\n| Deferred | Reason |\n|---|---|\n| Ink TUI | later arc |\n| Checkpoints | no data |\n";
    expect(extractSpecOutOfScope(spec)).toEqual(["Ink TUI — later arc", "Checkpoints — no data"]);
  });

  test("handles CRLF line endings", () => {
    expect(extractSpecOutOfScope("## Out of Scope\r\n\r\n- item a\r\n- item b\r\n")).toEqual(["item a", "item b"]);
  });

  test("ignores an out-of-scope section inside a fenced code block", () => {
    // A spec that documents markdown by example (spec-kit specs do) would
    // otherwise inject a fabricated hard boundary into every story prompt.
    const spec = "# Spec\n\n```markdown\n## Out of Scope\n\n- FABRICATED\n```\n\n## Requirements\n- real\n";
    expect(extractSpecOutOfScope(spec)).toEqual([]);
    expect(extractSpecOutOfScope("```md\n**Out of scope:** FABRICATED\n```\n")).toEqual([]);
  });

  test("reads a bare inline marker followed by a bullet list", () => {
    // The most common idiom; previously extracted nothing at all, so no backfill,
    // no warning, and no self-heal turn fired.
    expect(extractSpecOutOfScope("**Out of scope:**\n- No Ink TUI\n- No telemetry\n")).toEqual([
      "No Ink TUI",
      "No telemetry",
    ]);
  });

  test("keeps prose exclusions under adjacent sub-headings separate", () => {
    const spec = "## Out of Scope\n### Arc 3\nMid-phase resume\n### Arc 4\nCross-shard writes\n";
    expect(extractSpecOutOfScope(spec)).toEqual(["Mid-phase resume", "Cross-shard writes"]);
  });

  test("accepts `+` and unicode bullet markers", () => {
    expect(extractSpecOutOfScope("## Out of Scope\n\n+ No Ink TUI\n+ No telemetry\n")).toEqual([
      "No Ink TUI",
      "No telemetry",
    ]);
    expect(extractSpecOutOfScope("## Out of Scope\n\n\u2022 No Ink TUI\n\u2022 No telemetry\n")).toEqual([
      "No Ink TUI",
      "No telemetry",
    ]);
  });

  test("does not treat prose merely mentioning out of scope as a declaration", () => {
    const spec = "The diff rendering is out of scope for this story because nothing persists it.\n";
    expect(extractSpecOutOfScope(spec)).toEqual([]);
  });
});

describe("findMissingOutOfScope", () => {
  test("returns spec items absent from the PRD", () => {
    const spec = "## Out of Scope\n\n- An interactive Ink TUI\n- Per-story checkpoints\n";
    const prd = makePRD({ outOfScope: ["An interactive Ink TUI"] });

    expect(findMissingOutOfScope(spec, prd)).toEqual(["Per-story checkpoints"]);
  });

  test("returns an empty array when every item is preserved", () => {
    const spec = "## Out of Scope\n\n- An interactive Ink TUI\n";
    const prd = makePRD({ outOfScope: ["An interactive Ink TUI (deferred to a later arc)"] });

    expect(findMissingOutOfScope(spec, prd)).toEqual([]);
  });

  test("matches case-insensitively and ignores backtick/whitespace formatting", () => {
    const spec = "## Out of Scope\n\n- changes to `src/replay/report.ts`\n";
    const prd = makePRD({ outOfScope: ["Changes to    src/replay/report.ts"] });

    expect(findMissingOutOfScope(spec, prd)).toEqual([]);
  });

  test("reports every item when the PRD has no outOfScope field at all", () => {
    const spec = "## Out of Scope\n\n- a\n- b\n";
    expect(findMissingOutOfScope(spec, makePRD())).toEqual(["a", "b"]);
  });

  test("returns an empty array when the spec declares nothing", () => {
    expect(findMissingOutOfScope("# Feature\n", makePRD())).toEqual([]);
  });
});

describe("applyOutOfScopeFallback", () => {
  test("backfills the root field when the planner omitted it", () => {
    const spec = "## Out of Scope\n\n- An interactive Ink TUI\n";
    const result = applyOutOfScopeFallback(makePRD(), spec);

    expect(result.outOfScope).toEqual(["An interactive Ink TUI"]);
  });

  test("restores only the items the planner dropped, keeping its wording for the rest", () => {
    const spec = "## Out of Scope\n\n- item a\n- item b\n";
    const prd = makePRD({ outOfScope: ["item a — deferred to arc 2"] });
    const result = applyOutOfScopeFallback(prd, spec);

    // Restored items lead so the cap can never truncate them away; the planner's
    // richer wording for item a is preserved rather than duplicated.
    expect(result.outOfScope).toEqual(["item b", "item a — deferred to arc 2"]);
  });

  test("returns the same PRD reference when nothing is missing", () => {
    const spec = "## Out of Scope\n\n- item a\n";
    const prd = makePRD({ outOfScope: ["item a"] });

    expect(applyOutOfScopeFallback(prd, spec)).toBe(prd);
  });

  test("returns the same PRD reference when the spec declares nothing", () => {
    const prd = makePRD();
    expect(applyOutOfScopeFallback(prd, "# Feature\n")).toBe(prd);
  });

  test("restored spec items win the cap over the planner's own entries", () => {
    // With the planner's list first, a planner that emitted MAX entries pushed
    // every restored item off the end — the backfill no-opped while its caller
    // logged that it had fired.
    const planner = Array.from({ length: MAX_OUT_OF_SCOPE_ITEMS }, (_, i) => `planner-${i}`);
    const result = applyOutOfScopeFallback(makePRD({ outOfScope: planner }), "## Out of Scope\n\n- no Ink TUI\n");

    expect(result.outOfScope).toHaveLength(MAX_OUT_OF_SCOPE_ITEMS);
    expect(result.outOfScope?.[0]).toBe("no Ink TUI");
  });

  test("does not mutate the input PRD", () => {
    const prd = makePRD();
    applyOutOfScopeFallback(prd, "## Out of Scope\n\n- item a\n");
    expect(prd.outOfScope).toBeUndefined();
  });
});

describe("propagateOutOfScopeToStories", () => {
  test("copies the feature-level list onto every story", () => {
    const prd = makePRD({
      outOfScope: ["no Ink TUI"],
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
    });
    const result = propagateOutOfScopeToStories(prd);

    expect(result.userStories.map((s) => s.outOfScope)).toEqual([["no Ink TUI"], ["no Ink TUI"]]);
  });

  test("merges story-level items after feature-level ones without duplicating", () => {
    const prd = makePRD({
      outOfScope: ["no Ink TUI", "no checkpoints"],
      userStories: [makeStory({ outOfScope: ["no checkpoints", "no CLI wiring"] })],
    });
    const result = propagateOutOfScopeToStories(prd);

    expect(result.userStories[0].outOfScope).toEqual(["no Ink TUI", "no checkpoints", "no CLI wiring"]);
  });

  test("feature-level items outrank story-level ones when the cap truncates", () => {
    // The spec author's declared boundary must survive; planner-invented
    // story-specific entries are what gets dropped at the cap.
    const storySpecific = Array.from({ length: MAX_OUT_OF_SCOPE_ITEMS }, (_, i) => `story-item-${i}`);
    const prd = makePRD({
      outOfScope: ["FEATURE-LEVEL-CRITICAL"],
      userStories: [makeStory({ outOfScope: storySpecific })],
    });

    const merged = propagateOutOfScopeToStories(prd).userStories[0].outOfScope;

    expect(merged).toHaveLength(MAX_OUT_OF_SCOPE_ITEMS);
    expect(merged?.[0]).toBe("FEATURE-LEVEL-CRITICAL");
  });

  test("returns the same PRD reference when there is nothing to propagate", () => {
    const prd = makePRD();
    expect(propagateOutOfScopeToStories(prd)).toBe(prd);
  });

  test("does not mutate the input stories", () => {
    const prd = makePRD({ outOfScope: ["no Ink TUI"] });
    propagateOutOfScopeToStories(prd);
    expect(prd.userStories[0].outOfScope).toBeUndefined();
  });
});

describe("stripPropagatedOutOfScope", () => {
  test("round-trips with propagateOutOfScopeToStories", () => {
    const prd = makePRD({
      outOfScope: ["no Ink TUI"],
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })],
    });

    expect(stripPropagatedOutOfScope(propagateOutOfScopeToStories(prd))).toEqual(prd);
  });

  test("keeps story-specific entries and drops only the mirrored feature-level ones", () => {
    const prd = makePRD({
      outOfScope: ["no Ink TUI"],
      userStories: [makeStory({ outOfScope: ["no CLI wiring", "no Ink TUI"] })],
    });

    expect(stripPropagatedOutOfScope(prd).userStories[0].outOfScope).toEqual(["no CLI wiring"]);
  });

  test("omits the story key entirely when nothing story-specific remains", () => {
    const prd = makePRD({ outOfScope: ["no Ink TUI"], userStories: [makeStory({ outOfScope: ["no Ink TUI"] })] });

    expect("outOfScope" in stripPropagatedOutOfScope(prd).userStories[0]).toBe(false);
  });

  test("returns the same PRD reference when there is nothing to strip", () => {
    const prd = makePRD({ outOfScope: ["no Ink TUI"] });
    expect(stripPropagatedOutOfScope(prd)).toBe(prd);
    const noFeatureLevel = makePRD({ userStories: [makeStory({ outOfScope: ["no CLI wiring"] })] });
    expect(stripPropagatedOutOfScope(noFeatureLevel)).toBe(noFeatureLevel);
  });
});
