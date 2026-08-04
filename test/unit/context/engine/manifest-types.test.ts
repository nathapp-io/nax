import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeContextManifest } from "@/context/engine";
import type { ContextManifest as ContextManifestFromTypes } from "@/context/engine/types";
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
});
