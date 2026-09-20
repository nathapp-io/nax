/**
 * US-005 — `buildScratchpadSection()` introduces the agent scratchpad.
 *
 * The section is the counterweight to the standing `.nax/` immutability rule
 * (`buildNaxArtifactsSection`): without it, an agent that reads that rule as a
 * blanket prohibition never learns the one directory it may write to exists.
 *
 * US-004 — rewrote the lifetime text. The old promise was "wiped at the start
 * of each run" — that was true at one point but it wasn't the whole story.
 * The new text covers all three transitions: (a) wiped when a run finishes
 * successfully, (b) retained after a failed run so an operator can inspect
 * what the agent was thinking, and (c) cleared at the next run's start
 * regardless of how the prior run died. A future reader should never again
 * infer the old "start-of-each-run" timeline and miss the end-of-run wipe.
 */

import { describe, expect, test } from "bun:test";
import { buildScratchpadSection } from "@/prompts/sections";

describe("buildScratchpadSection", () => {
  // AC-3: names `.nax/scratchpad/`
  test("names the scratchpad directory as .nax/scratchpad/", () => {
    expect(buildScratchpadSection()).toContain(".nax/scratchpad/");
  });

  // US-004 AC7 — the three lifetime transitions have to be stated, not implied.
  // The section is hard-wrapped prose, so the assertions flatten whitespace:
  // "cleared at\nthe next run's start" is the same sentence as
  // "cleared at the next run's start".
  const flattenedSection = () => buildScratchpadSection().replace(/\s+/g, " ").toLowerCase();

  test("US-004 AC7: states the scratchpad is wiped when a run finishes", () => {
    expect(flattenedSection()).toContain("wiped when a run finishes");
  });

  test("US-004 AC7: states a failed run's scratchpad is retained for inspection", () => {
    expect(flattenedSection()).toContain("a failed run's scratchpad is retained for inspection");
  });

  test("US-004 AC7: states the scratchpad is cleared at the next run's start", () => {
    expect(flattenedSection()).toContain("cleared at the next run's start");
  });

  // AC-3: states contents are never committed
  test("states the contents are never committed", () => {
    expect(buildScratchpadSection().toLowerCase()).toContain("never committed");
  });

  test("renders a non-empty section deterministically", () => {
    const first = buildScratchpadSection();
    expect(first.length).toBeGreaterThan(0);
    expect(buildScratchpadSection()).toBe(first);
  });
});
