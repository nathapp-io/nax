/**
 * US-005 — `buildScratchpadSection()` introduces the agent scratchpad.
 *
 * The section is the counterweight to the standing `.nax/` immutability rule
 * (`buildNaxArtifactsSection`): without it, an agent that reads that rule as a
 * blanket prohibition never learns the one directory it may write to exists.
 */

import { describe, expect, test } from "bun:test";
import { buildScratchpadSection } from "@/prompts/sections";

describe("buildScratchpadSection", () => {
  // AC-3: names `.nax/scratchpad/`
  test("names the scratchpad directory as .nax/scratchpad/", () => {
    expect(buildScratchpadSection()).toContain(".nax/scratchpad/");
  });

  // AC-3: states contents are wiped at the start of each run
  test("states the contents are wiped at the start of each run", () => {
    expect(buildScratchpadSection().toLowerCase()).toContain("wiped at the start of each run");
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
