import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createMemoryStore } from "@nathapp/nax-agent";
import {
  _compactionArchiveDeps,
  type MemoryCompactionManifestStatus,
  writeCompactionManifest,
} from "#src/memory/compaction-archive";
import { _memoryStoreDeps } from "#src/memory/store";
import {
  assertNaxError,
  COMPACTION_ID,
  compactionFailure,
  compactionManifest,
  makeCompactionHarness,
  withTempDir,
} from "#test/helpers/index";

const archive = { ..._compactionArchiveDeps };
afterEach(() => Object.assign(_compactionArchiveDeps, archive));
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
