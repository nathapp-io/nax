import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeTestContext, makeTestStory } from "@test/helpers";
import { applyPostRunInspection } from "@/execution/post-run";

describe("applyPostRunInspection — TDD verdict cleanup", () => {
  test("removes .nax-verifier-verdict.json even when verifier short-circuited", async () => {
    const dir = makeTempDir("post-run-cleanup-");
    const verdictPath = join(dir, ".nax-verifier-verdict.json");
    await Bun.write(verdictPath, "{}");

    const ctx = makeTestContext({
      workdir: dir,
      projectDir: dir,
      story: makeTestStory({ id: "S1", title: "t" }),
    });
    const planResult = {
      success: false,
      phaseOutputs: {},
      phaseCosts: {},
      totalCostUsd: 0,
      durationMs: 0,
    };

    await applyPostRunInspection(ctx, planResult, {
      capturedResponse: "",
      capturedCostUsd: 0,
      tddMode: { isLite: false, rollbackEnabled: false },
      initialRef: null,
      untrackedBefore: null,
    });

    const stillExists = await Bun.file(verdictPath).exists();
    expect(stillExists).toBe(false);
    cleanupTempDir(dir);
  });
});
