/**
 * Story-level exclusions must survive the feature-level cap (US-005).
 *
 * `out-of-scope.test.ts` is at the 800-line test limit, so the cap-specific
 * behaviour lives here. The claim under test: `dedupeAndCap` still truncates at
 * `MAX_OUT_OF_SCOPE_ITEMS`, but `propagateOutOfScopeToStories` applies that cap
 * to the *feature-level* list only — a story's own entries are never cut, so a
 * `loadPRD` -> `savePRD` round trip keeps every one of them.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makePRD, makeStory, withTempDir } from "@test/helpers";
import {
  loadPRD,
  MAX_OUT_OF_SCOPE_ITEMS,
  propagateOutOfScopeToStories,
  savePRD,
  stripPropagatedOutOfScope,
} from "@/prd";
import { dedupeAndCap, dedupeOutOfScope } from "@/prd/out-of-scope-extract";

/** Distinct, meaningful entries — the round-trip fixture must survive every filter. */
function featureEntries(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `feature-level boundary ${i + 1} — deferred to a later arc`);
}

/** Story-specific entries, told apart from the feature-level ones by prefix. */
function storyEntries(label: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `story-specific ${label} ${i + 1} — this story only`);
}

describe("dedupeOutOfScope", () => {
  test("AC-1: 30 distinct entries all survive — the uncapped helper never truncates", () => {
    const items = featureEntries(30);

    expect(dedupeOutOfScope(items)).toHaveLength(30);
    expect(dedupeOutOfScope(items)).toEqual(items);
  });

  test("keeps `dedupeAndCap`'s filters: first-seen wording, canonical duplicates, sentinels, lead-ins", () => {
    expect(dedupeOutOfScope(["No Ink TUI", "no  ink tui", "   ", "None.", "Deferred:", "N/A"])).toEqual(["No Ink TUI"]);
  });
});

describe("dedupeAndCap", () => {
  test("AC-2: 30 distinct entries truncate to the first 25, as today", () => {
    const items = featureEntries(30);

    expect(dedupeAndCap(items)).toEqual(items.slice(0, MAX_OUT_OF_SCOPE_ITEMS));
  });
});

describe("propagateOutOfScopeToStories — the cap covers feature-level entries only", () => {
  test("AC-3: 25 feature-level entries + 2 story-specific entries give the story 27 entries", () => {
    const feature = featureEntries(MAX_OUT_OF_SCOPE_ITEMS);
    const story = storyEntries("alpha", 2);
    const prd = makePRD({ outOfScope: feature, userStories: [makeStory({ outOfScope: story })] });

    const merged = propagateOutOfScopeToStories(prd).userStories[0].outOfScope;

    expect(merged).toHaveLength(27);
    // The 25 feature-level ones first, then the 2 story-specific ones in order.
    expect(merged).toEqual([...feature, ...story]);
  });

  test("AC-4: 1 feature-level entry + 25 story-specific entries give the story 26 entries", () => {
    const feature = featureEntries(1);
    const story = storyEntries("beta", MAX_OUT_OF_SCOPE_ITEMS);
    const prd = makePRD({ outOfScope: feature, userStories: [makeStory({ outOfScope: story })] });

    const merged = propagateOutOfScopeToStories(prd).userStories[0].outOfScope;

    expect(merged).toHaveLength(26);
    expect(merged?.[0]).toBe(feature[0]);
    expect(merged).toEqual([...feature, ...story]);
  });

  test("AC-5: 30 feature-level entries give a story with none of its own exactly the first 25", () => {
    const feature = featureEntries(30);
    const prd = makePRD({ outOfScope: feature, userStories: [makeStory()] });

    const merged = propagateOutOfScopeToStories(prd).userStories[0].outOfScope;

    expect(merged).toEqual(feature.slice(0, MAX_OUT_OF_SCOPE_ITEMS));
  });

  test("AC-6: a story entry duplicating a feature entry on canonical form appears once", () => {
    const prd = makePRD({
      outOfScope: ["No Ink TUI"],
      userStories: [makeStory({ outOfScope: ["no   ink tui"] })],
    });

    const merged = propagateOutOfScopeToStories(prd).userStories[0].outOfScope;

    expect(merged).toHaveLength(1);
    expect(merged).toEqual(["No Ink TUI"]);
  });

  test("AC-7: a story-level `None.` sentinel is dropped from the propagated list", () => {
    const prd = makePRD({
      outOfScope: ["No Ink TUI"],
      userStories: [makeStory({ outOfScope: ["None."] })],
    });

    expect(propagateOutOfScopeToStories(prd).userStories[0].outOfScope).toEqual(["No Ink TUI"]);
  });
});

describe("stripPropagatedOutOfScope — round trip beyond the cap", () => {
  test("AC-8: strip(propagate(prd)) equals prd with 25 feature-level entries and 1/2/0/5 story-specific ones", () => {
    const feature = featureEntries(MAX_OUT_OF_SCOPE_ITEMS);
    const one = storyEntries("one", 1);
    const two = storyEntries("two", 2);
    const five = storyEntries("five", 5);
    const prd = makePRD({
      outOfScope: feature,
      userStories: [
        makeStory({ id: "US-001", outOfScope: one }),
        makeStory({ id: "US-002", outOfScope: two }),
        // No story-specific entries — the key must stay absent through the round trip.
        makeStory({ id: "US-003" }),
        makeStory({ id: "US-004", outOfScope: five }),
      ],
    });

    const propagated = propagateOutOfScopeToStories(prd);

    // Every story-specific entry survives propagation, past the former cap.
    expect(propagated.userStories.map((story) => story.outOfScope?.length)).toEqual([26, 27, 25, 30]);
    expect(stripPropagatedOutOfScope(propagated)).toEqual(prd);
  });
});

describe("loadPRD / savePRD — story-level exclusions beyond the feature cap", () => {
  test("AC-9: savePRD after loadPRD writes all 5 story-specific entries back", async () => {
    await withTempDir(async (dir) => {
      const feature = featureEntries(MAX_OUT_OF_SCOPE_ITEMS);
      const storySpecific = storyEntries("kept", 5);
      const path = join(dir, "prd.json");
      const prd = makePRD({
        outOfScope: feature,
        userStories: [makeStory({ id: "US-001", outOfScope: storySpecific })],
      });
      await Bun.write(path, JSON.stringify(prd, null, 2));

      const loaded = await loadPRD(path);
      expect(loaded.userStories[0].outOfScope).toEqual([...feature, ...storySpecific]);

      await savePRD(loaded, path);
      const onDisk = JSON.parse(await Bun.file(path).text());

      expect(onDisk.userStories[0].outOfScope).toHaveLength(5);
      expect(onDisk.userStories[0].outOfScope).toEqual(storySpecific);
      // The root stays the single on-disk copy of the feature-level list.
      expect(onDisk.outOfScope).toEqual(feature);
    });
  });
});
