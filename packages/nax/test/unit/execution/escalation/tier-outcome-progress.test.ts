/**
 * #2554 item 10: paused/failed tier outcomes are status transitions, so they
 * must go through savePrdProgress (write + commit, #2533) rather than a bare
 * savePRD that leaves prd.json dirty.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeEscalationContext, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { EscalationHandlerContext } from "@/execution/escalation";
import { handleMaxAttemptsReached, handleNoTierAvailable } from "@/execution/escalation";
import { _tierOutcomeDeps } from "@/execution/escalation/tier-outcome";

function makeCtx(prdPath: string): EscalationHandlerContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  return makeEscalationContext({
    story,
    prd: makePRD({ userStories: [story] }),
    prdPath,
    pipelineResult: { reason: "Rectification exhausted", context: {} },
  });
}

describe("tier outcomes commit the PRD status write (#2554)", () => {
  let tempDir: string;
  const original = _tierOutcomeDeps.savePrdProgress;
  let calls: Array<{ path: string; storyId: string; label: string; status: string | undefined }>;

  beforeEach(() => {
    tempDir = makeTempDir("nax-tier-outcome-progress-");
    calls = [];
    _tierOutcomeDeps.savePrdProgress = async (prd, path, storyId, label) => {
      calls.push({ path, storyId, label, status: prd.userStories.find((s) => s.id === storyId)?.status });
    };
  });

  afterEach(() => {
    _tierOutcomeDeps.savePrdProgress = original;
    cleanupTempDir(tempDir);
  });

  test("handleNoTierAvailable pause", async () => {
    const prdPath = join(tempDir, "prd.json");
    await handleNoTierAvailable(makeCtx(prdPath), "verifier-rejected");
    expect(calls).toEqual([{ path: prdPath, storyId: "US-001", label: "paused", status: "paused" }]);
  });

  test("handleNoTierAvailable fail", async () => {
    const prdPath = join(tempDir, "prd.json");
    await handleNoTierAvailable(makeCtx(prdPath), undefined);
    expect(calls).toEqual([{ path: prdPath, storyId: "US-001", label: "failed", status: "failed" }]);
  });

  test("handleMaxAttemptsReached pause", async () => {
    const prdPath = join(tempDir, "prd.json");
    await handleMaxAttemptsReached(makeCtx(prdPath), "runtime-crash");
    expect(calls).toEqual([{ path: prdPath, storyId: "US-001", label: "paused", status: "paused" }]);
  });

  test("handleMaxAttemptsReached fail", async () => {
    const prdPath = join(tempDir, "prd.json");
    await handleMaxAttemptsReached(makeCtx(prdPath), undefined);
    expect(calls).toEqual([{ path: prdPath, storyId: "US-001", label: "failed", status: "failed" }]);
  });
});
