/**
 * US-019: `approveMemoryNote` — the local transition that puts a pending note in force.
 *
 * An approval is a store transition and nothing else: it rewrites the note the mirror
 * holds and refreshes the index the next session reads, so the ` (pending)` marker the
 * renderer draws from the note's own status is gone afterwards. It is not an
 * authorization step — it asks no provider and touches no queue — and it does not
 * approve a queued forget: the `(forget pending)` marker comes from the outbox, which
 * this operation never reads or writes.
 *
 * Only a note that is waiting for approval is a note this can approve: `active` is
 * already in force and is returned as the mirror holds it, while a note that is history
 * — `superseded`, `rejected`, `deleted` — and a slug the mirror does not hold at all are
 * the same refusal, `MEMORY_NOTE_NOT_FOUND`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  approveMemoryNote,
  createMemoryOutbox,
  createMemoryStore,
  type MemoryApproveInput,
  type MemoryNote,
  type MemoryNoteStatus,
  type MemoryStore,
  refreshMemoryIndex,
} from "@nathapp/nax-agent";
import { assertDefined, assertNaxError, type MockLogger, makeLogger, withTempDir } from "#test/helpers/index";

/** The instant every approval stamps with: `updatedAt` after a rewrite. */
const STAMP = "2026-11-12T11:30:00.000Z";
/** The slug the approval is about. */
const SLUG = "replay-budget";
/** The stamp the note carried before it was approved: what a rewrite must replace. */
const ORIGINAL_STAMP = "2026-11-01T09:00:00.000Z";

/** The note the mirror holds; `pending` is the one an approval is for. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_proposal_1",
    slug: SLUG,
    type: "project",
    scope: "project",
    description: "replay budget moves to 4,096 MiB",
    source: "nax-chat",
    updatedAt: ORIGINAL_STAMP,
    status: "pending",
    body: "The replay budget moves to 4,096 MiB.",
    ...overrides,
  };
}

/** The pieces one approval runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly logger: MockLogger;
  /** The approval's input: this harness's store, plus any per-test override. */
  approve(overrides?: Partial<MemoryApproveInput>): Promise<MemoryNote>;
}

function harness(dir: string): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  return {
    store,
    logger,
    approve: (overrides = {}) =>
      approveMemoryNote({ store, now: () => new Date(STAMP), scope: "project", slug: SLUG, ...overrides }),
  };
}

/** The index line of the approved slug, whichever section rendered it. */
async function indexLineFor(h: Harness): Promise<string> {
  const index = await readFile(h.store.paths.index, "utf8");
  const line = index.split("\n").find((text) => text.includes(SLUG));
  assertDefined(line, `index line for "${SLUG}"`);
  return line;
}

describe("approveMemoryNote", () => {
  test("AC-1: a pending note is rewritten active and stamped with now()", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const pending = note();
      await h.store.writeNote(pending);

      const approved = await h.approve();

      expect(approved).toEqual({ ...pending, status: "active", updatedAt: STAMP });
      // The mirror holds the approval, not just the returned value.
      expect(await h.store.readNote("project", SLUG)).toEqual(approved);
    });
  });

  test("AC-1: the refreshed index no longer carries the (pending) marker", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      // The index a session read before the approval: the pending marker is the note's status.
      await refreshMemoryIndex(h.store);
      expect((await indexLineFor(h)).endsWith(" (pending)")).toBe(true);

      await h.approve();

      const line = await indexLineFor(h);
      expect(line).toContain(SLUG);
      expect(line.endsWith(" (pending)")).toBe(false);
      expect(line).toContain(note().description);
    });
  });

  test("AC-1: an approval writes no outbox and leaves the queue directory alone", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());

      await h.approve();

      // The approval is a store transition: nothing is queued and no entry is rewritten.
      expect(existsSync(h.store.paths.outboxDir)).toBe(false);
    });
  });

  test("AC-2: an active note is returned unchanged", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const active = note({ status: "active", updatedAt: ORIGINAL_STAMP });
      await h.store.writeNote(active);

      const approved = await h.approve();

      expect(approved).toEqual(active);
      // Not re-stamped: a note already in force is not rewritten by being approved.
      expect(approved.updatedAt).toBe(ORIGINAL_STAMP);
      expect(await h.store.readNote("project", SLUG)).toEqual(active);
    });
  });

  test("AC-3: an absent slug is a MEMORY_NOTE_NOT_FOUND refusal, and nothing is written", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);

      const caught = await h.approve().catch((error: unknown) => error);

      assertNaxError(caught, "approval of an absent slug");
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
      expect(caught.context).toMatchObject({ stage: "memory", scope: "project", slug: SLUG });
      expect(existsSync(join(h.store.paths.notesDir, `${SLUG}.md`))).toBe(false);
      expect(existsSync(h.store.paths.index)).toBe(false);
    });
  });

  test.each<MemoryNoteStatus>(["superseded", "rejected", "deleted"])(
    "AC-3: a note that is history (%s) is a MEMORY_NOTE_NOT_FOUND refusal",
    async (status) => {
      await withTempDir(async (dir) => {
        const h = harness(dir);
        const retired = note({ status });
        await h.store.writeNote(retired);

        const caught = await h.approve().catch((error: unknown) => error);

        assertNaxError(caught, `approval of a ${status} note`);
        expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
        expect(caught.message).toContain(`project/${SLUG}`);
        // A note that is history is left exactly as it is, status included.
        expect(await h.store.readNote("project", SLUG)).toEqual(retired);
      });
    },
  );

  test("AC-6: approveMemoryNote is exported from the public entry", () => {
    expect(typeof pub.approveMemoryNote).toBe("function");
    expect(pub.approveMemoryNote).toBe(approveMemoryNote);
  });

  test("a queued forget is not approved by the approval, and is left untouched", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      const outbox = createMemoryOutbox({ dir: h.store.paths.outboxDir, now: () => new Date(STAMP) });
      const queued = await outbox.enqueue({
        kind: "forget",
        clientId: "client-waiting",
        scope: "project",
        slug: SLUG,
        writeMode: "proposal",
        reason: "an earlier reason",
      });

      const approved = await h.approve();

      // The approval does not approve a queued forget: the entry is the outbox's alone.
      expect(approved.status).toBe("active");
      expect(await outbox.list()).toEqual([queued]);
    });
  });
});
