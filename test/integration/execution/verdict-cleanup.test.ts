import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";
import { applyPostRunInspection } from "../../../src/execution/post-run";

describe("applyPostRunInspection — TDD verdict cleanup", () => {
  test("removes .nax-verifier-verdict.json even when verifier short-circuited", async () => {
    const dir = makeTempDir("post-run-cleanup-");
    const verdictPath = join(dir, ".nax-verifier-verdict.json");
    await Bun.write(verdictPath, "{}");

    const ctx = {
      workdir: dir,
      packageDir: dir,
      story: { id: "S1", title: "t" },
      config: {},
      selfVerification: undefined,
      sessionScratchDir: undefined,
      routing: { agent: "claude" },
    } as any;
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
    });

    const stillExists = await Bun.file(verdictPath).exists();
    expect(stillExists).toBe(false);
    cleanupTempDir(dir);
  });
});
