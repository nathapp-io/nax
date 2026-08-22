/**
 * queue-check pipeline stage — RETRY / PRIORITY queue commands
 *
 * Locks in existing PAUSE/ABORT/SKIP behavior and adds coverage for the two
 * new mid-run queue commands: RETRY (reset a story to pending) and PRIORITY
 * (set a story's scheduling priority).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { queueCheckStage } from "@/pipeline";
import type { PipelineContext } from "@/pipeline";
import { cleanupTempDir, makePRD, makeStory, makeTempDir, makeTestContext } from "@test/helpers";

function makeCtx(workdir: string, overrides: Partial<PipelineContext> = {}): PipelineContext {
  const story = makeStory({ id: "US-001", status: "pending" });
  const prd = makePRD({ userStories: [story] });
  return Object.assign(makeTestContext({ workdir, prd, stories: [story], story }), { featureDir: workdir }, overrides);
}

describe("queueCheckStage — RETRY / PRIORITY", () => {
  let workdir: string;

  beforeEach(() => {
    initLogger({ level: "silent" });
    workdir = makeTempDir("nax-queue-check-");
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
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

  test("SKIP for a story outside the current batch still marks it skipped (out-of-batch SKIP is not discarded)", async () => {
    const s1 = makeStory({ id: "US-001", status: "running" });
    const s2 = makeStory({ id: "US-007", status: "pending" });
    const prd = makePRD({ userStories: [s1, s2] });
    // Sequential mode: ctx.stories only contains the story currently running (US-001).
    const ctx = makeCtx(workdir, { prd, stories: [s1], story: s1 });

    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-007\n");

    const result = await queueCheckStage.execute(ctx);

    expect(ctx.prd.userStories[1].status).toBe("skipped");
    // Not in the current batch, so the batch itself is unaffected.
    expect(result.action).toBe("continue");
    expect(ctx.stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("SKIP for an unknown story ID is a no-op and continues", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-999\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("pending");
  });

  test("SKIP for an unknown story ID does not write the PRD", async () => {
    // markStorySkipped cannot skip a story that is not there, so persisting is
    // a write that records nothing. The real cost is the log line above it,
    // which used to announce a skip that never happened.
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-999\n");

    await queueCheckStage.execute(ctx);

    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(false);
  });

  test("SKIP for a known story still writes the PRD", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\n");

    await queueCheckStage.execute(ctx);

    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(true);
    expect(ctx.prd.userStories[0].status).toBe("skipped");
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

  test("with no featureDir, the PRD fallback path is under .nax/features/unknown (not nax/features/unknown)", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed" });
    const prd = makePRD({ userStories: [failedStory] });
    const ctx = makeCtx(workdir, { prd, stories: [failedStory], story: failedStory, featureDir: undefined });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    await queueCheckStage.execute(ctx);

    const dotPrdFile = Bun.file(join(workdir, ".nax", "features", "unknown", "prd.json"));
    const noDotPrdFile = Bun.file(join(workdir, "nax", "features", "unknown", "prd.json"));
    expect(await dotPrdFile.exists()).toBe(true);
    expect(await noDotPrdFile.exists()).toBe(false);
  });
});

describe("queueCheckStage — skipPrdPersistence (BUG-9)", () => {
  // In parallel mode every story's worktree pipeline runs on a structuredClone
  // of the PRD with skipPrdPersistence: true (CR-1 single-writer rule). A
  // cloned pipeline must never claim a command it cannot durably persist, so
  // this stage now refuses to touch the queue file at all when
  // skipPrdPersistence is set — the coordinator drains it once per parallel
  // batch boundary instead (see execution/queue-handler.ts).
  let workdir: string;

  beforeEach(() => {
    initLogger({ level: "silent" });
    workdir = makeTempDir("nax-queue-check-skip-persist-");
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("RETRY is left unclaimed and unapplied when skipPrdPersistence is true", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed", attempts: 2 });
    const prd = makePRD({ userStories: [failedStory] });
    const ctx = makeCtx(workdir, {
      prd,
      stories: [failedStory],
      story: failedStory,
      skipPrdPersistence: true,
    });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("failed");
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(true);
    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(false);
  });

  test("PRIORITY is left unclaimed and unapplied when skipPrdPersistence is true", async () => {
    const ctx = makeCtx(workdir, { skipPrdPersistence: true });
    await Bun.write(join(workdir, ".queue.txt"), "PRIORITY US-001 7\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].priority).toBeUndefined();
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(true);
    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(false);
  });

  test("SKIP is left unclaimed and unapplied when skipPrdPersistence is true", async () => {
    const ctx = makeCtx(workdir, { skipPrdPersistence: true });
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("pending");
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(true);
    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(false);
  });

  test("ABORT is left unclaimed and unapplied when skipPrdPersistence is true", async () => {
    const s1 = makeStory({ id: "US-001", status: "pending" });
    const s2 = makeStory({ id: "US-002", status: "pending" });
    const prd = makePRD({ userStories: [s1, s2] });
    const ctx = makeCtx(workdir, { prd, stories: [s1, s2], story: s1, skipPrdPersistence: true });

    await Bun.write(join(workdir, ".queue.txt"), "ABORT\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("pending");
    expect(ctx.prd.userStories[1].status).toBe("pending");
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(true);
    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(false);
  });

  test("INJECT is left unclaimed and unapplied when skipPrdPersistence is true", async () => {
    const ctx = makeCtx(workdir, { skipPrdPersistence: true });
    await Bun.write(
      join(workdir, "new-story.json"),
      JSON.stringify({
        title: "Add caching layer",
        description: "Cache expensive lookups behind a TTL.",
        acceptanceCriteria: ["Cache hits avoid the DB call"],
      }),
    );
    await Bun.write(join(workdir, ".queue.txt"), "INJECT new-story.json\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories).toHaveLength(1);
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(true);
    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(false);
  });

  test("RETRY still writes prd.json when skipPrdPersistence is not set (regression guard)", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed" });
    const prd = makePRD({ userStories: [failedStory] });
    const ctx = makeCtx(workdir, { prd, stories: [failedStory], story: failedStory });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    await queueCheckStage.execute(ctx);

    expect(await Bun.file(join(workdir, "prd.json")).exists()).toBe(true);
  });
});

describe("queueCheckStage — INJECT", () => {
  let workdir: string;

  beforeEach(() => {
    initLogger({ level: "silent" });
    workdir = makeTempDir("nax-queue-check-inject-");
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("INJECT adds a validated story to the PRD and continues", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(
      join(workdir, "new-story.json"),
      JSON.stringify({
        title: "Add caching layer",
        description: "Cache expensive lookups behind a TTL.",
        acceptanceCriteria: ["Cache hits avoid the DB call"],
      }),
    );
    await Bun.write(join(workdir, ".queue.txt"), "INJECT new-story.json\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories).toHaveLength(2);
    const injected = ctx.prd.userStories[1];
    expect(injected.title).toBe("Add caching layer");
    expect(injected.status).toBe("pending");
    // Injected story is not added to the current batch — only future iterations pick it up.
    expect(ctx.stories.map((s) => s.id)).toEqual(["US-001"]);
  });

  test("INJECT with a missing file logs and continues without crashing", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, ".queue.txt"), "INJECT does-not-exist.json\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories).toHaveLength(1);
  });

  test("INJECT with invalid story content logs and continues without crashing", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(join(workdir, "bad-story.json"), JSON.stringify({ title: "Missing fields" }));
    await Bun.write(join(workdir, ".queue.txt"), "INJECT bad-story.json\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories).toHaveLength(1);
  });

  test("INJECT rejects a duplicate id and leaves the PRD unchanged", async () => {
    const ctx = makeCtx(workdir);
    await Bun.write(
      join(workdir, "dup-story.json"),
      JSON.stringify({
        id: "US-001",
        title: "Duplicate",
        description: "Should be rejected.",
        acceptanceCriteria: ["n/a"],
      }),
    );
    await Bun.write(join(workdir, ".queue.txt"), "INJECT dup-story.json\n");

    const result = await queueCheckStage.execute(ctx);

    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories).toHaveLength(1);
  });

  test("INJECT rejects an absolute path outside the workspace and leaves the PRD unchanged", async () => {
    const ctx = makeCtx(workdir);
    const outsideDir = makeTempDir("nax-queue-check-outside-");
    try {
      const outsidePath = join(outsideDir, "outside-story.json");
      await Bun.write(
        outsidePath,
        JSON.stringify({
          title: "Escaped story",
          description: "Should never be read.",
          acceptanceCriteria: ["n/a"],
        }),
      );
      await Bun.write(join(workdir, ".queue.txt"), `INJECT ${outsidePath}\n`);

      const result = await queueCheckStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.prd.userStories).toHaveLength(1);
    } finally {
      cleanupTempDir(outsideDir);
    }
  });

  test("INJECT rejects a relative path that traverses outside the workspace via ..", async () => {
    const ctx = makeCtx(workdir);
    const outsideDir = makeTempDir("nax-queue-check-outside-");
    try {
      await Bun.write(
        join(outsideDir, "traversal-story.json"),
        JSON.stringify({
          title: "Escaped via traversal",
          description: "Should never be read.",
          acceptanceCriteria: ["n/a"],
        }),
      );
      // relative(workdir, outsideDir) yields a `..`-prefixed path that resolves
      // outside workdir once joined back onto it — the traversal shape validateFilePath must reject.
      const { relative } = await import("node:path");
      const traversalPath = join(relative(workdir, outsideDir), "traversal-story.json");
      await Bun.write(join(workdir, ".queue.txt"), `INJECT ${traversalPath}\n`);

      const result = await queueCheckStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.prd.userStories).toHaveLength(1);
    } finally {
      cleanupTempDir(outsideDir);
    }
  });

  test("INJECT rejects a symlink that resolves outside the workspace", async () => {
    const ctx = makeCtx(workdir);
    const outsideDir = makeTempDir("nax-queue-check-outside-");
    try {
      const realTarget = join(outsideDir, "symlink-target.json");
      await Bun.write(
        realTarget,
        JSON.stringify({
          title: "Escaped via symlink",
          description: "Should never be read.",
          acceptanceCriteria: ["n/a"],
        }),
      );
      const { symlinkSync } = await import("node:fs");
      const linkPath = join(workdir, "link.json");
      symlinkSync(realTarget, linkPath);
      await Bun.write(join(workdir, ".queue.txt"), "INJECT link.json\n");

      const result = await queueCheckStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.prd.userStories).toHaveLength(1);
    } finally {
      cleanupTempDir(outsideDir);
    }
  });
});

describe("queueCheckStage — PAUSE/ABORT dropped-command audit", () => {
  let workdir: string;
  let logFile: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-queue-check-dropped-");
    logFile = join(workdir, "audit.jsonl");
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(async () => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("PAUSE followed by an unprocessed RETRY logs a warn recording the dropped command", async () => {
    const story = makeStory({ id: "US-001", status: "pending" });
    const prd = makePRD({ userStories: [story] });
    const ctx = Object.assign(makeTestContext({ workdir, prd, stories: [story], story }), { featureDir: workdir });

    await Bun.write(join(workdir, ".queue.txt"), "PAUSE\nRETRY US-002\n");

    const result = await queueCheckStage.execute(ctx);
    expect(result.action).toBe("pause");

    await getLogger().flush();
    const lines = (await Bun.file(logFile).text()).trim().split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));
    const dropped = entries.find((e) => e.stage === "queue" && e.message.includes("Dropped"));

    expect(dropped).toBeDefined();
    expect(dropped.data.storyId).toBe(story.id);
    expect(dropped.data.droppedCount).toBe(1);
    // storyId must be the first key in the data object (project-conventions.md).
    expect(Object.keys(dropped.data)[0]).toBe("storyId");
  });

  test("a SKIP that empties the batch also records the commands it drops", async () => {
    // Third early-return path that clears the whole queue file: SKIP removes the
    // last story from the batch, so the stage returns "skip" before reaching the
    // trailing RETRY. Same loss as PAUSE/ABORT, so it must be audited the same way.
    const story = makeStory({ id: "US-001", status: "pending" });
    const other = makeStory({ id: "US-002", status: "failed" });
    const prd = makePRD({ userStories: [story, other] });
    const ctx = Object.assign(makeTestContext({ workdir, prd, stories: [story], story }), { featureDir: workdir });

    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\nRETRY US-002\n");

    const result = await queueCheckStage.execute(ctx);
    expect(result.action).toBe("skip");
    // The dropped RETRY really did not run — US-002 is still failed.
    expect(ctx.prd.userStories[1].status).toBe("failed");

    await getLogger().flush();
    const lines = (await Bun.file(logFile).text()).trim().split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));
    const dropped = entries.find((e) => e.stage === "queue" && e.message.includes("Dropped"));

    expect(dropped).toBeDefined();
    expect(dropped.data.storyId).toBe(story.id);
    expect(dropped.data.droppedCount).toBe(1);
    expect(dropped.data.droppedTypes).toEqual(["RETRY"]);
    expect(Object.keys(dropped.data)[0]).toBe("storyId");
  });
});

describe("queueCheckStage — skipPrdPersistence never claims the queue file (BUG-9)", () => {
  // Superseded BUG-4-follow-up behavior: this stage used to claim the queue
  // file under skipPrdPersistence, apply commands to the stale clone, and log
  // an "unpersisted" warn as the command vanished. Now it refuses to claim the
  // file at all, so no such warn is ever emitted, and the queue file survives
  // for the coordinator to drain at the batch boundary.
  let workdir: string;
  let logFile: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-queue-check-skip-persist-");
    logFile = join(workdir, "audit.jsonl");
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(async () => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  async function readWarnEntries(): Promise<Array<{ stage: string; message: string; data: Record<string, unknown> }>> {
    await getLogger().flush();
    const file = Bun.file(logFile);
    if (!(await file.exists())) return [];
    const lines = (await file.text()).trim().split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l));
  }

  test("RETRY under skipPrdPersistence logs no unpersisted-command warn and leaves the queue file intact", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed", attempts: 2 });
    const prd = makePRD({ userStories: [failedStory] });
    const ctx = makeCtx(workdir, {
      prd,
      stories: [failedStory],
      story: failedStory,
      skipPrdPersistence: true,
    });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    const result = await queueCheckStage.execute(ctx);
    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("failed");
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(true);

    const entries = await readWarnEntries();
    expect(entries.find((e) => e.message.includes("NOT persisted"))).toBeUndefined();
  });

  test("RETRY in the normal (persisting) path claims and applies the command", async () => {
    const failedStory = makeStory({ id: "US-001", status: "failed", attempts: 2 });
    const prd = makePRD({ userStories: [failedStory] });
    const ctx = makeCtx(workdir, { prd, stories: [failedStory], story: failedStory });

    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    const result = await queueCheckStage.execute(ctx);
    expect(result.action).toBe("continue");
    expect(ctx.prd.userStories[0].status).toBe("pending");
    expect(await Bun.file(join(workdir, ".queue.txt")).exists()).toBe(false);
  });
});

describe("queueCheckStage — read/process/clear is one atomic unit (BUG-11)", () => {
  let workdir: string;

  beforeEach(() => {
    initLogger({ level: "silent" });
    workdir = makeTempDir("nax-queue-check-atomic-");
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("a successful run leaves no .queue.txt.processing behind, so a second run cannot re-apply the same commands", async () => {
    const s1 = makeStory({ id: "US-001", status: "pending" });
    const prd = makePRD({ userStories: [s1] });
    const ctx = makeCtx(workdir, { prd, stories: [s1], story: s1 });

    await Bun.write(join(workdir, ".queue.txt"), "PRIORITY US-001 9\n");

    await queueCheckStage.execute(ctx);
    expect(ctx.prd.userStories[0].priority).toBe(9);
    expect(await Bun.file(join(workdir, ".queue.txt.processing")).exists()).toBe(false);

    // Simulates the run restarting and re-checking the queue — before the
    // fix, a crash between "commands applied" and "processing file cleared"
    // left .queue.txt.processing behind for the next run to re-read and
    // re-apply (e.g. re-injecting an INJECT, re-setting a PRIORITY).
    ctx.prd.userStories[0].priority = undefined;
    const second = await queueCheckStage.execute(ctx);

    expect(second.action).toBe("continue");
    expect(ctx.prd.userStories[0].priority).toBeUndefined();
  });

  test("a processor exception (e.g. savePRD failure) propagates instead of being silently swallowed", async () => {
    const s1 = makeStory({ id: "US-001", status: "pending" });
    const prd = makePRD({ userStories: [s1] });
    const ctx = makeCtx(workdir, { prd, stories: [s1], story: s1 });
    await Bun.write(join(workdir, ".queue.txt"), "RETRY US-001\n");

    // Force savePRD to fail by pointing featureDir at a location that cannot
    // be created (a file, not a directory, in its place).
    await Bun.write(join(workdir, "not-a-dir"), "blocker");
    ctx.featureDir = join(workdir, "not-a-dir", "nested");

    await expect(queueCheckStage.execute(ctx)).rejects.toThrow();

    // The processing file must still be there — the failed command was never
    // durably marked as processed, so a retry will see it again.
    expect(await Bun.file(join(workdir, ".queue.txt.processing")).exists()).toBe(true);
  });
});
