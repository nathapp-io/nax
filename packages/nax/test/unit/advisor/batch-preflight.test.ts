import { describe, expect, test } from "bun:test";
import { preflightItems } from "@/advisor/batch-preflight";
import type { RawPreflightConflict } from "@/operations";

const base = {
  feature: "f",
  askedAtSha: "s",
  newId: (() => {
    let n = 0;
    return () => `Q-${++n}`;
  })(),
};

const conflict = (over: Partial<RawPreflightConflict>): RawPreflightConflict => ({
  storyIds: [],
  description: "30 days vs 14 days",
  specSection: "3.2",
  raw: { optionId: "B" },
  ...over,
});

describe("preflightItems story ids (PR3 M2)", () => {
  test("listed known ids are kept; unknown ones dropped", () => {
    const [item] = preflightItems([conflict({ storyIds: ["US-1", "US-9"] })], ["US-1", "US-2"], base);
    expect(item?.appliesTo).toEqual(["US-1"]);
    expect(item?.question.storyId).toBe("US-1");
  });

  test("no listed ids -> falls back to the AC's story when it is known", () => {
    const [item] = preflightItems(
      [conflict({ storyIds: [], acRef: { storyId: "US-2", acId: "AC-3" } })],
      ["US-1", "US-2"],
      base,
    );
    expect(item?.appliesTo).toEqual(["US-2"]);
  });

  test("no known story at all -> dropped", () => {
    expect(preflightItems([conflict({ storyIds: ["US-9"] })], ["US-1"], base)).toEqual([]);
    expect(
      preflightItems([conflict({ storyIds: [], acRef: { storyId: "US-9", acId: "AC-1" } })], ["US-1"], base),
    ).toEqual([]);
  });
});
