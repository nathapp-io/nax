import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  createMemoryOutbox,
  MEMORY_FORGET_REASON_MAX_CHARS,
  type MemoryNote,
  type MemoryOutboxEntry,
  type MemoryWriteRequest,
} from "@nathapp/nax-agent";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _memoryStoreDeps } from "#src/memory/store";
import { assertNaxError, waitForCondition, withDepsRestore, withTempDir } from "#test/helpers/index";

const ENQUEUED_AT = "2026-11-02T08:11:00.000Z";

/** The example note from the memory-store design, with overrides. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: ENQUEUED_AT,
    status: "active",
    body: "The replay budget stays at 2,048 MiB. Next export append is due ~11-23.",
    ...overrides,
  };
}

/** What `enqueue` takes: a write request whose client id it may assign itself. */
type EnqueueRequest = Omit<MemoryWriteRequest, "clientId"> & { clientId?: string };

/** A `save` request ready to enqueue. */
function saveRequest(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    kind: "save",
    scope: "project",
    slug: "replay-budget",
    writeMode: "direct",
    note: note(),
    ...overrides,
  };
}

/** A `forget` request ready to enqueue. */
function forgetRequest(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    kind: "forget",
    scope: "project",
    slug: "replay-budget",
    writeMode: "direct",
    reason: "the budget doubled",
    ...overrides,
  };
}

/** One entry as a file holds it, with overrides: a hand-placed fixture. */
function stored(overrides: Partial<MemoryOutboxEntry> = {}): string {
  const entry: MemoryOutboxEntry = {
    kind: "save",
    clientId: "client-a",
    scope: "project",
    slug: "replay-budget",
    writeMode: "direct",
    note: note(),
    seq: 1,
    enqueuedAt: ENQUEUED_AT,
    state: "queued",
    ...overrides,
  };
  return JSON.stringify(entry);
}

/** The outbox directory of a store whose project directory is `<dir>/project`. */
function outboxDir(dir: string): string {
  return join(dir, "project", "outbox");
}

/** Drop a file into the outbox by hand, creating its directory. */
async function writeFixture(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}

/** An entry file's text, read back off the disk. */
async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** The rejection of `promise`, or `null` when it resolves. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** A set's members, ordered, so two sets compare deterministically. */
function sortedMembers(keys: ReadonlySet<string>): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** A frozen clock: every enqueue in a test stamps the same instant. */
function fixedNow(): Date {
  return new Date(ENQUEUED_AT);
}

