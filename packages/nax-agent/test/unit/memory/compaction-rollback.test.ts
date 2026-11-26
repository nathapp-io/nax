import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _compactionArchiveDeps } from "#src/memory/compaction-archive";
import { undoMemoryCompaction } from "#src/memory/compaction-undo";
import type { MemoryStore } from "#src/memory/store";
import {
  assertNaxError,
  COMPACTION_ID,
  compactionFailure,
  compactionManifest,
  makeCompactionHarness,
  withTempDir,
} from "#test/helpers/index";

const atomic = { ..._atomicWriteDeps };
const archive = { ..._compactionArchiveDeps };
afterEach(() => {
  Object.assign(_atomicWriteDeps, atomic);
  Object.assign(_compactionArchiveDeps, archive);
});

type Harness = Awaited<ReturnType<typeof makeCompactionHarness>>;
const enqueueError = new Error("second enqueue failed");

/** The second request fails after the first save and the retire's deletion. */
async function failSecond(h: Harness, store: MemoryStore = h.store) {
  let calls = 0;
  const writes = mock(store.writeNote);
  const outbox = {
    ...h.outbox,
    enqueue: async (request: Parameters<typeof h.outbox.enqueue>[0]) => {
      if (++calls === 2) throw enqueueError;
      return h.outbox.enqueue(request);
    },
  };
  const error = await compactionFailure(h.apply({ store: { ...store, writeNote: writes }, outbox }));
  return { error, writes };
}

function expectFailed(error: Error, cause: unknown) {
  assertNaxError(error, "compaction failure");
  expect(error.code).toBe("MEMORY_COMPACT_FAILED");
  expect(error.cause).toBe(cause);
  expect(error.context?.cause).toBe(cause);
}

