import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { parseQueueFile } from "@/queue";
import { _writeChains, writeQueueCommand, writeRetryCommand } from "@/utils/queue-writer";

describe("writeQueueCommand", () => {
  let tempDir: string;
  let queueFile: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-queue-writer-");
    queueFile = join(tempDir, "queue.txt");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("appends each command on its own line", async () => {
    await writeQueueCommand(queueFile, { type: "PAUSE" });
    await writeQueueCommand(queueFile, { type: "SKIP", storyId: "US-001" });
    await writeQueueCommand(queueFile, { type: "ABORT" });

    const { commands } = parseQueueFile(await Bun.file(queueFile).text());
    expect(commands).toEqual([{ type: "PAUSE" }, { type: "SKIP", storyId: "US-001" }, { type: "ABORT" }]);
  });

  test("writes RETRY and PRIORITY commands", async () => {
    await writeQueueCommand(queueFile, { type: "RETRY", storyId: "US-002" });
    await writeQueueCommand(queueFile, { type: "PRIORITY", storyId: "US-003", value: 5 });

    const { commands } = parseQueueFile(await Bun.file(queueFile).text());
    expect(commands).toEqual([
      { type: "RETRY", storyId: "US-002" },
      { type: "PRIORITY", storyId: "US-003", value: 5 },
    ]);
  });

  test("serializes concurrent writes without clobbering (no read-modify-write race)", async () => {
    // Fire many writes concurrently — the per-path chain must serialize them so
    // every command lands instead of overwriting each other's read-modify-write.
    const count = 25;
    await Promise.all(
      Array.from({ length: count }, (_, i) => writeQueueCommand(queueFile, { type: "SKIP", storyId: `US-${i}` })),
    );

    const { commands } = parseQueueFile(await Bun.file(queueFile).text());
    expect(commands).toHaveLength(count);
    const ids = new Set(commands.map((c) => (c.type === "SKIP" ? c.storyId : "")));
    expect(ids.size).toBe(count);
  });

  test("evicts the chain entry once writes settle (map stays bounded)", async () => {
    expect(_writeChains.has(queueFile)).toBe(false);

    const inFlight = writeQueueCommand(queueFile, { type: "PAUSE" });
    // While a write is pending, the chain is tracked.
    expect(_writeChains.has(queueFile)).toBe(true);

    await inFlight;
    // Once settled with no newer write queued, the entry is evicted.
    expect(_writeChains.has(queueFile)).toBe(false);
  });

  test("recovers an ownership lock left by a crashed writer", async () => {
    const orphan = `${queueFile}.lock.0000000000001.2147483647.orphan`;
    await Bun.write(orphan, "");

    await writeQueueCommand(queueFile, { type: "PAUSE" });

    expect(parseQueueFile(await Bun.file(queueFile).text()).commands).toEqual([{ type: "PAUSE" }]);
    expect(await Bun.file(orphan).exists()).toBe(false);
  });

  // BUG-10: age-based eviction of a lock whose pid is still alive was removed —
  // a long-held lock from a slow writer must not be treated as abandoned just
  // because it is old. This intentionally accepts the inverse edge case (an
  // orphaned lock whose pid number happens to be reused by an unrelated live
  // process) as a rare, low-risk tradeoff; see queue-file-lock.test.ts for the
  // pid-alive-vs-dead eviction matrix.
});

describe("writeRetryCommand", () => {
  let tempDir: string;
  let queueFile: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-retry-writer-");
    queueFile = join(tempDir, "queue.txt");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("writes a RETRY command for the given story id", async () => {
    await writeRetryCommand(queueFile, "US-007");

    const { commands } = parseQueueFile(await Bun.file(queueFile).text());
    expect(commands).toEqual([{ type: "RETRY", storyId: "US-007" }]);
  });

  test("no-ops when there is no story id to retry", async () => {
    await writeRetryCommand(queueFile, undefined);
    expect(await Bun.file(queueFile).exists()).toBe(false);
  });

  test("no-ops when there is no queue file path", async () => {
    // Must not throw even though no path is available.
    await writeRetryCommand(undefined, "US-007");
    expect(await Bun.file(queueFile).exists()).toBe(false);
  });
});
