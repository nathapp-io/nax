import { describe, expect, test } from "bun:test";
import {
  _manifestStoreDeps,
  contextManifestPath,
  loadContextManifests,
  rebuildManifestPath,
  writeContextManifest,
  writeRebuildManifest,
} from "../../../../src/context/engine/manifest-store";
import { withDepsRestore } from "../../../helpers/deps";

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
    _manifestStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
      return content.length;
    };
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-review-semantic.json"];
    _manifestStoreDeps.fileExists = async (path) => writes.has(path);
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
    });

    const persistedRaw = writes.get("/repo/.nax/features/feat-auth/stories/US-001/context-manifest-review-semantic.json");
    const persisted = JSON.parse(persistedRaw ?? "{}") as { repoRoot?: string; packageDir?: string };
    expect(persisted.repoRoot).toBe(".");
    expect(persisted.packageDir).toBe("apps/api");

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.featureId).toBe("feat-auth");
    expect(manifests[0]?.stage).toBe("review-semantic");
    expect(manifests[0]?.manifest.includedChunks).toEqual(["chunk:1"]);
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
    _manifestStoreDeps.fileExists = async (filePath) => writes.has(filePath);
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
    _manifestStoreDeps.fileExists = async (filePath) => writes.has(filePath);
    _manifestStoreDeps.readFile = async (filePath) => writes.get(filePath) ?? "";

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.manifest.repoRoot).toBe("/repo");
    expect(manifests[0]?.manifest.packageDir).toBe("/repo");
  });

  test("writeRebuildManifest appends rebuild events into rebuild-manifest.json", async () => {
    const writes = new Map<string, string>();
    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
      return content.length;
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
});
