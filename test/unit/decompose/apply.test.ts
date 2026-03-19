/**
 * Tests for applyDecomposition (ENH-008: workdir inheritance)
 */

import { describe, expect, test } from "bun:test";
import { applyDecomposition } from "../../../src/decompose/apply";
import type { PRD } from "../../../src/prd/types";
import type { DecomposeResult } from "../../../src/decompose/types";

function makePrd(overrides: Partial<PRD["userStories"][0]> = {}): PRD {
  return {
    project: "test",
    feature: "test",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      {
        id: "US-001",
        title: "Parent story",
        description: "desc",
        acceptanceCriteria: ["AC-1"],
        tags: ["feature"],
        dependencies: [],
        status: "pending",
        passes: false,
        escalations: [],
        attempts: 0,
        ...overrides,
      },
    ],
  };
}

function makeDecomposeResult(parentId: string, count = 2): DecomposeResult {
  return {
    subStories: Array.from({ length: count }, (_, i) => ({
      id: `${parentId}-${i + 1}`,
      parentStoryId: parentId,
      title: `Sub-story ${i + 1}`,
      description: `Sub desc ${i + 1}`,
      acceptanceCriteria: [`AC-${i + 1}`],
      tags: ["feature"],
      dependencies: [],
      complexity: "simple" as const,
      nonOverlapJustification: "no overlap",
    })),
  };
}

describe("applyDecomposition — workdir inheritance (ENH-008)", () => {
  test("sub-stories inherit workdir from parent when set", () => {
    const prd = makePrd({ workdir: "apps/api" });
    applyDecomposition(prd, makeDecomposeResult("US-001", 3));

    const subStories = prd.userStories.filter((s) => s.id !== "US-001");
    expect(subStories).toHaveLength(3);
    for (const sub of subStories) {
      expect(sub.workdir).toBe("apps/api");
    }
  });

  test("sub-stories have no workdir when parent has none", () => {
    const prd = makePrd(); // no workdir
    applyDecomposition(prd, makeDecomposeResult("US-001", 2));

    const subStories = prd.userStories.filter((s) => s.id !== "US-001");
    expect(subStories).toHaveLength(2);
    for (const sub of subStories) {
      expect(sub.workdir).toBeUndefined();
    }
  });

  test("works with nested package path", () => {
    const prd = makePrd({ workdir: "packages/core" });
    applyDecomposition(prd, makeDecomposeResult("US-001", 2));

    const subStories = prd.userStories.filter((s) => s.id !== "US-001");
    for (const sub of subStories) {
      expect(sub.workdir).toBe("packages/core");
    }
  });

  test("marks parent as decomposed", () => {
    const prd = makePrd({ workdir: "apps/api" });
    applyDecomposition(prd, makeDecomposeResult("US-001"));

    const parent = prd.userStories.find((s) => s.id === "US-001");
    expect(parent?.status).toBe("decomposed");
  });

  test("sub-stories inserted after parent", () => {
    const prd = makePrd({ workdir: "apps/web" });
    applyDecomposition(prd, makeDecomposeResult("US-001", 2));

    expect(prd.userStories[0].id).toBe("US-001");
    expect(prd.userStories[1].id).toBe("US-001-1");
    expect(prd.userStories[2].id).toBe("US-001-2");
  });

  test("no-op when subStories is empty", () => {
    const prd = makePrd({ workdir: "apps/api" });
    applyDecomposition(prd, { subStories: [] });

    expect(prd.userStories).toHaveLength(1);
    expect(prd.userStories[0].status).toBe("pending"); // not decomposed
  });
});
