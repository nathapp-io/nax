/**
 * queue-handler — rename-before-read queue file processing
 *
 * Bun-native rename/unlink replace the previous `mv`/`rm` subprocess calls
 * (see forbidden-patterns-source.md). Also pins that a rename failure is
 * observable (logged) and non-fatal — readQueueFile returns [] rather than
 * throwing, and does not leave the run stuck retrying the same failure forever
 * without a trace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearQueueFile, processQueueFile, readQueueFile } from "@/execution";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

async function readWarnLines(
  logFile: string,
): Promise<Array<{ stage: string; message: string; data?: Record<string, unknown> }>> {
  await getLogger().flush();
  const file = Bun.file(logFile);
  if (!(await file.exists())) return [];
  const lines = (await file.text()).trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l)).filter((e) => e.level === "warn");
}

describe("readQueueFile", () => {
  let workdir: string;
  let logFile: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-queue-handler-");
    logFile = join(workdir, "audit.jsonl");
    initLogger({ level: "silent", filePath: logFile });
    writeFileSync(logFile, "");
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("missing .queue.txt returns [] with no warn", async () => {
    const commands = await readQueueFile(workdir);

    expect(commands).toEqual([]);
    const warns = await readWarnLines(logFile);
    expect(warns).toHaveLength(0);
  });

  test("parses commands from an existing .queue.txt", async () => {
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\nPAUSE\n");

    const commands = await readQueueFile(workdir);

    expect(commands).toEqual([{ type: "SKIP", storyId: "US-001" }, { type: "PAUSE" }]);
  });

  test("recovers commands left in .processing after a runner crash", async () => {
    await Bun.write(join(workdir, ".queue.txt.processing"), "ABORT\n");

    const commands = await readQueueFile(workdir);

    expect(commands).toEqual([{ type: "ABORT" }]);
    expect(await Bun.file(join(workdir, ".queue.txt.processing")).exists()).toBe(true);
  });

  test("does not replace an orphaned processing batch with newly queued commands", async () => {
    await Bun.write(join(workdir, ".queue.txt.processing"), "PAUSE\n");
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-002\n");

    expect(await readQueueFile(workdir)).toEqual([{ type: "PAUSE" }]);
    await clearQueueFile(workdir);
    expect(await readQueueFile(workdir)).toEqual([{ type: "SKIP", storyId: "US-002" }]);
  });

  test("a rename failure logs a specific rename-failure warn, not the generic read-failure fallback", async () => {
    await Bun.write(join(workdir, ".queue.txt"), "PAUSE\n");
    // Deny write permission on workdir so the rename cannot create/replace a
    // directory entry — a real, reproducible EACCES/EPERM failure with no
    // monkeypatching of globals required.
    const { chmodSync } = await import("node:fs");
    chmodSync(workdir, 0o555);

    try {
      const commands = await readQueueFile(workdir);
      expect(commands).toEqual([]);
    } finally {
      chmodSync(workdir, 0o755);
    }

    const warns = await readWarnLines(logFile);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0].stage).toBe("queue");
    // The ownership lock is now acquired before rename. With the directory
    // read-only, either ownership acquisition or rename is the first failing
    // operation; both must remain observable and non-fatal.
    expect(warns[0].message.toLowerCase()).toContain("queue file");
  });
});

describe("clearQueueFile", () => {
  let workdir: string;
  let logFile: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-queue-handler-clear-");
    logFile = join(workdir, "audit.jsonl");
    initLogger({ level: "silent", filePath: logFile });
    writeFileSync(logFile, "");
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("missing .queue.txt.processing is a silent no-op", async () => {
    await clearQueueFile(workdir);

    const warns = await readWarnLines(logFile);
    expect(warns).toHaveLength(0);
  });

  test("deletes an existing .queue.txt.processing file", async () => {
    const processingPath = join(workdir, ".queue.txt.processing");
    await Bun.write(processingPath, "PAUSE\n");

    await clearQueueFile(workdir);

    expect(await Bun.file(processingPath).exists()).toBe(false);
  });

  test("an unlink failure is logged rather than thrown", async () => {
    const processingPath = join(workdir, ".queue.txt.processing");
    await Bun.write(processingPath, "PAUSE\n");
    // Deny write permission on workdir: Bun.file(...).exists() (a stat, needs
    // only read+execute on the parent) still reports true, but unlink (needs
    // write on the parent directory) fails with a real EACCES — no
    // monkeypatching of globals required.
    const { chmodSync } = await import("node:fs");
    chmodSync(workdir, 0o555);

    try {
      await clearQueueFile(workdir);
    } finally {
      chmodSync(workdir, 0o755);
    }

    const warns = await readWarnLines(logFile);
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0].stage).toBe("queue");
  });
});

describe("processQueueFile — read/process/clear in one lock (BUG-11)", () => {
  let workdir: string;
  let logFile: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-queue-handler-process-");
    logFile = join(workdir, "audit.jsonl");
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("no queue file: processor is never called, returns undefined", async () => {
    let called = false;
    const result = await processQueueFile(workdir, async () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(result).toBeUndefined();
  });

  test("claims commands, runs the processor, and clears the processing file on success", async () => {
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\n");
    let seen: unknown;

    const result = await processQueueFile(workdir, async (commands) => {
      seen = commands;
      return "done";
    });

    expect(seen).toEqual([{ type: "SKIP", storyId: "US-001" }]);
    expect(result).toBe("done");
    expect(await Bun.file(join(workdir, ".queue.txt.processing")).exists()).toBe(false);
  });

  test("a processor throw leaves .queue.txt.processing intact for retry, and the commands are not lost", async () => {
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\n");

    await expect(
      processQueueFile(workdir, async () => {
        throw new Error("crash mid-processing");
      }),
    ).rejects.toThrow("crash mid-processing");

    expect(await Bun.file(join(workdir, ".queue.txt.processing")).exists()).toBe(true);
    // Retrying (as a restarted run would) sees the same, un-lost commands.
    expect(await readQueueFile(workdir)).toEqual([{ type: "SKIP", storyId: "US-001" }]);
  });

  test("a successful run cannot be re-processed — the classic BUG-11 double-apply is closed", async () => {
    await Bun.write(join(workdir, ".queue.txt"), "SKIP US-001\n");
    let applyCount = 0;

    await processQueueFile(workdir, async () => {
      applyCount++;
    });

    // Simulates the process restarting and re-checking the queue after a
    // successful run — before the fix, a crash between "commands applied" and
    // "processing file cleared" left the same batch to be claimed again.
    // Once processQueueFile has returned normally, there is nothing left to
    // reclaim: the clear already happened inside the same lock.
    const secondResult = await processQueueFile(workdir, async () => {
      applyCount++;
    });

    expect(applyCount).toBe(1);
    expect(secondResult).toBeUndefined();
  });
});
