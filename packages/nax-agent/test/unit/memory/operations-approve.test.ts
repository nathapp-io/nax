/**
 * US-019: `approveMemoryNote` — the transition that puts a pending note in force.
 *
 * An approval rewrites the note the mirror holds and refreshes the index the next session
 * reads, so the ` (pending)` marker the renderer draws from the note's own status is gone
 * afterwards. It is not an authorization step — it asks no provider and writes nothing to
 * the queue — and it does not approve a queued forget: the `(forget pending)` marker comes
 * from the outbox, which this operation only reads, to keep that marker alive in the index
 * it regenerates.
 *
 * Because it rewrites a note it had to read first, it is a writer of the mirror like any
 * other: it takes the same per-store ordering and the same lock file a save and a forget
 * take, so the note it approves is the note the mirror holds *now* — never a copy read
 * before another writer's newer one landed.
 *
 * Only a note that is waiting for approval is a note this can approve: `active` is
 * already in force and is returned as the mirror holds it, while a note that is history
 * — `superseded`, `rejected`, `deleted` — and a slug the mirror does not hold at all are
 * the same refusal, `MEMORY_NOTE_NOT_FOUND`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
import { acquireSessionLock } from "#src/session-store/index";
import {
  assertDefined,
  assertNaxError,
  type FakeClock,
  type MockLogger,
  makeFakeClock,
  makeLogger,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

/** The instant every approval stamps with: `updatedAt` after a rewrite. */
const STAMP = "2026-11-12T11:30:00.000Z";
/** The slug the approval is about. */
const SLUG = "replay-budget";
/** A second slug: the note whose forget is already queued while the first one is approved. */
const DOOMED_SLUG = "export-window";
/** The stamp the note carried before it was approved: what a rewrite must replace. */
const ORIGINAL_STAMP = "2026-11-01T09:00:00.000Z";
/** A pid no test process has: the file a second process's owner would leave behind. */
const FOREIGN_PID = 8412;
/** A fake-clock step wide enough to fire any poll a waiting approval is parked on. */
const POLL_STEP_MS = 1_000;
/** The description a concurrent writer lands while the approval is waiting for the mirror. */
const NEWER_DESCRIPTION = "replay budget moves to 6,144 MiB";

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

/** The index line of one slug, whichever section rendered it. */
async function indexLineFor(h: Harness, slug: string = SLUG): Promise<string> {
  const index = await readFile(h.store.paths.index, "utf8");
  const line = index.split("\n").find((text) => text.includes(slug));
  assertDefined(line, `index line for "${slug}"`);
  return line;
}

/**
 * The store's lock, held the way an owner holds it: `pid` and the liveness probe that decides
 * whether that owner is still there. Releasing it is the caller's job. (The save and forget
 * suites hold the same lock the same way; the protocol is real, only its holder is scripted.)
 */
async function heldLock(h: Harness, pid: number, isAlive: (pid: number) => boolean): Promise<() => Promise<void>> {
  await mkdir(h.store.paths.projectDir, { recursive: true });
  const deps = { dir: h.store.paths.projectDir, pid, now: () => new Date(STAMP), logger: h.logger, isAlive };
  return acquireSessionLock(h.store.paths.lock, deps, isAlive);
}

/** A sync-shaped wait: park an approval behind a live holder on the injected clock. */
function waiting(h: Harness, clock: FakeClock): Promise<MemoryNote> {
  return h.approve({ timers: clock, isAlive: () => true });
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

  test("AC-1: an approval queues nothing and creates no outbox directory", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());

      await h.approve();

      // The approval only reads the queue (for the index's forget markers): nothing is queued,
      // no entry is rewritten, and a mirror with no queue gains none.
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

describe("approveMemoryNote and the mirror's other writers", () => {
  test("[F1] an approval waits for the mirror's live holder before it reads the note", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      const owner = await heldLock(h, FOREIGN_PID, () => true);
      const clock = makeFakeClock();

      const approving = waiting(h, clock);
      // The owner has the mirror: nothing has been rewritten, and the wait is a poll on the
      // operation's own timers rather than a read against a mirror another writer is changing.
      await waitForCondition(() => clock.pending() > 0, 5_000);
      expect(await h.store.readNote("project", SLUG)).toEqual(note());

      // A newer version of the same note lands while the approval is still waiting.
      const newer = note({ description: NEWER_DESCRIPTION, body: `${NEWER_DESCRIPTION}.` });
      await h.store.writeNote(newer);

      await owner();
      await clock.advance(POLL_STEP_MS);
      const approved = await approving;

      // What is approved is the note the mirror holds now, not the copy read before the wait:
      // a stale read would have put the older description back and lost the newer write.
      expect(approved.description).toBe(NEWER_DESCRIPTION);
      expect(approved).toEqual({ ...newer, status: "active", updatedAt: STAMP });
      expect(await h.store.readNote("project", SLUG)).toEqual(approved);
      // The approval took the lock and handed it back.
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });

  test("[F2] approving keeps the (forget pending) marker of a note whose forget is queued", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      await h.store.writeNote(note({ slug: DOOMED_SLUG, status: "active", description: "exports land before 09:00" }));
      const outbox = createMemoryOutbox({ dir: h.store.paths.outboxDir, now: () => new Date(STAMP) });
      await outbox.enqueue({
        kind: "forget",
        clientId: "client-doomed",
        scope: "project",
        slug: DOOMED_SLUG,
        writeMode: "proposal",
        reason: "the export window was retired",
      });
      // The index a session reads before the approval: the marker comes from the queue.
      await refreshMemoryIndex(h.store, { heldForgets: await outbox.heldKeys("forget") });
      expect((await indexLineFor(h, DOOMED_SLUG)).endsWith(" (forget pending)")).toBe(true);

      await h.approve();

      // The queued forget is untouched by the approval, so its marker has to survive the
      // index regeneration — a refresh with no held keys would silently drop it.
      expect((await indexLineFor(h, DOOMED_SLUG)).endsWith(" (forget pending)")).toBe(true);
      expect((await indexLineFor(h, SLUG)).endsWith(" (pending)")).toBe(false);
    });
  });
});
