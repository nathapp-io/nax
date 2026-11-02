/**
 * US-014: step 4 of a sync — pulling the provider's pages and checkpointing the
 * cursor each page hands back.
 *
 * Every pull starts from `sync.json`'s cursor for its scope, asks for
 * `MEMORY_PULL_PAGE_SIZE` notes, and moves on with the page's `nextCursor` until a
 * page reports `done` — at most `MEMORY_PULL_MAX_PAGES` pages per scope. Each page
 * is checkpointed before the next is asked for, so a throw, a timeout or the page
 * limit leaves the last completed page's cursor on disk and ends the run `failed`.
 * A `done` page at the limit is a finished sequence, not a truncated one.
 *
 * The timeout test drives the operation race on a fake clock: it first waits for
 * the pull's timer to appear (the probe's own timer is cleared before it), advances
 * the clock, and only then awaits the run — `advance` drains microtasks only, and
 * everything after the race is real filesystem I/O.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_OP_TIMEOUT_MS,
  MEMORY_PULL_MAX_PAGES,
  MEMORY_PULL_PAGE_SIZE,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryPage,
  type MemoryStore,
  type MemorySyncState,
  type MemoryWriteRequest,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import {
  type MemoryProviderMock,
  type MemoryProviderScript,
  type MockLogger,
  makeFakeClock,
  makeLogger,
  makeMemoryProvider,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-12T10:00:00.000Z";
/** The pid each harness claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 6161;

/** The note a queued write carries; the drain delivers it before the pull runs. */
function queuedNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_local_1",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: STAMP,
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** One note as a provider hands it over: live, and named by its slug. */
function pulledNote(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return queuedNote({
    id: `mem_${slug}`,
    slug,
    description: `${slug} description`,
    body: `${slug} body.`,
    ...overrides,
  });
}

/** A page with more behind it. */
function morePage(notes: readonly MemoryNote[], nextCursor?: string): MemoryPage {
  return { notes, ...(nextCursor === undefined ? {} : { nextCursor }), done: false };
}

/** A page that ends the sequence: `done`, with whatever cursor the provider last handed out. */
function lastPage(notes: readonly MemoryNote[], nextCursor?: string): MemoryPage {
  return { notes, ...(nextCursor === undefined ? {} : { nextCursor }), done: true };
}

/** A `save` write request for `saved`, keyed by `clientId`. */
function saveRequest(saved: MemoryNote, clientId: string): MemoryWriteRequest {
  return { kind: "save", clientId, scope: saved.scope, slug: saved.slug, writeMode: "direct", note: saved };
}

/** The pieces one sync runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  /** The sync's input: this harness's pieces, plus any per-test override. */
  input(overrides?: Partial<MemorySyncInput>): MemorySyncInput;
}

/** `user: true` gives the store the user directory a store may also mirror into. */
function harness(dir: string, script: MemoryProviderScript = {}, user = false): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({
    projectDir: join(dir, "project"),
    ...(user ? { userDir: join(dir, "user") } : {}),
    logger,
  });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider(script);
  return {
    store,
    outbox,
    provider,
    logger,
    input: (overrides = {}) => ({
      store,
      outbox,
      provider,
      logger,
      now: () => new Date(STAMP),
      pid: SYNC_PID,
      // A lock nobody's pid proves live is a stale one: this run takes it over.
      isAlive: () => false,
      ...overrides,
    }),
  };
}

/** What the provider was asked to pull, in call order. */
function pullCalls(provider: MemoryProviderMock): { scope: string; cursor: string | null; take: number }[] {
  return provider.pull.mock.calls.map(([input]) => input);
}

