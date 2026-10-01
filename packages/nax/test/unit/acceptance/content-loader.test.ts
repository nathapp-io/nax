import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadAcceptanceTestContent } from "@/acceptance/content-loader";

describe("loadAcceptanceTestContent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-content-loader-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("returns an empty array when called with no argument", async () => {
    expect(await loadAcceptanceTestContent()).toEqual([]);
  });

  test("returns an empty array for an empty string fallback", async () => {
    expect(await loadAcceptanceTestContent("")).toEqual([]);
  });

  test("loads content for each existing path in an array, skipping missing ones", async () => {
    const presentPath = join(tempDir, "present.test.ts");
    const missingPath = join(tempDir, "missing.test.ts");
    await Bun.write(presentPath, "describe('x', () => {});");

    const result = await loadAcceptanceTestContent([presentPath, missingPath]);

    expect(result).toEqual([{ testPath: presentPath, content: "describe('x', () => {});" }]);
  });

  test("returns an empty array when every path in the array is missing", async () => {
    const result = await loadAcceptanceTestContent([join(tempDir, "ghost.test.ts")]);
    expect(result).toEqual([]);
  });

  test("loads content from a single fallback path when it exists", async () => {
    const fallbackPath = join(tempDir, "fallback.test.ts");
    await Bun.write(fallbackPath, "content-here");

    const result = await loadAcceptanceTestContent(fallbackPath);

    expect(result).toEqual([{ testPath: fallbackPath, content: "content-here" }]);
  });

  test("returns an empty array when the single fallback path does not exist", async () => {
    const result = await loadAcceptanceTestContent(join(tempDir, "ghost-fallback.test.ts"));
    expect(result).toEqual([]);
  });
});
