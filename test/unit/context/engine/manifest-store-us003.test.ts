/**
 * manifest-store.ts — US-003 loadFeatureManifests tests
 *
 * Covers AC4, AC5, AC15 of US-003:
 *   - AC4: a feature directory with two story subdirectories each
 *          containing one manifest returns both manifests.
 *   - AC5: a stray non-directory entry alongside story directories does
 *          not cause loadFeatureManifests to throw.
 *   - AC15: loadFeatureManifests without a feature ID returns [].
 *
 * The first two are exercised against the real filesystem (withTempDir)
 * because AC4's and AC5's contract is "feature directory traversal" — a
 * mock-based test would not pin the discovery behaviour. AC15 is covered
 * with stubbed deps because the no-feature-id path is a short-circuit
 * returning [] before any I/O runs.
 *
 * loadFeatureManifests is the feature-wide counterpart to loadContextManifests
 * — the latter takes a storyId and walks one story dir; the former takes a
 * featureId and walks every story subdirectory under it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import { _manifestStoreDeps, contextStoryDir, loadFeatureManifests } from "@/context/engine";
import type { ContextManifest } from "@/context/engine/types";
import { byCodePoint } from "@/utils/sort";

// _manifestStoreDeps has both default real-IO entries (mkdirp, writeJson,
// fileExists, readFile, listFeatureDirs, listManifestFiles) and is mutated
// by some tests. Save/restore is necessary so cross-file contamination does
// not break unrelated test files.
withDepsRestore(_manifestStoreDeps);

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: a minimal ContextManifest with all required fields
// ─────────────────────────────────────────────────────────────────────────────

function makeManifest(stage: string, requestId: string): ContextManifest {
  return {
    requestId,
    stage,
    totalBudgetTokens: 8_000,
    usedTokens: 100,
    includedChunks: ["chunk:1"],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 12,
    buildMs: 5,
    repoRoot: "/repo",
    packageDir: "/repo",
  };
}

/** Build `<dir>/.nax/features/<featureId>/stories/<storyId>/context-manifest-<stage>.json` */
function writeManifestFile(dir: string, featureId: string, storyId: string, stage: string): string {
  const storyDir = contextStoryDir(dir, featureId, storyId);
  mkdirSync(storyDir, { recursive: true });
  const path = join(storyDir, `context-manifest-${stage}.json`);
  writeFileSync(path, JSON.stringify(makeManifest(stage, `req-${storyId}-${stage}`), null, 2));
  return path;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC4: two story subdirectories each containing one manifest
// ─────────────────────────────────────────────────────────────────────────────

describe("loadFeatureManifests — two story subdirs (AC4)", () => {
  let projectDir = "";

  beforeAll(() => {
    projectDir = makeTempDir("nax-loadfeature-ac4-");
  });

  afterAll(async () => {
    if (projectDir) cleanupTempDir(projectDir);
  });

  test("AC4: a feature dir with two story subdirs each containing one manifest returns both manifests", async () => {
    const FEATURE = "feat-auth";
    const pathA = writeManifestFile(projectDir, FEATURE, "US-001", "execution");
    const pathB = writeManifestFile(projectDir, FEATURE, "US-002", "execution");

    const loaded = await loadFeatureManifests(FEATURE, { featureDir: projectDir });

    // Order is path-sorted alphabetically: US-001 sorts before US-002.
    expect(loaded).toHaveLength(2);
    const stages = loaded.map((m) => m.stage).sort(byCodePoint);
    expect(stages).toEqual(["execution", "execution"]);
    const storyIds = loaded.map((m) => m.path).sort(byCodePoint);
    expect(storyIds).toContain(pathA);
    expect(storyIds).toContain(pathB);

    // featureId is stamped on every entry
    for (const item of loaded) {
      expect(item.featureId).toBe(FEATURE);
    }
  });

  test("AC4 (multi-stage per story): multiple manifests per story dir are all returned", async () => {
    // Two stories, each with two stages → four manifests total.
    const FEATURE = "feat-multi";
    const path1a = writeManifestFile(projectDir, FEATURE, "US-A", "execution");
    const path1b = writeManifestFile(projectDir, FEATURE, "US-A", "review-semantic");
    const path2a = writeManifestFile(projectDir, FEATURE, "US-B", "execution");
    const path2b = writeManifestFile(projectDir, FEATURE, "US-B", "review-semantic");

    const loaded = await loadFeatureManifests(FEATURE, { featureDir: projectDir });
    expect(loaded).toHaveLength(4);

    const allPaths = loaded.map((m) => m.path).sort(byCodePoint);
    expect(allPaths).toContain(path1a);
    expect(allPaths).toContain(path1b);
    expect(allPaths).toContain(path2a);
    expect(allPaths).toContain(path2b);

    // Stage diversity is preserved per story
    const stagesA = loaded
      .filter((m) => m.path.startsWith(contextStoryDir(projectDir, FEATURE, "US-A")))
      .map((m) => m.stage)
      .sort(byCodePoint);
    expect(stagesA).toEqual(["execution", "review-semantic"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: stray non-directory entry alongside story directories
// ─────────────────────────────────────────────────────────────────────────────

describe("loadFeatureManifests — stray non-directory entry (AC5)", () => {
  let projectDir = "";

  beforeAll(() => {
    projectDir = makeTempDir("nax-loadfeature-ac5-");
  });

  afterAll(async () => {
    if (projectDir) cleanupTempDir(projectDir);
  });

  test("AC5: a stray non-directory entry alongside story dirs does not cause throw", async () => {
    const FEATURE = "feat-stray";
    const storyPathA = writeManifestFile(projectDir, FEATURE, "US-001", "execution");
    const storyPathB = writeManifestFile(projectDir, FEATURE, "US-002", "execution");

    // Stray non-directory entry — a regular file in the stories dir.
    const strayPath = join(projectDir, ".nax", "features", FEATURE, "stories", "README.md");
    writeFileSync(strayPath, "# stray non-directory entry\n");

    let threw = false;
    let loaded: Awaited<ReturnType<typeof loadFeatureManifests>> = [];
    try {
      loaded = await loadFeatureManifests(FEATURE, { featureDir: projectDir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // The two story manifests still come back; the stray entry is skipped.
    expect(loaded).toHaveLength(2);
    const allPaths = loaded.map((m) => m.path).sort(byCodePoint);
    expect(allPaths).toContain(storyPathA);
    expect(allPaths).toContain(storyPathB);
    expect(allPaths).not.toContain(strayPath);
  });

  test("AC5 (stray at feature root): a stray non-directory entry at the feature dir level is also tolerated", async () => {
    // Some feature dirs may carry a stray note file at the feature root
    // (e.g. .naxignore, .DS_Store, scratch). The discovery must still
    // walk the stories/ subdirectory.
    const FEATURE = "feat-stray-feature";
    const storyPath = writeManifestFile(projectDir, FEATURE, "US-001", "execution");

    const featureDir = join(projectDir, ".nax", "features", FEATURE);
    const strayAtRoot = join(featureDir, "scratch.txt");
    writeFileSync(strayAtRoot, "transient scratch\n");

    let threw = false;
    let loaded: Awaited<ReturnType<typeof loadFeatureManifests>> = [];
    try {
      loaded = await loadFeatureManifests(FEATURE, { featureDir: projectDir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.path).toBe(storyPath);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC15: no featureId → empty list
// ─────────────────────────────────────────────────────────────────────────────

describe("loadFeatureManifests — no featureId (AC15)", () => {
  test("AC15: loadFeatureManifests without a featureId returns [] without throwing", async () => {
    let threw = false;
    let loaded: Awaited<ReturnType<typeof loadFeatureManifests>> = [];
    try {
      loaded = await loadFeatureManifests("/anywhere");
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(loaded).toEqual([]);
  });

  test("AC15 (with featureId === undefined): undefined featureId is treated as absent", async () => {
    let threw = false;
    let loaded: Awaited<ReturnType<typeof loadFeatureManifests>> = [];
    try {
      loaded = await loadFeatureManifests("/anywhere", undefined);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(loaded).toEqual([]);
  });
});
