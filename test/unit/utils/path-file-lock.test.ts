/**
 * Tests for withPathFileLock — generic path-keyed lock for serializing
 * read-modify-write sequences across processes (BUG-6).
 *
 * The acquisition, staleness (BUG-10 / BUG-25), and mutual-exclusion (#1731)
 * semantics live in the shared `file-lock.ts` and are pinned by
 * test/unit/utils/file-lock.test.ts. These tests pin the wrapper's own
 * contract: lock-path derivation, release-on-success, and error identity.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _fileLockDeps } from "@/utils/file-lock";
import { withPathFileLock } from "@/utils/path-file-lock";

let orig: typeof _fileLockDeps;

beforeEach(() => {
  orig = { ..._fileLockDeps };
});

afterEach(() => {
  Object.assign(_fileLockDeps, orig);
  mock.restore();
});

async function makeTempDir(): Promise<{ dir: string; target: string }> {
  const dir = `/tmp/nax-path-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  return { dir, target: `${dir}/metrics.json` };
}

describe("withPathFileLock", () => {
  test("locks the derived <target>.lock file and releases it after the operation", async () => {
    const { dir, target } = await makeTempDir();

    let lockSeenInside = false;
    await withPathFileLock(target, async () => {
      lockSeenInside = await Bun.file(`${target}.lock`).exists();
    });

    expect(lockSeenInside).toBe(true);
    expect(await Bun.file(`${target}.lock`).exists()).toBe(false);

    await Bun.$`rm -rf ${dir}`.quiet();
  });

  test("serializes concurrent saves so both writes survive (BUG-6)", async () => {
    const { dir, target } = await makeTempDir();
    await Bun.write(target, "[]");

    const writers = Array.from({ length: 8 }, (_, i) =>
      withPathFileLock(target, async () => {
        const cur = (await Bun.file(target).json()) as number[];
        cur.push(i);
        await Bun.sleep(5);
        await Bun.write(target, JSON.stringify(cur));
      }),
    );
    await Promise.all(writers);

    const final = (await Bun.file(target).json()) as number[];
    expect(final.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    await Bun.$`rm -rf ${dir}`.quiet();
  }, 20_000);

  test("fails closed with the [path-lock] identity when the holder never releases", async () => {
    const { dir, target } = await makeTempDir();
    await Bun.write(`${target}.lock`, "7777\n");
    Object.assign(_fileLockDeps, { isPidAlive: (pid: number) => pid === 7777 });

    await expect(withPathFileLock(target, async () => {}, { timeoutMs: 80, retryMs: 10 })).rejects.toThrow(
      /Timed out acquiring path lock/,
    );
    // The live holder's lock is untouched by our failed acquisition.
    expect((await Bun.file(`${target}.lock`).text()).trim()).toBe("7777");

    await Bun.$`rm -rf ${dir}`.quiet();
  });
});
