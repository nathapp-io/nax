/**
 * queue-check pipeline stage — RETRY / PRIORITY queue commands
 *
 * Locks in existing PAUSE/ABORT/SKIP behavior and adds coverage for the two
 * new mid-run queue commands: RETRY (reset a story to pending) and PRIORITY
 * (set a story's scheduling priority).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initLogger, resetLogger } from "@/logger";
import { queueCheckStage } from "@/pipeline";
import type { PipelineContext } from "@/pipeline";
import { makePRD, makeStory, makeTempDir } from "@test/helpers";

function makeCtx(workdir: string, overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory({ id: "US-001", status: "pending" });
  const prd = makePRD({ userStories: [story] });
  return {
    workdir,
    featureDir: workdir,
    prd,
    stories: [story],
    story,
    ...overrides,
  } as unknown as PipelineContext;
}

describe("queueCheckStage — RETRY / PRIORITY", () => {
  let workdir: string;

  beforeEach(() => {
    initLogger({ level: "silent" });
    workdir = makeTempDir("nax-queue-check-");
  });

  afterEach(() => {
    resetLogger();
  });

  test("RETRY resets a failed story to pending and continues", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed", attempts: 2 });
    const prd = makePRD({ userStories: [failedStory] });
    const ctx = makeCtx(workdir, { prd, stories: [failedStory], story: failedStory });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("pending");
    expect(ctx.prd.userStories[0].attempts).toBe(0);
  });

  test("RETRY for an unknown story ID is a no-op and continues", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-999\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("pending");
  });

  test("PRIORITY sets a story's priority and continues", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "PRIORITY US-001 7\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].priority).toBe(7);
  });

  test("RETRY and PRIORITY compose with existing SKIP handling", async () => {
    const s1 = makeStory({ id: "US-001", status: "failed" });
    const s2 = makeStory({ id: "US-002", status: "pending" });
    const prd = makePRD({ userStories: [s1, s2] });
    const ctx = makeCtx(workdir, { prd, stories: [s1, s2], story: s1 });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\nPRIORITY US-002 3\nSKIP US-002\n");

    const result = await queueCheckStage.execute(ctx);

    expect(ctx.prd.userStories[0].status).toBe("pending");
    expect(ctx.prd.userStories[1].priority).toBe(3);
    expect(ctx.prd.userStories[1].status).toBe("skipped");
    // SKIP removed US-002 from the batch, leaving only US-001 — continue, not skip.
    expect(result.action).toBe("continue");
    expect(ctx.stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("PAUSE still stops execution (existing behavior)", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "PAUSE\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("pause");
  });

  test("no queue file continues without side effects", async () => {
    const ctx = makeCtx(workdir);
    const result = await queueCheckStage.execute(ctx);
    expect(result.action).toBe("continue");
  });
});
