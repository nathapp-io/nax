/**
 * manifest-store tests.
 *
 * Merged from three files that all pin `src/context/engine/manifest-store.ts`:
 *   - per-stage manifest path / write + discovery / rebuild-manifest append
 *   - US-002: chunkScopePaths round-trip (AC7)
 *   - US-003: loadFeatureManifests feature-wide traversal (AC4, AC5, AC15)
 *
 * The original per-ticket files were `manifest-store-us002.test.ts` and
 * `manifest-store-us003.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withDepsRestore, withTempDir } from "@test/helpers";
import {
  _manifestStoreDeps,
  contextManifestPath,
  contextStoryDir,
  loadContextManifests,
  loadFeatureManifests,
  rebuildManifestPath,
  writeContextManifest,
  writeRebuildManifest,
} from "@/context/engine/manifest-store";
import type { ContextManifest } from "@/context/engine/types";
import { byCodePoint } from "@/utils/sort";

withDepsRestore(_manifestStoreDeps);

describe("manifest-store", () => {
  test("contextManifestPath builds the per-stage manifest path", () => {
    expect(contextManifestPath("/repo", "feat-auth", "US-001", "review-semantic")).toBe(
      "/repo/.nax/features/feat-auth/stories/US-001/context-manifest-review-semantic.json",
    );
  });

  test("writeContextManifest writes JSON and loadContextManifests discovers it", async () => {
    const writes = new Map<string, string>();

    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async (path, data) => {
      writes.set(path, JSON.stringify(data, null, 2));
    };
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-review-semantic.json"];
    _manifestStoreDeps.readFile = async (path) => writes.get(path) ?? "";

    await writeContextManifest("/repo", "feat-auth", "US-001", "review-semantic", {
      requestId: "req-1",
      stage: "review-semantic",
      totalBudgetTokens: 8_000,
      usedTokens: 1_200,
      includedChunks: ["chunk:1"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 120,
      buildMs: 15,
      repoRoot: "/repo",
      packageDir: "/repo/apps/api",
      providerResults: [
        { providerId: "static-rules", status: "ok", chunkCount: 5, durationMs: 23, tokensProduced: 890 },
        { providerId: "git-history", status: "ok", chunkCount: 2, durationMs: 5, tokensProduced: 310 },
      ],
    });

    const persistedRaw = writes.get(
      "/repo/.nax/features/feat-auth/stories/US-001/context-manifest-review-semantic.json",
    );
    const persisted = JSON.parse(persistedRaw ?? "{}") as { repoRoot?: string; packageDir?: string };
    expect(persisted.repoRoot).toBe(".");
    expect(persisted.packageDir).toBe("apps/api");

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.featureId).toBe("feat-auth");
    expect(manifests[0]?.stage).toBe("review-semantic");
    expect(manifests[0]?.manifest.includedChunks).toEqual(["chunk:1"]);
    expect(manifests[0]?.manifest.providerResults).toEqual([
      { providerId: "static-rules", status: "ok", chunkCount: 5, durationMs: 23, tokensProduced: 890 },
      { providerId: "git-history", status: "ok", chunkCount: 2, durationMs: 5, tokensProduced: 310 },
    ]);
    expect(manifests[0]?.manifest.repoRoot).toBe("/repo");
    expect(manifests[0]?.manifest.packageDir).toBe("/repo/apps/api");
  });

  test("loadContextManifests preserves legacy absolute repoRoot/packageDir values", async () => {
    const writes = new Map<string, string>();
    const path = "/repo/.nax/features/feat-auth/stories/US-001/context-manifest-review-semantic.json";
    writes.set(
      path,
      `${JSON.stringify(
        {
          requestId: "req-legacy",
          stage: "review-semantic",
          totalBudgetTokens: 8_000,
          usedTokens: 1_200,
          includedChunks: [],
          excludedChunks: [],
          floorItems: [],
          digestTokens: 0,
          buildMs: 10,
          repoRoot: "/repo",
          packageDir: "/repo/packages/web",
        },
        null,
        2,
      )}\n`,
    );

    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-review-semantic.json"];
    _manifestStoreDeps.readFile = async (filePath) => writes.get(filePath) ?? "";

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.manifest.repoRoot).toBe("/repo");
    expect(manifests[0]?.manifest.packageDir).toBe("/repo/packages/web");
  });

  test("loadContextManifests resolves explicit dot-relative root paths", async () => {
    const writes = new Map<string, string>();
    const path = "/repo/.nax/features/feat-auth/stories/US-001/context-manifest-review-semantic.json";
    writes.set(
      path,
      `${JSON.stringify(
        {
          requestId: "req-dot",
          stage: "review-semantic",
          totalBudgetTokens: 8_000,
          usedTokens: 1_200,
          includedChunks: [],
          excludedChunks: [],
          floorItems: [],
          digestTokens: 0,
          buildMs: 10,
          repoRoot: ".",
          packageDir: ".",
        },
        null,
        2,
      )}\n`,
    );

    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-review-semantic.json"];
    _manifestStoreDeps.readFile = async (filePath) => writes.get(filePath) ?? "";

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.manifest.repoRoot).toBe("/repo");
    expect(manifests[0]?.manifest.packageDir).toBe("/repo");
  });

  test("loadContextManifests skips a listed manifest whose read fails, without probing fileExists", async () => {
    const presentPath = "/repo/.nax/features/feat-auth/stories/US-001/context-manifest-execution.json";
    const vanishedPath = "/repo/.nax/features/feat-auth/stories/US-001/context-manifest-review-semantic.json";
    let fileExistsCalls = 0;

    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => [
      "context-manifest-execution.json",
      "context-manifest-review-semantic.json",
    ];
    _manifestStoreDeps.fileExists = async () => {
      fileExistsCalls++;
      return true;
    };
    _manifestStoreDeps.readFile = async (filePath) => {
      if (filePath === vanishedPath) {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }
      return JSON.stringify({
        requestId: "req-1",
        stage: "execution",
        totalBudgetTokens: 8_000,
        usedTokens: 100,
        includedChunks: [],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 5,
      });
    };

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.path).toBe(presentPath);
    expect(manifests[0]?.stage).toBe("execution");
    expect(fileExistsCalls).toBe(0);
  });

  test("writeContextManifest rejects when the JSON write rejects", async () => {
    const writeError = new Error("disk full");
    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async () => {
      throw writeError;
    };

    await expect(
      writeContextManifest("/repo", "feat-auth", "US-001", "review-semantic", {
        requestId: "req-1",
        stage: "review-semantic",
        totalBudgetTokens: 8_000,
        usedTokens: 1_200,
        includedChunks: ["chunk:1"],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 120,
        buildMs: 15,
      }),
    ).rejects.toBe(writeError);
  });

  test("writeRebuildManifest appends rebuild events into rebuild-manifest.json", async () => {
    const writes = new Map<string, string>();
    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async (path, data) => {
      writes.set(path, JSON.stringify(data, null, 2));
    };
    _manifestStoreDeps.fileExists = async (path) => writes.has(path);
    _manifestStoreDeps.readFile = async (path) => writes.get(path) ?? "";

    expect(rebuildManifestPath("/repo", "feat-auth", "US-001")).toBe(
      "/repo/.nax/features/feat-auth/stories/US-001/rebuild-manifest.json",
    );

    await writeRebuildManifest("/repo", "feat-auth", "US-001", {
      requestId: "req-1",
      stage: "execution",
      priorAgentId: "claude",
      newAgentId: "codex",
      failureCategory: "availability",
      failureOutcome: "fail-quota",
      priorChunkIds: ["chunk:a"],
      newChunkIds: ["chunk:a", "failure-note:1"],
      chunkIdMap: [{ priorChunkId: "chunk:a", newChunkId: "chunk:a" }],
      createdAt: "2026-04-18T00:00:00.000Z",
    });
    await writeRebuildManifest("/repo", "feat-auth", "US-001", {
      requestId: "req-2",
      stage: "execution",
      priorAgentId: "codex",
      newAgentId: "gemini",
      failureCategory: "availability",
      failureOutcome: "fail-service-down",
      priorChunkIds: ["chunk:b"],
      newChunkIds: ["chunk:b", "failure-note:2"],
      chunkIdMap: [{ priorChunkId: "chunk:b", newChunkId: "chunk:b" }],
      createdAt: "2026-04-18T00:01:00.000Z",
    });

    const path = rebuildManifestPath("/repo", "feat-auth", "US-001");
    const parsed = JSON.parse(writes.get(path) ?? "{}") as { storyId: string; events: Array<{ requestId: string }> };
    expect(parsed.storyId).toBe("US-001");
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]?.requestId).toBe("req-1");
    expect(parsed.events[1]?.requestId).toBe("req-2");
  });

  // Real deps, no stubs — the only test here that exercises the filesystem.
  // Covers two things stubs hid: the tmp+rename write must not orphan a
  // `<path>.tmp-<uuid>` sibling, and discovery must work with no featureId
  // (listFeatureDirs globbed files only, so it returned [] for every repo).
  test("real round-trip: no temp sibling, and discovery works without a featureId", async () => {
    await withTempDir(async (dir) => {
      for (let i = 1; i <= 5; i++) {
        await writeContextManifest(dir, "feat-atomic", "US-002", "execution", {
          requestId: `req-${i}`,
          stage: "execution",
          totalBudgetTokens: 8_000,
          usedTokens: i,
          includedChunks: ["chunk:1"],
          excludedChunks: [],
          floorItems: [],
          digestTokens: 12,
          buildMs: 1,
        });
      }

      const storyDir = contextStoryDir(dir, "feat-atomic", "US-002");
      const entries: string[] = [];
      for await (const entry of new Bun.Glob("*").scan({ cwd: storyDir, absolute: false })) entries.push(entry);
      expect(entries).toEqual(["context-manifest-execution.json"]);

      const manifests = await loadContextManifests(dir, "US-002");
      expect(manifests[0]?.manifest.requestId).toBe("req-5");
    });
  });
});

describe("manifest-store — US-002 chunkScopePaths round-trip", () => {
  test("AC7: writeContextManifest then loadContextManifests preserves chunkScopePaths mapping unchanged", async () => {
    const writes = new Map<string, string>();

    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async (path, data) => {
      writes.set(path, JSON.stringify(data, null, 2));
    };
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.readFile = async (path) => writes.get(path) ?? "";

    // Glob strings contain the character sequence "*" "/" "*" "/" which is
    // JSDoc's end-of-comment delimiter. Using single-element globs avoids
    // any literal sequence that resembles the close-comment sentinel.
    const GLOB_AGENTS = "src/agents/" + "*" + "/" + "*" + ".ts";
    const GLOB_ADAPTER_1 = "src/agents/acp/" + "*" + "*";
    const GLOB_ADAPTER_2 = "src/operations/" + "*" + "*";
    const GLOB_TEST_1 = "test/" + "*" + "/" + "*" + ".test.ts";
    const GLOB_TEST_2 = "test/" + "*" + "/" + "*" + ".test.tsx";

    const scoped: Record<string, string[]> = {
      "static-rules:agents:section-a:deadbeef": [GLOB_AGENTS],
      "static-rules:adapter:section-b:abcdef01": [GLOB_ADAPTER_1, GLOB_ADAPTER_2],
      "static-rules:test-writing:section-c:12345678": [GLOB_TEST_1, GLOB_TEST_2],
    };

    const manifest: ContextManifest = {
      requestId: "req-us002-ac7",
      stage: "execution",
      totalBudgetTokens: 8_000,
      usedTokens: 230,
      includedChunks: [...Object.keys(scoped)],
      excludedChunks: [],
      floorItems: [...Object.keys(scoped)],
      digestTokens: 30,
      buildMs: 12,
      repoRoot: "/repo",
      packageDir: "/repo",
      chunkScopePaths: scoped,
    };

    await writeContextManifest("/repo", "feat-auth", "US-002", "execution", manifest);

    const loaded = await loadContextManifests("/repo", "US-002");
    expect(loaded).toHaveLength(1);
    const loadedManifest = loaded[0]?.manifest;
    expect(loadedManifest?.chunkScopePaths).toBeDefined();
    expect(loadedManifest?.chunkScopePaths).toEqual(scoped);

    // Per-chunk key/value equality: the mapping is preserved exactly.
    for (const [id, globs] of Object.entries(scoped)) {
      expect(loadedManifest?.chunkScopePaths?.[id]).toEqual(globs);
    }
  });

  test("AC7 (no scopePaths): a manifest without chunkScopePaths loads with chunkScopePaths undefined (no empty object leak)", async () => {
    const writes = new Map<string, string>();

    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async (path, data) => {
      writes.set(path, JSON.stringify(data, null, 2));
    };
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.readFile = async (path) => writes.get(path) ?? "";

    const manifest: ContextManifest = {
      requestId: "req-us002-no-scope",
      stage: "execution",
      totalBudgetTokens: 8_000,
      usedTokens: 100,
      includedChunks: ["feature-context:feat-auth:s1:cafebabe"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 30,
      buildMs: 5,
      repoRoot: "/repo",
      packageDir: "/repo",
    };

    await writeContextManifest("/repo", "feat-auth", "US-002", "execution", manifest);

    const loaded = await loadContextManifests("/repo", "US-002");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.chunkScopePaths).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: loadFeatureManifests — feature-wide traversal (AC4, AC5, AC15)
// ─────────────────────────────────────────────────────────────────────────────

/** Build `<dir>/.nax/features/<featureId>/stories/<storyId>/context-manifest-<stage>.json` */
function writeManifestFile(dir: string, featureId: string, storyId: string, stage: string): string {
  const storyDir = contextStoryDir(dir, featureId, storyId);
  mkdirSync(storyDir, { recursive: true });
  const path = join(storyDir, `context-manifest-${stage}.json`);
  writeFileSync(path, JSON.stringify(makeFeatureManifest(stage, `req-${storyId}-${stage}`), null, 2));
  return path;
}

/** A minimal ContextManifest with all required fields. */
function makeFeatureManifest(stage: string, requestId: string): ContextManifest {
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
