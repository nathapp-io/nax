import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseQueueFile } from "@/queue";
import { _writeChains, writeQueueCommand } from "@/utils/queue-writer";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

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
});
