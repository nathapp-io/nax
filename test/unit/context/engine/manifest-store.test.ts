import { describe, expect, test } from "bun:test";
import {
  _manifestStoreDeps,
  contextManifestPath,
  loadContextManifests,
  writeContextManifest,
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
    });

    const manifests = await loadContextManifests("/repo", "US-001");
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.featureId).toBe("feat-auth");
    expect(manifests[0]?.stage).toBe("review-semantic");
    expect(manifests[0]?.manifest.includedChunks).toEqual(["chunk:1"]);
  });
});
