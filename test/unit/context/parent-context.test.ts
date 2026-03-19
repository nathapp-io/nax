/**
 * Unit tests for parent-context.ts (ENH-005 — Context Chaining)
 */

import { describe, expect, test } from "bun:test";
import { getParentOutputFiles } from "../../../src/context/parent-context";
import type { UserStory } from "../../../src/prd/types";

function makeStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "passed",
    passes: true,
    escalations: [],
    attempts: 1,
    ...overrides,
  };
}

describe("getParentOutputFiles", () => {
  test("returns parent outputFiles when direct dependency has them", () => {
    const us001 = makeStory("US-001", { outputFiles: ["src/foo.ts", "src/bar.ts"] });
    const us002 = makeStory("US-002", { dependencies: ["US-001"] });
    const result = getParentOutputFiles(us002, [us001, us002]);
    expect(result).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  test("returns empty array when story has no dependencies", () => {
    const us001 = makeStory("US-001", { outputFiles: ["src/foo.ts"] });
    const result = getParentOutputFiles(us001, [us001]);
    expect(result).toEqual([]);
  });

  test("returns empty array when parent has no outputFiles", () => {
    const us001 = makeStory("US-001");
    const us002 = makeStory("US-002", { dependencies: ["US-001"] });
    const result = getParentOutputFiles(us002, [us001, us002]);
    expect(result).toEqual([]);
  });

  test("filters out test files from parent output", () => {
    const us001 = makeStory("US-001", {
      outputFiles: ["src/service.ts", "src/service.test.ts", "src/util.spec.tsx"],
    });
    const us002 = makeStory("US-002", { dependencies: ["US-001"] });
    const result = getParentOutputFiles(us002, [us001, us002]);
    expect(result).toEqual(["src/service.ts"]);
  });

  test("filters out lock files from parent output", () => {
    const us001 = makeStory("US-001", {
      outputFiles: ["src/index.ts", "bun.lockb", "package-lock.json"],
    });
    const us002 = makeStory("US-002", { dependencies: ["US-001"] });
    const result = getParentOutputFiles(us002, [us001, us002]);
    expect(result).toEqual(["src/index.ts"]);
  });

  test("caps at 10 files when parent produced many", () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const us001 = makeStory("US-001", { outputFiles: manyFiles });
    const us002 = makeStory("US-002", { dependencies: ["US-001"] });
    const result = getParentOutputFiles(us002, [us001, us002]);
    expect(result).toHaveLength(10);
    expect(result).toEqual(manyFiles.slice(0, 10));
  });

  test("merges and deduplicates files from multiple parents", () => {
    const us001 = makeStory("US-001", { outputFiles: ["src/a.ts", "src/shared.ts"] });
    const us002 = makeStory("US-002", { outputFiles: ["src/b.ts", "src/shared.ts"] });
    const us003 = makeStory("US-003", { dependencies: ["US-001", "US-002"] });
    const result = getParentOutputFiles(us003, [us001, us002, us003]);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).toContain("src/shared.ts");
    // shared.ts should appear only once
    expect(result.filter((f) => f === "src/shared.ts")).toHaveLength(1);
  });

  test("does not resolve transitive dependencies (only direct parents)", () => {
    // US-001 → US-002 → US-003: US-003 should only get US-002's files, not US-001's
    const us001 = makeStory("US-001", { outputFiles: ["src/from-us001.ts"] });
    const us002 = makeStory("US-002", { dependencies: ["US-001"], outputFiles: ["src/from-us002.ts"] });
    const us003 = makeStory("US-003", { dependencies: ["US-002"] });
    const result = getParentOutputFiles(us003, [us001, us002, us003]);
    expect(result).toEqual(["src/from-us002.ts"]);
    expect(result).not.toContain("src/from-us001.ts");
  });
});
