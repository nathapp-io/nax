/**
 * Tests for feature-resolver.ts
 *
 * Uses _resolverDeps injection pattern — no mock.module().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearFeatureResolverCache, resolveFeatureId, _resolverDeps } from "../../../src/context/feature-resolver";
import type { UserStory } from "../../../src/prd";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";

function makeStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(storyIds: string[]): string {
  return JSON.stringify({
    userStories: storyIds.map((id) => ({ id, title: `Story ${id}` })),
  });
}

describe("resolveFeatureId", () => {
  let tempDir: string;
  let origGlob: typeof _resolverDeps.glob;
  let origReadFile: typeof _resolverDeps.readFile;

  beforeEach(() => {
    tempDir = makeTempDir("nax-feature-resolver-");
    clearFeatureResolverCache();
    origGlob = _resolverDeps.glob;
    origReadFile = _resolverDeps.readFile;
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    _resolverDeps.glob = origGlob;
    _resolverDeps.readFile = origReadFile;
  });

  test("returns featureId when story found in one feature", async () => {
    // Set up .nax/features/my-feature/prd.json
    const featDir = join(tempDir, ".nax", "features", "my-feature");
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, "prd.json"), makePrd(["US-001", "US-002"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir);
    expect(result).toBe("my-feature");
  });

  test("returns null when story not found in any feature", async () => {
    // Set up .nax/features/other-feature/prd.json with different stories
    const featDir = join(tempDir, ".nax", "features", "other-feature");
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, "prd.json"), makePrd(["US-010", "US-011"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir);
    expect(result).toBeNull();
  });

  test("returns null when .nax/features dir does not exist", async () => {
    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir);
    expect(result).toBeNull();
  });

  test("returns first match and logs warning when story appears in multiple features", async () => {
    const feat1Dir = join(tempDir, ".nax", "features", "feature-a");
    const feat2Dir = join(tempDir, ".nax", "features", "feature-b");
    mkdirSync(feat1Dir, { recursive: true });
    mkdirSync(feat2Dir, { recursive: true });
    writeFileSync(join(feat1Dir, "prd.json"), makePrd(["US-001"]));
    writeFileSync(join(feat2Dir, "prd.json"), makePrd(["US-001"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir);
    // Should return one of the matches (first glob hit)
    expect(result).toMatch(/^feature-[ab]$/);
  });

  test("skips malformed prd.json and continues scanning", async () => {
    const feat1Dir = join(tempDir, ".nax", "features", "broken-feature");
    const feat2Dir = join(tempDir, ".nax", "features", "good-feature");
    mkdirSync(feat1Dir, { recursive: true });
    mkdirSync(feat2Dir, { recursive: true });
    writeFileSync(join(feat1Dir, "prd.json"), "{ invalid json !!!");
    writeFileSync(join(feat2Dir, "prd.json"), makePrd(["US-001"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir);
    expect(result).toBe("good-feature");
  });

  test("returns cached result on second call without re-reading files", async () => {
    const featDir = join(tempDir, ".nax", "features", "cached-feature");
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, "prd.json"), makePrd(["US-005"]));

    const story = makeStory("US-005");

    // First call — populates cache
    const result1 = await resolveFeatureId(story, tempDir);
    expect(result1).toBe("cached-feature");

    let readCount = 0;
    const originalReadFile = _resolverDeps.readFile;
    _resolverDeps.readFile = async (path: string) => {
      readCount++;
      return originalReadFile(path);
    };

    // Second call — should use cache, not call readFile
    const result2 = await resolveFeatureId(story, tempDir);
    expect(result2).toBe("cached-feature");
    expect(readCount).toBe(0);

    _resolverDeps.readFile = originalReadFile;
  });

  test("prefers activeFeature hint over first alphabetical match when story ID collides", async () => {
    // Reproduces issue #663: US-001 exists in multiple features; alphabetical first
    // match would point to the wrong feature.
    const firstDir = join(tempDir, ".nax", "features", "aaa-other-feature");
    const activeDir = join(tempDir, ".nax", "features", "zzz-active-feature");
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(firstDir, "prd.json"), makePrd(["US-001"]));
    writeFileSync(join(activeDir, "prd.json"), makePrd(["US-001"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir, "zzz-active-feature");
    expect(result).toBe("zzz-active-feature");
  });

  test("activeFeature hint skips the global index scan", async () => {
    const activeDir = join(tempDir, ".nax", "features", "active-feature");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, "prd.json"), makePrd(["US-001"]));

    let globCalls = 0;
    const originalGlob = _resolverDeps.glob;
    _resolverDeps.glob = ((pattern: string, opts: { cwd: string }) => {
      globCalls++;
      return originalGlob(pattern, opts);
    }) as typeof _resolverDeps.glob;

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir, "active-feature");
    expect(result).toBe("active-feature");
    expect(globCalls).toBe(0);

    _resolverDeps.glob = originalGlob;
  });

  test("falls back to index scan when activeFeature does not contain the story", async () => {
    const activeDir = join(tempDir, ".nax", "features", "active-feature");
    const otherDir = join(tempDir, ".nax", "features", "other-feature");
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(activeDir, "prd.json"), makePrd(["US-999"]));
    writeFileSync(join(otherDir, "prd.json"), makePrd(["US-001"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir, "active-feature");
    expect(result).toBe("other-feature");
  });

  test("falls back to index scan when activeFeature PRD does not exist", async () => {
    const otherDir = join(tempDir, ".nax", "features", "other-feature");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "prd.json"), makePrd(["US-001"]));

    const story = makeStory("US-001");
    const result = await resolveFeatureId(story, tempDir, "nonexistent-feature");
    expect(result).toBe("other-feature");
  });

  test("clearFeatureResolverCache clears all cached results", async () => {
    const featDir = join(tempDir, ".nax", "features", "some-feature");
    mkdirSync(featDir, { recursive: true });
    writeFileSync(join(featDir, "prd.json"), makePrd(["US-007"]));

    const story = makeStory("US-007");

    // Populate cache
    const result1 = await resolveFeatureId(story, tempDir);
    expect(result1).toBe("some-feature");

    // Clear cache
    clearFeatureResolverCache();

    // Remove the feature directory — if cache was cleared, it should re-scan and return null
    const { rmSync } = await import("node:fs");
    rmSync(featDir, { recursive: true });

    const result2 = await resolveFeatureId(story, tempDir);
    expect(result2).toBeNull();
  });
});
