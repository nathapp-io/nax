/**
 * Tier Escalation Outcome Handlers — pause-reason persistence (nax#1582)
 *
 * Verifies the pause path appends a structured reason to `priorErrors`
 * instead of leaving it empty (which surfaces as "no reason recorded" in
 * the resume prompt).
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "@/execution/escalation";
import type { EscalationHandlerContext } from "@/execution/escalation";
import { cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";

function makeCtx(overrides: Partial<EscalationHandlerContext> = {}, prdPath: string): EscalationHandlerContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  const prd = makePRD({ userStories: [story] });
  return {
    story,
    storiesToExecute: [story],
    isBatchExecution: false,
    routing: { modelTier: "fast", testStrategy: "test-after" },
    pipelineResult: { reason: "Rectification exhausted", context: {} },
    config: {} as EscalationHandlerContext["config"],
    prd,
    prdPath,
    featureDir: undefined,
    hooks: { hooks: {} } as EscalationHandlerContext["hooks"],
    feature: "f",
    totalCost: 0,
    workdir: "/tmp",
    ...overrides,
  } as EscalationHandlerContext;
}

describe("handleNoTierAvailable — pause-reason persistence (nax#1582)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("appends the pause reason to priorErrors instead of leaving it empty", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);

    const result = await handleNoTierAvailable(ctx, "verifier-rejected");

    expect(result.outcome).toBe("paused");
    const pausedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.priorErrors).toEqual([
      "PAUSED: Execution stopped (verifier-rejected requires human review)",
    ]);
  });
});

describe("handleMaxAttemptsReached — pause-reason persistence (nax#1582)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("appends the pause reason to priorErrors instead of leaving it empty", async () => {
    const prdPath = join(tempDir, "prd.json");
    const ctx = makeCtx({}, prdPath);

    const result = await handleMaxAttemptsReached(ctx, "runtime-crash");

    expect(result.outcome).toBe("paused");
    const pausedStory = result.prd.userStories.find((s) => s.id === "US-001");
    expect(pausedStory?.priorErrors).toEqual(["PAUSED: Max attempts reached (runtime-crash requires human review)"]);
  });
});
