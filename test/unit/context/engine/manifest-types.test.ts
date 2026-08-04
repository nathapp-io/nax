import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeContextManifest } from "../../../../src/context/engine";
import type {
  ChunkEffectiveness as ChunkEffectivenessFromTypes,
  ContextChunk as ContextChunkFromTypes,
  ContextManifest as ContextManifestFromTypes,
} from "@/context/engine/types";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let projectDir = "";

beforeAll(() => {
  projectDir = makeTempDir("nax-manifest-types-");
});

afterAll(async () => {
  if (projectDir) await cleanupTempDir(projectDir);
});

const PROJECT_DIR = () => projectDir;
const FEATURE_ID = "feat-auth";
const STORY_ID = "US-001";
const STAGE = "review-semantic";

describe("manifest-types", () => {
  test("ContextManifest/ContextChunk/ChunkEffectiveness are importable from src/context/engine/types.ts", () => {
    const compiled: unknown[] = [
      {} as ChunkEffectivenessFromTypes,
      {} as ContextChunkFromTypes,
      {} as ContextManifestFromTypes,
    ];
    expect(compiled).toHaveLength(3);
  });

  test("ContextManifest-from-types.ts is accepted by writeContextManifest (AC1)", async () => {
    const manifest: ContextManifestFromTypes = {
      requestId: "req-ac1",
      stage: STAGE,
      totalBudgetTokens: 8_000,
      usedTokens: 1_200,
      includedChunks: ["chunk:static:abc12345"],
      excludedChunks: [],
      floorItems: ["chunk:static:abc12345"],
      digestTokens: 120,
      buildMs: 15,
      repoRoot: PROJECT_DIR(),
      packageDir: PROJECT_DIR(),
      providerResults: [
        { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 890 },
      ],
    };

    await expect(
      writeContextManifest(PROJECT_DIR(), FEATURE_ID, STORY_ID, STAGE, manifest),
    ).resolves.toBeUndefined();
  });

  test("ContextChunk-from-types.ts populates ContextManifest-from-types.ts.includedChunks", () => {
    const chunk: ContextChunkFromTypes = {
      id: "chunk:static:abc12345",
      providerId: "static-rules",
      kind: "static",
      scope: "project",
      role: ["all"],
      content: "rule body",
      tokens: 100,
      score: 0.9,
    };
    const manifest: ContextManifestFromTypes = {
      requestId: "req-chunk",
      stage: STAGE,
      totalBudgetTokens: 8_000,
      usedTokens: chunk.tokens,
      includedChunks: [chunk.id],
      excludedChunks: [],
      floorItems: [chunk.id],
      digestTokens: 0,
      buildMs: 1,
    };
    expect(manifest.includedChunks).toEqual(["chunk:static:abc12345"]);
  });

  test("ChunkEffectiveness-from-types.ts is assignable to ContextManifest.chunkEffectiveness", () => {
    const effectiveness: ChunkEffectivenessFromTypes = {
      signal: "followed",
      evidence: "agent cited the rule in its diff",
    };
    const manifest: Pick<ContextManifestFromTypes, "chunkEffectiveness"> = {
      chunkEffectiveness: { "chunk:static:abc12345": effectiveness },
    };
    expect(manifest.chunkEffectiveness?.["chunk:static:abc12345"]?.signal).toBe("followed");
  });
});
