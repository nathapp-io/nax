/**
 * `queueCheckStage` — PRD progress commits (#2533).
 *
 * Every queue command that changes a story writes `prd.json` back to disk
 * (ABORT, RETRY, PRIORITY, INJECT, SKIP). Each of those writes now commits the
 * PRD too, so a mid-run file edit by the user does not keep the status change
 * uncommitted for the rest of the run.
 *
 * This is the describe-block split of `queue-check.test.ts` (the module's file
 * passes 650 lines): the stage's command semantics live there, the seam these
 * commands write through lives here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeStory, makeTempDir, makeTestContext } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";
import type { PipelineContext } from "@/pipeline";
import { queueCheckStage } from "@/pipeline";
import { _queueCheckDeps } from "@/pipeline/stages/queue-check";
import type { PRD } from "@/prd/types";

type ProgressCall = [prd: PRD, prdPath: string, storyId: string, label: string];

let workdir: string;
const ORIG_SAVE_PRD_PROGRESS = _queueCheckDeps.savePrdProgress;

/** Capture every `savePrdProgress` the stage makes, without touching the disk or git. */
function captureProgressCalls(): ProgressCall[] {
  const calls: ProgressCall[] = [];
  _queueCheckDeps.savePrdProgress = async (prd, prdPath, storyId, label) => {
    calls.push([prd, prdPath, storyId, label]);
  };
  return calls;
}

/** Story ids and labels of each call, which is what the ACs name. */
function targets(calls: ProgressCall[]): Array<[string, string]> {
  return calls.map(([, , storyId, label]) => [storyId, label]);
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory({ id: "US-001", status: "pending" });
  const prd = makePRD({ userStories: [story] });
  return Object.assign(makeTestContext({ workdir, prd, stories: [story], story }), { featureDir: workdir }, overrides);
}

beforeEach(() => {
  initLogger({ level: "silent" });
  workdir = makeTempDir("nax-queue-check-progress-");
});

afterEach(() => {
  _queueCheckDeps.savePrdProgress = ORIG_SAVE_PRD_PROGRESS;
  resetLogger();
  cleanupTempDir(workdir);
});

describe("queueCheckStage — PRD progress commits", () => {
  test("SKIP saves PRD progress for the skipped story with label 'skipped'", async () => {
    const target = makeStory({ id: "US-007", status: "pending" });
    const ctx = makeCtx({ prd: makePRD({ userStories: [target] }), stories: [target], story: target });
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-007\n");
    const calls = captureProgressCalls();

    await queueCheckStage.execute(ctx);

    expect(targets(calls)).toEqual([["US-007", "skipped"]]);
    expect(calls[0]?.[0]).toBe(ctx.prd);
    expect(calls[0]?.[1]).toBe(join(workdir, "prd.json"));
  });

  test("ABORT saves PRD progress once for the run, with label 'aborted'", async () => {
    // `_run` is the run-scoped id: the abort marks every pending story skipped,
    // so there is no single story it belongs to.
    const s1 = makeStory({ id: "US-001", status: "pending" });
    const s2 = makeStory({ id: "US-002", status: "pending" });
    const ctx = makeCtx({ prd: makePRD({ userStories: [s1, s2] }), stories: [s1, s2], story: s1 });
    await Bun.write(join(workdir, ".queue.txt"), "ABORT\n");
    const calls = captureProgressCalls();

    await queueCheckStage.execute(ctx);

    expect(targets(calls)).toEqual([["_run", "aborted"]]);
  });

  test("RETRY saves PRD progress for the retried story with label 'retry'", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed", attempts: 2 });
    const ctx = makeCtx({ prd: makePRD({ userStories: [failedStory] }), stories: [failedStory], story: failedStory });
    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");
    const calls = captureProgressCalls();

    await queueCheckStage.execute(ctx);

    expect(targets(calls)).toEqual([["US-001", "retry"]]);
  });

  test("PRIORITY saves PRD progress for the prioritised story with label 'priority'", async () => {
    const ctx = makeCtx();
    await Bun.write(join(workdir, ".queue.txt"), "PRIORITY US-001 7\n");
    const calls = captureProgressCalls();

    await queueCheckStage.execute(ctx);

    expect(targets(calls)).toEqual([["US-001", "priority"]]);
  });

  test("INJECT saves PRD progress for the injected story with label 'inject'", async () => {
    const ctx = makeCtx();
    await Bun.write(
      join(workdir, "new-story.json"),
      JSON.stringify({
        title: "Add caching layer",
        description: "Cache expensive lookups behind a TTL.",
        acceptanceCriteria: ["Cache hits avoid the DB call"],
      }),
    );
    await Bun.write(join(workdir, ".queue.txt"), "INJECT new-story.json\n");
    const calls = captureProgressCalls();

    await queueCheckStage.execute(ctx);

    const injected = ctx.prd.userStories[1];
    expect(targets(calls)).toEqual([[injected?.id ?? "", "inject"]]);
  });

  test("a SKIP the PRD does not contain saves nothing", async () => {
    // Nothing changed on disk, so there is nothing to commit — and the stage
    // already refuses to write the PRD in that case.
    const ctx = makeCtx();
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-999\n");
    const calls = captureProgressCalls();

    await queueCheckStage.execute(ctx);

    expect(calls).toEqual([]);
  });
});
