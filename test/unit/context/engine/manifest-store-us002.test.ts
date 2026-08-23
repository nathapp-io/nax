/**
 * manifest-store — US-002 chunkScopePaths round-trip test
 *
 * Covers AC7: when a scoped manifest is written and loaded, then its
 * chunkScopePaths mapping is unchanged.
 */

import { describe, expect, test } from "bun:test";
import { _manifestStoreDeps, loadContextManifests, writeContextManifest } from "@/context/engine";
import type { ContextManifest } from "@/context/engine/types";
import { withDepsRestore } from "@test/helpers";

withDepsRestore(_manifestStoreDeps);

describe("manifest-store — US-002 chunkScopePaths round-trip", () => {
  test("AC7: writeContextManifest then loadContextManifests preserves chunkScopePaths mapping unchanged", async () => {
    const writes = new Map<string, string>();

    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeJson = async (path, data) => {
      writes.set(path, JSON.stringify(data, null, 2));
    };
    _manifestStoreDeps.listFeatureDirs = async () => ["feat-auth"];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
    _manifestStoreDeps.fileExists = async (path) => writes.has(path);
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
    _manifestStoreDeps.fileExists = async (path) => writes.has(path);
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
