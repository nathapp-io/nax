/**
 * Tests for withQueueFileLock — serializes read-modify-write sequences on
 * the mid-run queue file so a queued PAUSE/ABORT/SKIP command cannot be
 * lost to a concurrent writer.
 *
 * The acquisition, staleness (BUG-10 / BUG-25), and mutual-exclusion (#1731)
 * semantics live in the shared `file-lock.ts` and are pinned by
 * test/unit/utils/file-lock.test.ts. These tests pin the wrapper's own
 * contract: lock-path derivation, release-on-success, and error identity.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _fileLockDeps } from "@/utils/file-lock";
import { withQueueFileLock } from "@/utils/queue-file-lock";

let orig: typeof _fileLockDeps;

beforeEach(() => {
  orig = { ..._fileLockDeps };
});

afterEach(() => {
  Object.assign(_fileLockDeps, orig);
  mock.restore();
});

async function makeTempDir(): Promise<{ dir: string; queuePath: string }> {
  const dir = `/tmp/nax-queue-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  return { dir, queuePath: `${dir}/queue.txt` };
}

describe("withQueueFileLock", () => {
  test("locks the derived <queue>.lock file and releases it after the operation", async () => {
    const { dir, queuePath } = await makeTempDir();

    let lockSeenInside = false;
    await withQueueFileLock(queuePath, async () => {
      lockSeenInside = await Bun.file(`${queuePath}.lock`).exists();
    });

    expect(lockSeenInside).toBe(true);
    expect(await Bun.file(`${queuePath}.lock`).exists()).toBe(false);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("serializes concurrent appends so no queued command is lost", async () => {
    const { dir, queuePath } = await makeTempDir();
    await Bun.write(queuePath, "");

    const writers = Array.from({ length: 8 }, (_, i) =>
      withQueueFileLock(queuePath, async () => {
        const cur = await Bun.file(queuePath).text();
        await Bun.sleep(5);
        await Bun.write(queuePath, `${cur}${i}\n`);
      }),
    );
    await Promise.all(writers);

    const final = await Bun.file(queuePath).text();
    const lines = final
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    expect(lines).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await Bun.$`rm -rf ${dir}`.quiet();
  }, 20_000);

  test("fails closed with the [queue] identity when the holder never releases", async () => {
    const { dir, queuePath } = await makeTempDir();
    await Bun.write(`${queuePath}.lock`, "7777\n");
    // The wrapper exposes no timeoutMs; accelerate the acquire deadline via
    // the now seam — the first calls compute the real deadline, later calls
    // jump past it so the default 5s timeout resolves in milliseconds.
    let nowCalls = 0;
    Object.assign(_fileLockDeps, {
      isPidAlive: (pid: number) => pid === 7777,
      now: () => (nowCalls++ < 2 ? Date.now() : Date.now() + 60_000),
    });

    await expect(withQueueFileLock(queuePath, async () => {})).rejects.toThrow(/Timed out acquiring queue lock/);
    // The live holder's lock is untouched by our failed acquisition.
    expect((await Bun.file(`${queuePath}.lock`).text()).trim()).toBe("7777");

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