describe("memory outbox", () => {
  withDepsRestore(_memoryStoreDeps);
  withDepsRestore(_atomicWriteDeps);

  test("AC-1: enqueue assigns a UUID client id, seq 1 and the injected now as enqueuedAt", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });

      const entry = await outbox.enqueue(saveRequest());

      expect(entry.clientId).toHaveLength(36);
      expect(entry.clientId.split("-")).toHaveLength(5);
      expect(entry.state).toBe("queued");
      expect(entry.seq).toBe(1);
      expect(entry.enqueuedAt).toBe(ENQUEUED_AT);
      expect(entry).toMatchObject({ kind: "save", scope: "project", slug: "replay-budget", writeMode: "direct" });
      expect(entry.note).toEqual(note());
      expect(entry.reason).toBeUndefined();
    });
  });

  test("AC-2: the entry lands in <dir>/00000001-<clientId>.json, creating the directory on demand", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      expect(existsSync(outDir)).toBe(false);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });

      const entry = await outbox.enqueue(saveRequest());

      const path = join(outDir, `00000001-${entry.clientId}.json`);
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(await readText(path))).toEqual(entry);
    });
  });

  test("AC-3: a second enqueue gets seq 2 even when its enqueuedAt equals the first's", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });

      const first = await outbox.enqueue(saveRequest({ slug: "first" }));
      const second = await outbox.enqueue(saveRequest({ slug: "second" }));

      expect(second.enqueuedAt).toBe(first.enqueuedAt);
      expect([first.seq, second.seq]).toEqual([1, 2]);
    });
  });

  test("AC-4: two concurrent enqueues resolve seq 1 and 2 and leave two files", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });

      const [first, second] = await Promise.all([
        outbox.enqueue(saveRequest({ slug: "first" })),
        outbox.enqueue(saveRequest({ slug: "second" })),
      ]);

      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(first.clientId).not.toBe(second.clientId);
      const files = (await readdir(outDir)).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(2);
      expect(files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
        `00000001-${first.clientId}.json`,
        `00000002-${second.clientId}.json`,
      ]);
    });
  });

  test("AC-5: a supplied client id is kept, and a traversal id is MEMORY_CLIENT_ID_INVALID with nothing written", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });

      const kept = await outbox.enqueue(saveRequest({ clientId: "my-client_1" }));
      const error = await caught(outbox.enqueue(saveRequest({ clientId: "../x" })));

      expect(kept.clientId).toBe("my-client_1");
      expect(kept.seq).toBe(1);
      assertNaxError(error, "enqueue with a traversal client id");
      expect(error).toMatchObject({ code: "MEMORY_CLIENT_ID_INVALID", context: { stage: "memory" } });
      expect(await readdir(outDir)).toEqual(["00000001-my-client_1.json"]);
    });
  });

  test("AC-6: list orders by seq ascending, then clientId ascending", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      await writeFixture(join(outDir, "00000002-bbb.json"), stored({ seq: 2, clientId: "bbb", slug: "second" }));
      await writeFixture(join(outDir, "00000002-aaa.json"), stored({ seq: 2, clientId: "aaa", slug: "first" }));
      await writeFixture(join(outDir, "00000007-zzz.json"), stored({ seq: 7, clientId: "zzz", slug: "third" }));

      const entries = await outbox.list();

      expect(entries.map((entry) => entry.clientId)).toEqual(["aaa", "bbb", "zzz"]);
      expect(entries.map((entry) => entry.seq)).toEqual([2, 2, 7]);
      expect(entries.map((entry) => entry.slug)).toEqual(["first", "second", "third"]);
    });
  });

  test("AC-7: list ignores a .tmp-named entry file and a file that is not an entry name", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      const entry = await outbox.enqueue(saveRequest());
      await writeFixture(join(outDir, "00000003-x.json.abc.tmp"), stored({ seq: 3, clientId: "x" }));
      await writeFixture(join(outDir, "notes.txt"), "notes about the outbox");

      const entries = await outbox.list();

      expect(entries.map((listed) => listed.clientId)).toEqual([entry.clientId]);
      expect(await outbox.listInvalid()).toEqual([]);
      expect(await readdir(outDir)).toHaveLength(3);
    });
  });

  test("AC-8: a correctly named file that is not JSON leaves list and is named by listInvalid", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      await outbox.enqueue(saveRequest());
      await writeFixture(join(outDir, "00000004-broken.json"), "{ this is not json");

      const entries = await outbox.list();

      expect(entries).toHaveLength(1);
      expect(await outbox.listInvalid()).toEqual(["00000004-broken.json"]);
    });
  });

  test("AC-9: remove deletes the entry file, and removing an unknown id resolves", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      const entry = await outbox.enqueue(saveRequest());
      const path = join(outDir, `00000001-${entry.clientId}.json`);

      await outbox.remove(entry.clientId);
      await outbox.remove("no-such-client");

      expect(existsSync(path)).toBe(false);
      expect(await outbox.list()).toEqual([]);
    });
  });

  test("AC-10: markRejected rewrites the entry as rejected with the reason and list still returns it", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });
      const entry = await outbox.enqueue(saveRequest());

      await outbox.markRejected(entry.clientId, "note kind not available");

      const entries = await outbox.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        clientId: entry.clientId,
        seq: entry.seq,
        state: "rejected",
        reason: "note kind not available",
        slug: entry.slug,
      });
      expect(await outbox.listInvalid()).toEqual([]);
    });
  });

  test("[F1] a queued entry whose reason is over the cap is not readable, and a rejected one still is", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      const overLong = "a".repeat(MEMORY_FORGET_REASON_MAX_CHARS + 1);
      await writeFixture(
        join(outDir, "00000001-forged-forget.json"),
        stored({ clientId: "forged-forget", kind: "forget", reason: overLong }),
      );
      await writeFixture(
        join(outDir, "00000002-long-rejection.json"),
        stored({ clientId: "long-rejection", seq: 2, state: "rejected", reason: overLong }),
      );

      const entries = await outbox.list();

      // A queued reason is the forget's own justification, so the cap applies to it. A rejected
      // entry's reason is the provider's answer, which this outbox does not get to bound.
      expect(entries.map((entry) => entry.clientId)).toEqual(["long-rejection"]);
      expect(await outbox.listInvalid()).toEqual(["00000001-forged-forget.json"]);
    });
  });

  test("a rejected forget keeps the reason its request carried, beside the rejection reason", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });
      const entry = await outbox.enqueue(forgetRequest({ slug: "dropped-budget" }));

      await outbox.markRejected(entry.clientId, "note kind not available");

      const [rejected] = await outbox.list();
      expect(rejected).toMatchObject({
        kind: "forget",
        clientId: entry.clientId,
        slug: "dropped-budget",
        state: "rejected",
        reason: "note kind not available",
        requestReason: "the budget doubled",
      });
      // Re-marking a rejected entry must not move the previous rejection into the request slot.
      await outbox.markRejected(entry.clientId, "still not available");
      const [again] = await outbox.list();
      expect(again).toMatchObject({ reason: "still not available", requestReason: "the budget doubled" });
      expect(await outbox.listInvalid()).toEqual([]);
    });
  });

  test("AC-11: heldKeys carries queued keys only, filtered by kind when asked", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });
      await outbox.enqueue(saveRequest({ slug: "kept-budget" }));
      await outbox.enqueue(forgetRequest({ slug: "dropped-budget" }));
      const refused = await outbox.enqueue(saveRequest({ slug: "refused-budget" }));
      await outbox.markRejected(refused.clientId, "note kind not available");

      expect(sortedMembers(await outbox.heldKeys())).toEqual(["project/dropped-budget", "project/kept-budget"]);
      expect(sortedMembers(await outbox.heldKeys("forget"))).toEqual(["project/dropped-budget"]);
      expect(sortedMembers(await outbox.heldKeys("save"))).toEqual(["project/kept-budget"]);
    });
  });

  test("AC-12: enqueue stages a .tmp file then renames it, and a concurrent list sees only the earlier entries", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      const queued = await outbox.enqueue(saveRequest({ slug: "already-queued" }));
      const staged: string[] = [];
      const published: string[] = [];
      const written: string[] = [];
      const realOpen = _atomicWriteDeps.open;
      const realRename = _atomicWriteDeps.rename;
      _atomicWriteDeps.open = async (stagedPath, flags, mode) => {
        const stage = await realOpen(stagedPath, flags, mode);
        staged.push(stagedPath);
        return {
          ...stage,
          write: async (content) => {
            written.push(`${stagedPath}\n${String(content)}`);
            await stage.write(content);
          },
        };
      };
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let renameStarted = false;
      _atomicWriteDeps.rename = async (from, to) => {
        renameStarted = true;
        await gate;
        published.push(String(to));
        await realRename(from, to);
      };

      const pending = outbox.enqueue(saveRequest({ slug: "in-flight" }));
      await waitForCondition(() => renameStarted);
      const duringEnqueue = await outbox.list();
      release();
      const arrived = await pending;

      const [stagePath = ""] = staged;
      const [stagedText = ""] = written;
      expect(staged).toHaveLength(1);
      // The stage is a `.tmp` directory beside the entry, and the payload inside it is what
      // the rename publishes.
      expect(dirname(stagePath).endsWith(".tmp")).toBe(true);
      expect(dirname(dirname(stagePath))).toBe(outDir);
      expect(JSON.parse(stagedText.slice(stagePath.length + 1))).toMatchObject({ slug: "in-flight", seq: 2 });
      expect(duringEnqueue.map((entry) => entry.clientId)).toEqual([queued.clientId]);
      expect(published).toEqual([join(outDir, `00000002-${arrived.clientId}.json`)]);
      expect((await outbox.list()).map((entry) => entry.clientId)).toEqual([queued.clientId, arrived.clientId]);
    });
  });

  test("AC-13: createMemoryOutbox is exported from @nathapp/nax-agent", () => {
    expect(typeof pub.createMemoryOutbox).toBe("function");
    expect(typeof createMemoryOutbox).toBe("function");
  });

  test("AC-14: a missing outbox directory lists empty and removes as a no-op", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });

      expect(await outbox.list()).toEqual([]);
      expect(await outbox.listInvalid()).toEqual([]);
      await expect(outbox.remove("no-such-client")).resolves.toBeUndefined();
      expect(existsSync(outboxDir(dir))).toBe(false);
    });
  });

  test("AC-15: a file holding JSON that fails the entry schema leaves list and is named by listInvalid", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      await writeFixture(join(outDir, "00000009-ok.json"), stored({ seq: 9, clientId: "ok" }));
      // A note status the note schema has no member for: the entry cannot be replayed.
      const badNote = stored({ seq: 6, clientId: "badnote" }).replace('"status":"active"', '"status":"bogus"');
      expect(badNote).toContain('"status":"bogus"');
      await writeFixture(join(outDir, "00000005-half.json"), JSON.stringify({ kind: "save", clientId: "half" }));
      await writeFixture(join(outDir, "00000006-badnote.json"), badNote);

      const entries = await outbox.list();

      expect(entries.map((entry) => entry.clientId)).toEqual(["ok"]);
      expect(await outbox.listInvalid()).toEqual(["00000005-half.json", "00000006-badnote.json"]);
    });
  });

  test("an unreadable directory propagates rather than reading as an empty outbox", async () => {
    await withTempDir(async (dir) => {
      const outbox = createMemoryOutbox({ dir: outboxDir(dir), now: fixedNow });
      const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
      _memoryStoreDeps.readdir = async () => {
        throw denied;
      };

      expect(await caught(outbox.list())).toBe(denied);
      expect(await caught(outbox.listInvalid())).toBe(denied);
    });
  });

  test("an entry file that cannot be read is reported invalid, and cannot be rewritten as rejected", async () => {
    await withTempDir(async (dir) => {
      const outDir = outboxDir(dir);
      const outbox = createMemoryOutbox({ dir: outDir, now: fixedNow });
      await outbox.enqueue(saveRequest());
      const path = join(outDir, "00000002-bad.json");
      await writeFixture(path, stored({ seq: 2, clientId: "bad" }));
      const realOpen = _memoryStoreDeps.open;
      _memoryStoreDeps.open = async (target, flags) => {
        if (target === path) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return realOpen(target, flags);
      };

      expect((await outbox.list()).map((entry) => entry.clientId)).toHaveLength(1);
      expect(await outbox.listInvalid()).toEqual(["00000002-bad.json"]);
      await expect(outbox.markRejected("bad", "note kind not available")).resolves.toBeUndefined();
      // The rewrite is not attempted on an entry it could not read: the file is left for a caller.
      expect(existsSync(path)).toBe(true);
    });
  });
});
