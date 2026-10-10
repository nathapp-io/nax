import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makePRD, makeStory } from "@test/helpers";
import type { RefinedCriterionRecord } from "@/acceptance";
import { _failedCriteriaDeps, groupStoryIdsForPackage, loadRefinedCriteria, resolveFailedCriteria } from "@/acceptance";

const records: RefinedCriterionRecord[] = [
  { acId: "AC-1", original: "o1", refined: "r1", storyId: "US-001" },
  { acId: "AC-2", original: "o2", refined: "r2", storyId: "US-002" },
  { acId: "AC-3", original: "o3", refined: "o3", storyId: "US-002" },
];

let savedReadFile: typeof _failedCriteriaDeps.readFile;
beforeEach(() => {
  savedReadFile = _failedCriteriaDeps.readFile;
});
afterEach(() => {
  _failedCriteriaDeps.readFile = savedReadFile;
});

describe("resolveFailedCriteria (US-001)", () => {
  test("US-001 AC1: maps failed package criterion number to its story and text", () => {
    expect(
      resolveFailedCriteria({ refined: records, groupStoryIds: new Set(["US-001", "US-002"]), failedACs: ["AC-2"] }),
    ).toEqual([{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }]);
  });

  test("US-001 AC2: restarts criterion numbering within the package group", () => {
    expect(
      resolveFailedCriteria({ refined: records, groupStoryIds: new Set(["US-002"]), failedACs: ["AC-1"] }),
    ).toEqual([{ acId: "AC-1", storyId: "US-002", original: "o2", refined: "r2" }]);
  });

  test("US-001 AC3: skips unknown and sentinel ids while resolving remaining ids", () => {
    const result = resolveFailedCriteria({
      refined: records,
      groupStoryIds: new Set(["US-001", "US-002"]),
      failedACs: ["AC-ERROR", "AC-9", "AC-1"],
    });
    expect({ length: result.length, firstAcId: result[0]?.acId, firstStoryId: result[0]?.storyId }).toEqual({
      length: 1,
      firstAcId: "AC-1",
      firstStoryId: "US-001",
    });
  });
});

describe("loadRefinedCriteria (US-001)", () => {
  test("US-001 AC4: returns no records when feature directory is undefined", async () => {
    expect(await loadRefinedCriteria(undefined)).toEqual([]);
  });

  test("US-001 AC5: returns no records when the file cannot be read", async () => {
    _failedCriteriaDeps.readFile = async () => {
      throw new Error("unreadable");
    };
    expect(await loadRefinedCriteria("/f")).toEqual([]);
  });

  test("US-001 AC6: returns no records when file content is not an array", async () => {
    _failedCriteriaDeps.readFile = async () => '{"not":"an array"}';
    expect(await loadRefinedCriteria("/f")).toEqual([]);
  });
});

describe("groupStoryIdsForPackage (US-001)", () => {
  test("US-001 AC7: returns only in-scope stories whose resolved workdir matches package", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002", workdir: "apps/api" })],
    });
    expect(groupStoryIdsForPackage(prd, "/repo/", "/repo/apps/api")).toEqual(new Set(["US-002"]));
  });
});
