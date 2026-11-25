import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryStore } from "@nathapp/nax-agent";
import {
  _compactionArchiveDeps,
  type MemoryCompactionManifestStatus,
  writeCompactionManifest,
} from "#src/memory/compaction-archive";
import { _memoryStoreDeps } from "#src/memory/store";
import { acquireSessionLock } from "#src/session-store/session-lock";
import {
  assertNaxError,
  COMPACTION_ID,
  COMPACTION_STAMP,
  compactionFailure,
  compactionManifest,
  makeCompactionHarness,
  makeFakeClock,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

const archive = { ..._compactionArchiveDeps };
const storeDeps = { ..._memoryStoreDeps };
afterEach(() => {
  Object.assign(_compactionArchiveDeps, archive);
  Object.assign(_memoryStoreDeps, storeDeps);
});
type Harness = Awaited<ReturnType<typeof makeCompactionHarness>>;
const EARLIER = ["20261122T101500Z-000001", "20261123T101500Z-000002", "20261124T101500Z-000003"];

async function seed(h: Harness, id: string, status: MemoryCompactionManifestStatus = "applied") {
  await writeCompactionManifest({
    store: h.store,
    manifest: {
      id,
      status,
      createdAt: "2026-11-22T10:15:00.000Z",
      provider: "local",
      model: "balanced",
      retired: [],
      merged: [],
      notesBefore: 10,
      fillBefore: 0.9,
    },
  });
}
async function names(h: Harness) {
  return (await readdir(h.store.paths.archiveDir)).sort();
}
async function earlier(h: Harness) {
  for (const id of EARLIER) await seed(h, id);
}

describe("applyMemoryCompaction archive retention and ordering", () => {
  test("AC-13: keepArchives 2 retains exactly the two newest applied archives", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await earlier(h);
      await h.apply();
      expect(await names(h)).toEqual([EARLIER[2], COMPACTION_ID]);
    });
  });

  test.each([
    ["AC-14", "rolled_back"],
    ["AC-15", "applying"],
  ] as const)("%s: %s archives are neither deleted nor counted", async (_ac, status) => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await earlier(h);
      const protectedId = "20261126T101500Z-000004";
      await seed(h, protectedId, status);
      await h.apply();
      expect(await names(h)).toEqual([EARLIER[2], COMPACTION_ID, protectedId]);
    });
  });

  test("AC-16: a directory without an id name is neither deleted nor counted", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await earlier(h);
      await seed(h, "zz-not-a-compaction");
      await h.apply();
      expect(await names(h)).toEqual([EARLIER[2], COMPACTION_ID, "zz-not-a-compaction"]);
    });
  });

  test("AC-17: rollback deletes no archive directory", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await earlier(h);
      const cause = new Error("enqueue failed");
      await compactionFailure(
        h.apply({
          outbox: {
            ...h.outbox,
            enqueue: async () => {
              throw cause;
            },
          },
        }),
      );
      expect(await names(h)).toEqual([...EARLIER, COMPACTION_ID]);
      expect((await compactionManifest(h)).status).toBe("rolled_back");
    });
  });

  test("AC-18: old archive deletion failure still resolves the result", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await seed(h, EARLIER[0]);
      let attempts = 0;
      _compactionArchiveDeps.rm = async () => {
        ++attempts;
        throw new Error("prune denied");
      };
      const result = await h.apply({ keepArchives: 1 });
      expect(result.id).toBe(COMPACTION_ID);
      expect(attempts).toBe(1);
      expect(await names(h)).toEqual([EARLIER[0], COMPACTION_ID]);
    });
  });

  test("AC-19: old archive deletion failure warns once", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await seed(h, EARLIER[0]);
      _compactionArchiveDeps.rm = async () => {
        throw new Error("prune denied");
      };
      await h.apply({ keepArchives: 1 });
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  test("AC-20: simultaneous applies revalidate serially on the same mirror", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const secondStore = createMemoryStore({ projectDir: h.store.paths.projectDir, logger: h.logger });
      const results = await Promise.allSettled([h.apply(), h.apply({ store: secondStore })]);
      const successes = results.filter((result) => result.status === "fulfilled");
      const failures = results.filter((result) => result.status === "rejected");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      for (const failure of failures) {
        assertNaxError(failure.reason, "second apply revalidation");
        expect(failure.reason.code).toBe("MEMORY_COMPACT_PLAN_INVALID");
        expect(failure.reason.message).toContain("retired");
      }
      expect(await names(h)).toEqual([COMPACTION_ID]);
    });
  });

  test("F1: concurrent successful applies cannot prune each other's current archives", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const pruning = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let scans = 0;
      _memoryStoreDeps.readdir = async (path, options) => {
        if (path === h.store.paths.archiveDir && ++scans === 1) {
          pruning.resolve();
          await release.promise;
        }
        return storeDeps.readdir(path, options);
      };
      const first = h.apply({
        keepArchives: 1,
        plan: { retire: [{ slug: "retired", reason: "obsolete" }], merge: [] },
      });
      await pruning.promise;
      const nextId = "20261126T101500Z-000004";
      let secondFinished = false;
      const second = h
        .apply({
          store: createMemoryStore({ projectDir: h.store.paths.projectDir, logger: h.logger }),
          keepArchives: 1,
          newId: () => nextId,
          plan: { retire: [{ slug: "unrelated", reason: "also obsolete" }], merge: [] },
        })
        .finally(() => {
          secondFinished = true;
        });
      // A bounded observation of absence, as in mirror-lock.test.ts: let the second apply
      // reach retention if it can, without deadlocking the serialized implementation.
      let overlapped: boolean;
      try {
        overlapped = await waitForCondition(() => secondFinished, 1_000).then(
          () => true,
          () => false,
        );
      } finally {
        release.resolve();
      }
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.id)).toEqual([COMPACTION_ID, nextId]);
      expect(await names(h)).toEqual([nextId]);
      expect(overlapped).toBe(false);
      expect(scans).toBe(2);
    });
  });

  test("F1: an apply waits for another process's compaction lifecycle lock", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const foreignPid = 8412;
      const lockPath = join(h.store.paths.projectDir, "compaction.lock");
      const isAlive = (pid: number) => pid === foreignPid;
      const unlock = acquireSessionLock(
        lockPath,
        {
          dir: h.store.paths.projectDir,
          pid: foreignPid,
          now: () => new Date(COMPACTION_STAMP),
          logger: h.logger,
          isAlive,
        },
        isAlive,
      );
      const clock = makeFakeClock();
      let finished = false;
      const applying = h.apply({ timers: clock, isAlive }).finally(() => {
        finished = true;
      });
      try {
        await waitForCondition(() => clock.pending() > 0 || finished, 5_000);
        expect(clock.pending()).toBeGreaterThan(0);
        expect(existsSync(h.store.paths.archiveDir)).toBe(false);
      } finally {
        await unlock();
        await clock.advance(10);
        await applying;
      }
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test("retention runs after releasing the mirror lock and always keeps the current id", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await earlier(h);
      await seed(h, "20261126T101500Z-000004");
      _compactionArchiveDeps.rm = async (path, options) => {
        const entries = await _memoryStoreDeps.readdir(h.store.paths.projectDir, { withFileTypes: true });
        expect(entries.map((entry) => entry.name)).not.toContain("sync.lock");
        await archive.rm(path, options);
      };
      await h.apply({ keepArchives: 1 });
      expect(await names(h)).toEqual([COMPACTION_ID]);
    });
  });

  test("retention preserves missing manifests", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await earlier(h);
      const unknown = "20261126T101500Z-000004";
      await mkdir(join(h.store.paths.archiveDir, unknown));
      await h.apply();
      expect(await names(h)).toEqual([EARLIER[2], COMPACTION_ID, unknown]);
    });
  });
});