describe("applyMemoryCompaction rollback", () => {
  test("refuses an occupied archive id without modifying it", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await h.apply();
      const before = await compactionManifest(h);
      await expect(
        h.apply({ plan: { retire: [{ slug: "unrelated", reason: "expired" }], merge: [] } }),
      ).rejects.toThrow();
      expect(await compactionManifest(h)).toEqual(before);
    });
  });

  test("refuses an unreadable merge target", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const path = join(h.store.paths.notesDir, "merged.md");
      await writeFile(path, "unparseable");
      await expect(h.apply()).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe("unparseable");
    });
  });

  test("refuses a source edited during confirmation", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      for (const n of h.originals) if (n.slug === "retired") await h.store.writeNote({ ...n, body: "new content" });
      const request = { ...h.input, expectedCandidates: h.originals };
      await expect(h.apply(request)).rejects.toThrow();
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-1: archive write failure becomes MEMORY_COMPACT_FAILED", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const cause = new Error("archive unavailable");
      _atomicWriteDeps.stage = async (path, mode) => {
        if (path.startsWith(h.store.paths.archiveDir)) throw cause;
        return atomic.stage(path, mode);
      };
      expectFailed(await compactionFailure(h.apply()), cause);
    });
  });

  test("AC-2: archive failure changes no mirror note", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const before = await h.store.listNotes("project");
      const writeNote = mock(h.store.writeNote);
      const deleteNote = mock(h.store.deleteNote);
      _atomicWriteDeps.stage = async (path, mode) => {
        if (path.startsWith(h.store.paths.archiveDir)) throw new Error("archive unavailable");
        return atomic.stage(path, mode);
      };
      const error = await compactionFailure(h.apply({ store: { ...h.store, writeNote, deleteNote } }));
      expect(await h.store.listNotes("project")).toEqual(before);
      expect(writeNote).not.toHaveBeenCalled();
      expect(deleteNote).not.toHaveBeenCalled();
      assertNaxError(error, "archive failure translation");
      expect(error.code).toBe("MEMORY_COMPACT_FAILED");
    });
  });

  test("AC-3: second enqueue failure rewrites every archived original", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const { writes } = await failSecond(h);
      for (const original of h.originals.filter((note) => note.slug !== "unrelated")) {
        expect(writes).toHaveBeenCalledWith(original);
        expect(await h.store.readNote("project", original.slug)).toEqual(original);
      }
    });
  });

  test("AC-4: second enqueue failure deletes the new merged slug", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await failSecond(h);
      expect(await h.store.readNote("project", "merged")).toBeNull();
    });
  });

  test("AC-5: second enqueue failure removes only this apply's outbox entries", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const unrelated = await h.outbox.enqueue({
        kind: "forget",
        clientId: "unrelated-request",
        scope: "project",
        slug: "elsewhere",
        writeMode: "direct",
        reason: "unrelated",
      });
      await failSecond(h);
      expect(await h.outbox.list()).toEqual([unrelated]);
    });
  });

  test("AC-6: second enqueue failure retains its original cause", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      expectFailed((await failSecond(h)).error, enqueueError);
    });
  });

  test("AC-7: rollback records rolled_back in manifest.json", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      await failSecond(h);
      expect((await compactionManifest(h)).status).toBe("rolled_back");
    });
  });

  test.each(["complete", "partial"])(
    "AC-8: rollback cleans a %s failed log append and preserves earlier bytes",
    async (mode) => {
      await withTempDir(async (dir) => {
        const h = await makeCompactionHarness(dir);
        const earlier = '{"id":"earlier","undone":false}\n';
        await writeFile(h.store.paths.compactionsLog, earlier);
        const cause = new Error("append failed after bytes landed");
        _compactionArchiveDeps.appendFile = async (path, data) => {
          const text = String(data);
          await archive.appendFile(path, mode === "partial" ? text.slice(0, 40) : text, "utf8");
          throw cause;
        };
        const error = await compactionFailure(h.apply());
        expect(await readFile(h.store.paths.compactionsLog, "utf8")).toBe(earlier);
        expect((await compactionManifest(h)).status).toBe("rolled_back");
        expectFailed(error, cause);
      });
    },
  );

  test("failed append recovery preserves earlier non-UTF8 log bytes", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const earlier = Buffer.from([0xff, 0x0a]);
      await writeFile(h.store.paths.compactionsLog, earlier);
      _compactionArchiveDeps.appendFile = async (path, data) => {
        await archive.appendFile(path, data);
        throw new Error("append failed after publication");
      };
      await compactionFailure(h.apply());
      expect(await readFile(h.store.paths.compactionsLog)).toEqual(earlier);
    });
  });

  test("AC-9: rollback refreshes MEMORY.md with archived notes again", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      _compactionArchiveDeps.appendFile = async () => {
        throw new Error("log unavailable");
      };
      await compactionFailure(h.apply());
      const index = await readFile(h.store.paths.index, "utf8");
      for (const original of h.originals) expect(index).toContain(`${original.slug} — ${original.description}`);
      expect(index).not.toContain("merged — Combined");
    });
  });

  test("AC-10: index refresh failure after note writes rolls back", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const cause = new Error("index unavailable");
      let calls = 0;
      const writeIndex: MemoryStore["writeIndex"] = async (scope, text) => {
        if (++calls === 1) {
          expect(await h.store.readNote("project", "merged")).not.toBeNull();
          expect(await h.store.readNote("project", "retired")).toBeNull();
          throw cause;
        }
        await h.store.writeIndex(scope, text);
      };
      expectFailed(await compactionFailure(h.apply({ store: { ...h.store, writeIndex } })), cause);
      expect(await h.store.listNotes("project")).toEqual(h.originals);
      expect(await h.outbox.list()).toEqual([]);
      expect((await compactionManifest(h)).status).toBe("rolled_back");
    });
  });

  test("AC-11: rollback note write failure logs exactly one error", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const writeNote: MemoryStore["writeNote"] = async (note) => {
        if (note.source !== "nax-compact") throw new Error("restore failed");
        await h.store.writeNote(note);
      };
      await failSecond(h, { ...h.store, writeNote });
      expect(h.logger.error).toHaveBeenCalledTimes(1);
    });
  });

  test("AC-12: incomplete rollback preserves the enqueue cause and marks context", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const writeNote: MemoryStore["writeNote"] = async (note) => {
        if (note.source !== "nax-compact") throw new Error("restore failed");
        await h.store.writeNote(note);
      };
      const { error } = await failSecond(h, { ...h.store, writeNote });
      expectFailed(error, enqueueError);
      assertNaxError(error, "rollback failure");
      await undoMemoryCompaction({ ...h.input, id: COMPACTION_ID });
      expect((await h.store.listNotes("project")).map((n) => n.body)).toEqual(h.originals.map((n) => n.body));
      expect((await h.outbox.list()).map((e) => e.kind)).toEqual(["save", "save", "save", "forget"]);
      expect(error.context?.rollback).toBe("incomplete");
    });
  });

  test.each(["note write", "note delete", "applied manifest", "log append"])(
    "AC-21: %s failure rolls back with the original cause",
    async (boundary) => {
      await withTempDir(async (dir) => {
        const h = await makeCompactionHarness(dir);
        const cause = new Error(`${boundary} failed`);
        let store = h.store;
        if (boundary === "note write")
          store = {
            ...store,
            writeNote: async (note) => {
              await h.store.writeNote(note);
              if (note.source === "nax-compact") throw cause;
            },
          };
        if (boundary === "note delete")
          store = {
            ...store,
            deleteNote: async (scope, slug) => {
              await h.store.deleteNote(scope, slug);
              if (slug === "retired") throw cause;
            },
          };
        if (boundary === "applied manifest") {
          let calls = 0;
          _atomicWriteDeps.rename = async (from, to) => {
            await atomic.rename(from, to);
            if (String(to).endsWith("manifest.json") && ++calls === 2) throw cause;
          };
        }
        if (boundary === "log append")
          _compactionArchiveDeps.appendFile = async () => {
            throw cause;
          };
        expectFailed(await compactionFailure(h.apply({ store })), cause);
        expect(await h.store.listNotes("project")).toEqual(h.originals);
        expect(await h.outbox.list()).toEqual([]);
        expect((await compactionManifest(h)).status).toBe("rolled_back");
        if (existsSync(h.store.paths.compactionsLog))
          expect(await readFile(h.store.paths.compactionsLog, "utf8")).not.toContain(COMPACTION_ID);
      });
    },
  );

  test("rollback restores a merge that overwrote an archived source slug", async () => {
    await withTempDir(async (dir) => {
      const h = await makeCompactionHarness(dir);
      const into = { slug: "source-a", type: "project", description: "Combined", body: "Combined" } as const;
      const cause = new Error("log failed");
      _compactionArchiveDeps.appendFile = async () => {
        throw cause;
      };
      expectFailed(
        await compactionFailure(h.apply({ plan: { retire: [], merge: [{ from: ["source-a", "source-b"], into }] } })),
        cause,
      );
      expect(await h.store.listNotes("project")).toEqual(h.originals);
      expect(existsSync(join(h.store.paths.archiveDir, COMPACTION_ID))).toBe(true);
    });
  });
});