/** The state the `sync.json` on disk holds. */
async function recordedSyncState(path: string): Promise<MemorySyncState> {
  const parsed: MemorySyncState = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

/** The state a previous sync left: both cursors set, and a stale error to be cleared. */
function previousState(projectCursor: string): MemorySyncState {
  return {
    provider: "an-earlier-provider",
    cursor: { project: projectCursor, user: null },
    lastPullAt: "2026-11-11T09:00:00.000Z",
    lastError: "previous failure",
  };
}

describe("syncMemory step 4 (pull)", () => {
  test("AC-1: the pages are walked from the start with each page's cursor, and pulled counts them", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, {
        pull: [morePage([pulledNote("first-note")], "c1"), lastPage([pulledNote("second-note")])],
      });

      const result = await syncMemory(h.input());

      expect(pullCalls(h.provider)).toEqual([
        { scope: "project", cursor: null, take: MEMORY_PULL_PAGE_SIZE },
        { scope: "project", cursor: "c1", take: MEMORY_PULL_PAGE_SIZE },
      ]);
      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 2, skipped: 0 });
    });
  });

  test("AC-2: both notes land in the mirror, and sync.json records the cursor, provider and pull time", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, {
        id: "scripted-remote",
        pull: [morePage([pulledNote("first-note")], "c1"), lastPage([pulledNote("second-note")])],
      });

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "synced", pulled: 2 });
      expect(await h.store.readNote("project", "first-note")).toEqual(pulledNote("first-note"));
      expect(await h.store.readNote("project", "second-note")).toEqual(pulledNote("second-note"));
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        provider: "scripted-remote",
        cursor: { project: "c1", user: null },
        lastPullAt: STAMP,
        lastError: null,
      });
    });
  });

  test("AC-3: a last page without nextCursor leaves the cursor at the previous page's", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { pull: [morePage([]), lastPage([])] });
      await h.store.writeSyncState(previousState("c9"));

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      // Neither page handed out a cursor, so the one the run started from is the one it ends on.
      expect(pullCalls(h.provider).map((call) => call.cursor)).toEqual(["c9", "c9"]);
      const state = await recordedSyncState(h.store.paths.syncState);
      expect(state.cursor.project).toBe("c9");
      // A completed pull clears the error the previous run left behind.
      expect(state.lastError).toBeNull();
    });
  });

  test("AC-3: a cursor handed out by the last page is the one that is kept", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { pull: [morePage([], "c1"), lastPage([], "c2")] });

      await syncMemory(h.input());

      expect((await recordedSyncState(h.store.paths.syncState)).cursor.project).toBe("c2");
    });
  });

  test("AC-4: the cursor already in sync.json is what the first page asks from", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, {});
      await h.store.writeSyncState(previousState("c9"));

      await syncMemory(h.input());

      expect(pullCalls(h.provider).map((call) => call.cursor)).toEqual(["c9"]);
    });
  });

  test("AC-5: a throw on the second page keeps the first page's cursor and fails the run", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, {
        pull: [morePage([pulledNote("kept-note")], "c1"), new Error("pull connection reset")],
      });

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "failed", pulled: 1, error: "pull connection reset" });
      // The checkpoint written after the page that did arrive is the state the run leaves.
      const state = await recordedSyncState(h.store.paths.syncState);
      expect(state).toEqual({
        provider: "scripted",
        cursor: { project: "c1", user: null },
        lastPullAt: STAMP,
        lastError: "pull connection reset",
      });
      expect(await h.store.readNote("project", "kept-note")).toEqual(pulledNote("kept-note"));
    });
  });

  test("AC-6: a pull that never settles is a failed run once the operation deadline fires", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { pull: "hang" });
      const clock = makeFakeClock();

      const running = syncMemory(h.input({ timers: clock }));
      // The probe's timer is cleared before the pull: the one timer left is the page's.
      await waitForCondition(() => h.provider.pull.mock.calls.length === 1 && clock.pending() > 0, 5_000);
      expect(clock.pending()).toBe(1);

      await clock.advance(MEMORY_OP_TIMEOUT_MS);
      const result = await running;

      expect(result.outcome).toBe("failed");
      expect(result.pulled).toBe(0);
      // The timeout the provider never answered was recorded, and nothing is left armed.
      const recorded = await recordedSyncState(h.store.paths.syncState);
      expect(typeof result.error).toBe("string");
      expect(recorded.lastError).toBe(result.error ?? "");
      expect(clock.pending()).toBe(0);
    });
  });

  test("AC-7: a sequence that never reports done is stopped at the page limit", async () => {
    await withTempDir(async (dir) => {
      // The script repeats its last page, so every page says there is more.
      const h = harness(dir, { pull: [morePage([], "c1")] });

      const result = await syncMemory(h.input());

      expect(h.provider.pull.mock.calls).toHaveLength(MEMORY_PULL_MAX_PAGES);
      expect(result).toMatchObject({ outcome: "failed", error: "pull page limit reached" });
      // The cursor written for the last completed page survives the failure.
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        provider: "scripted",
        cursor: { project: "c1", user: null },
        lastPullAt: STAMP,
        lastError: "pull page limit reached",
      });
    });
  });

  test("AC-7: a done page at the page limit is a finished sequence, not a truncated one", async () => {
    await withTempDir(async (dir) => {
      const pages = Array.from({ length: MEMORY_PULL_MAX_PAGES }, (_, index) =>
        index === MEMORY_PULL_MAX_PAGES - 1 ? lastPage([], "c-final") : morePage([], `c${index}`),
      );
      const h = harness(dir, { pull: pages });

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      expect(result.error).toBeUndefined();
      expect(h.provider.pull.mock.calls).toHaveLength(MEMORY_PULL_MAX_PAGES);
      expect((await recordedSyncState(h.store.paths.syncState)).cursor.project).toBe("c-final");
    });
  });

  test("AC-8: the pull runs after the drain, and the pushed note and the pulled notes are all mirrored", async () => {
    await withTempDir(async (dir) => {
      const order: string[] = [];
      const delivered = queuedNote();
      const h = harness(dir, {
        push: (request) => {
          order.push("push");
          return { id: request.note?.id ?? request.clientId, status: "active" };
        },
        pull: () => {
          order.push("pull");
          return lastPage([pulledNote("pulled-one"), pulledNote("pulled-two")]);
        },
      });
      await h.outbox.enqueue(saveRequest(delivered, "client-a"));

      const result = await syncMemory(h.input());

      expect(order).toEqual(["push", "pull"]);
      expect(result).toEqual({ outcome: "synced", pushed: 1, rejected: 0, pulled: 2, skipped: 0 });
      expect(await h.store.readNote("project", "replay-budget")).toEqual(delivered);
      expect(await h.store.readNote("project", "pulled-one")).toEqual(pulledNote("pulled-one"));
      expect(await h.store.readNote("project", "pulled-two")).toEqual(pulledNote("pulled-two"));
    });
  });

  test("a store with a user directory checkpoints each scope's cursor separately", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { pull: (input) => lastPage([], input.scope === "project" ? "p-next" : "u-next") }, true);
      await h.store.writeSyncState({
        provider: null,
        cursor: { project: "c9", user: "c8" },
        lastPullAt: null,
        lastError: null,
      });

      const result = await syncMemory(h.input());

      // The project is pulled first, then the user: each from its own cursor.
      expect(pullCalls(h.provider).map((call) => [call.scope, call.cursor])).toEqual([
        ["project", "c9"],
        ["user", "c8"],
      ]);
      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        provider: "scripted",
        cursor: { project: "p-next", user: "u-next" },
        lastPullAt: STAMP,
        lastError: null,
      });
    });
  });

  test("an injected pageSize is the take every page asks for", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { pull: [lastPage([])] });

      await syncMemory(h.input({ pageSize: 25 }));

      expect(pullCalls(h.provider)).toEqual([{ scope: "project", cursor: null, take: 25 }]);
    });
  });
});
