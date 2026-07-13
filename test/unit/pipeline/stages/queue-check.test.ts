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
import { cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";

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
