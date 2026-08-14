/**
 * Fragment store — real-filesystem behaviour.
 *
 * The sibling `store.test.ts` injects an in-memory `_fragmentStoreDeps`, which
 * is why the production read path could ship broken: `fileExists` was
 * `Bun.file(path).exists()`, and `Bun.file(dir).exists()` is `false` for a
 * directory, so `listFragmentStoryIds` always returned `[]` against a real
 * disk. The feature's own acceptance test documented the defect in a comment
 * and stubbed around it rather than failing.
 *
 * These tests therefore use the REAL deps against a REAL temp directory. Do
 * not add dep injection here — that would reintroduce the blind spot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listFragmentStoryIds,
  readFragment,
  renderFragmentBody,
  truncateToFragmentBudget,
  writeFragment,
} from "@/context/fragments";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const FEATURE_ID = "feat-fragments";
let projectDir: string;

beforeEach(() => {
  projectDir = makeTempDir();
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe("fragment store — real filesystem", () => {
  test("listFragmentStoryIds returns the ids of fragments written to disk", async () => {
    await writeFragment(projectDir, FEATURE_ID, "US-001", "first", 400);
    await writeFragment(projectDir, FEATURE_ID, "US-002", "second", 400);

    expect(await listFragmentStoryIds(projectDir, FEATURE_ID)).toEqual(["US-001", "US-002"]);
  });

  test("listFragmentStoryIds returns an empty list when the feature has no fragments dir", async () => {
    expect(await listFragmentStoryIds(projectDir, "never-captured")).toEqual([]);
  });

  test("readFragment round-trips a body written to disk", async () => {
    await writeFragment(projectDir, FEATURE_ID, "US-001", "body text", 400);

    expect(await readFragment(projectDir, FEATURE_ID, "US-001")).toBe("body text");
  });
});

describe("renderFragmentBody — section order", () => {
  test("lists the touched files before the acceptance criteria", () => {
    const body = renderFragmentBody("US-001", "Add the store", ["criterion one"], ["src/a.ts"]);

    expect(body.indexOf("## Files touched")).toBeLessThan(body.indexOf("## Acceptance criteria"));
  });

  test("keeps the files section intact when truncation drops the tail", () => {
    const criteria = Array.from({ length: 40 }, (_, i) => `criterion number ${i} padded out to be long`);
    const body = renderFragmentBody("US-001", "Add the store", criteria, ["src/a.ts", "src/b.ts"]);

    const truncated = truncateToFragmentBudget(body, 100);

    expect(truncated).toContain("src/a.ts");
    expect(truncated).toContain("src/b.ts");
  });
});

describe("truncateToFragmentBudget — line boundary", () => {
  test("does not cut a body mid-line", () => {
    const body = ["line one is fairly long", "line two is also long", "line three trails"].join("\n");

    const truncated = truncateToFragmentBudget(body, 8);

    const truncatedLines = truncated.split("\n");
    const lastLine = truncatedLines[truncatedLines.length - 1] ?? "";

    expect(truncated.length).toBeGreaterThan(0);
    expect(body.split("\n")).toContain(lastLine);
  });

  test("returns a body shorter than the budget unchanged", () => {
    const body = "short body\nsecond line";

    expect(truncateToFragmentBudget(body, 400)).toBe(body);
  });
});
