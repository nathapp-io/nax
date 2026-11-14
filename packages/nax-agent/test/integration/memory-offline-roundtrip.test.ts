/**
 * US-019: the offline round trips — a write taken while the provider is unreachable,
 * and the sync that later delivers it.
 *
 * This file reimplements nothing: it drives the public seam an agent has
 * (`saveMemoryNote` / `forgetMemoryNote` / `syncMemory`) against a real temporary
 * mirror, a real on-disk outbox and the shared scripted provider, and asserts what
 * the two halves make of one write. The provider's `reachable` script is what makes
 * the round trip a round trip — it answers `false` to the save (or the forget), so
 * the write stays `delivered: false` with its request queued, and `true` to the sync
 * that follows, which is the only step allowed to push it and take the entry back off
 * the queue.
 *
 * What the delivery leaves in the mirror is the provider's answer, not the caller's:
 * a drained save is mirrored under the provider's id, and a drained forget removes
 * the note only because the provider said `deleted`. The signature of every flow is
 * the empty outbox — the queue is what makes a write durable, so an entry still on it
 * is a write that did not land.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  forgetMemoryNote,
  type MemoryForgetInput,
  type MemoryForgetResult,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  type MemorySyncResult,
  type MemoryWriteRequest,
  saveMemoryNote,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import {
  assertDefined,
  firstCall,
  type MemoryProviderMock,
  type MemoryProviderScript,
  type MockLogger,
  makeLogger,
  makeMemoryProvider,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

/** The instant every injected clock reports: the note's `updatedAt`. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** The pid each sync claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 6019;
/** The slug both round trips are about. */
const SLUG = "replay-budget";
/** The id the provider answers with once it takes the queued write. */
const REMOTE_ID = "mem_remote_1";
/** Why the agent forgets the note: carried to the provider on the queued request. */
const REASON = "the replay budget was retired in 0.92";

/** The write the offline save is made of. */
const WRITE: MemoryNoteWrite = {
  slug: SLUG,
  type: "project",
  scope: "project",
  description: "replay budget stays 2,048 MiB",
  body: "The replay budget stays at 2,048 MiB.",
};

/** The note the offline forget retires: already in the mirror, as a synced note is. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_existing",
    slug: SLUG,
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-run",
    updatedAt: "2026-11-01T09:00:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** The pieces one round trip runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  /** The write half: a save against this harness's mirror, queue and provider. */
  save(overrides?: Partial<MemorySaveInput>): Promise<MemorySaveResult>;
  /** The other write half: a forget against the same pieces. */
  forget(overrides?: Partial<MemoryForgetInput>): Promise<MemoryForgetResult>;
  /** The delivery half: a sync against the same pieces, on a lock no pid proves live. */
  sync(overrides?: Partial<MemorySyncInput>): Promise<MemorySyncResult>;
}

function harness(dir: string, script: MemoryProviderScript = {}): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider(script);
  const shared = { store, outbox, provider, logger, now: () => new Date(STAMP) };
  return {
    store,
    outbox,
    provider,
    logger,
    save: (overrides = {}) =>
      saveMemoryNote({ ...shared, write: WRITE, writeMode: "direct", source: "nax-run", ...overrides }),
    forget: (overrides = {}) =>
      forgetMemoryNote({
        ...shared,
        scope: "project",
        slug: SLUG,
        reason: REASON,
        writeMode: "proposal",
        ...overrides,
      }),
    sync: (overrides = {}) => syncMemory({ ...shared, pid: SYNC_PID, isAlive: () => false, ...overrides }),
  };
}

/** The outbox's one entry, asserted to be the only one. */
async function soleEntry(h: Harness): Promise<MemoryOutboxEntry> {
  const entries = await h.outbox.list();
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  assertDefined(entry, "queued outbox entry");
  return entry;
}

/** The one request the provider was pushed, asserted to have been pushed exactly once. */
function pushedRequest(h: Harness): MemoryWriteRequest {
  expect(h.provider.push).toHaveBeenCalledTimes(1);
  const [request] = firstCall(h.provider.push, "provider push");
  return request;
}

/** The index line of a slug, whichever section rendered it. */
async function indexLineFor(h: Harness): Promise<string> {
  const index = await readFile(h.store.paths.index, "utf8");
  const line = index.split("\n").find((text) => text.includes(SLUG));
  assertDefined(line, `index line for "${SLUG}"`);
  return line;
}

describe("an offline save and the sync that delivers it", () => {
  test("AC-4: the save is undelivered and queued, and the sync pushes exactly that request", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: [false, true], push: { id: REMOTE_ID, status: "active" } });

      const saved = await h.save();

      // The probe answered and the push never happened: the write is durable on the queue only.
      expect(saved).toEqual({ slug: SLUG, status: "active", delivered: false });
      expect(h.provider.push).not.toHaveBeenCalled();
      const queued = await soleEntry(h);
      expect(queued).toMatchObject({
        kind: "save",
        scope: "project",
        slug: SLUG,
        writeMode: "direct",
        state: "queued",
      });
      const staged = await h.store.readNote("project", SLUG);
      assertDefined(staged, "staged note");
      // One id names the note, the entry and the write the sync will send.
      expect(queued.clientId).toBe(staged.id);

      const result = await h.sync();

      expect(result).toEqual({ outcome: "synced", pushed: 1, rejected: 0, pulled: 0, skipped: 0 });
      // The queue is what the provider is handed: the same client id, the same note.
      const request = pushedRequest(h);
      expect(request).toMatchObject({
        kind: "save",
        clientId: staged.id,
        scope: "project",
        slug: SLUG,
        writeMode: "direct",
      });
      expect(request.note).toMatchObject({ slug: SLUG, description: WRITE.description, updatedAt: STAMP });
      // Delivered: nothing left for a later run to replay.
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-4: the delivered note carries the provider's id, and the index shows the slug", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: [false, true], push: { id: REMOTE_ID, status: "active" } });
      await h.save();

      await h.sync();

      const delivered = await h.store.readNote("project", SLUG);
      // The provider's answer is what the mirror holds now; the rest of the note is the caller's.
      expect(delivered).toEqual({
        id: REMOTE_ID,
        slug: SLUG,
        type: "project",
        scope: "project",
        description: WRITE.description,
        source: "nax-run",
        updatedAt: STAMP,
        status: "active",
        body: WRITE.body,
      });
      // The sync refreshed the index the next session reads.
      expect(await indexLineFor(h)).toContain(SLUG);
    });
  });

  test("AC-4: a provider still unreachable at sync time leaves the write queued", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });
      await h.save();
      const queued = await soleEntry(h);

      const result = await h.sync();

      expect(result).toEqual({ outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      // Nothing was pushed, so the entry — and the write it stands for — is still there.
      expect(await h.outbox.list()).toEqual([queued]);
    });
  });
});

describe("a save made while this process is syncing", () => {
  test("[B4] the delivered save replaces the mirror's older note instead of being lost with its entry", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const older = note({ id: "mem_old", body: "old body" });
      await h.store.writeNote(older);
      // The save is fenced by the sync, so its entry is the only copy of the new content; the
      // pull that follows brings nothing back for the slug.
      const gate = Promise.withResolvers<void>();
      const syncing = makeMemoryProvider({
        reachable: async () => {
          await gate.promise;
          return true;
        },
        push: { id: REMOTE_ID, status: "active" },
        pull: { notes: [], done: true },
      });

      const running = h.sync({ provider: syncing });
      await waitForCondition(() => syncing.reachable.mock.calls.length === 1, 5_000);

      const saved = await h.save({ provider: h.provider, write: { ...WRITE, body: "new body" } });
      expect(saved).toEqual({ slug: SLUG, status: "active", delivered: false });
      // Nothing was staged: the mirror still holds the older note while the sync owns it.
      expect(await h.store.readNote("project", SLUG)).toMatchObject({ id: "mem_old", body: "old body" });
      expect(h.provider.push).not.toHaveBeenCalled();

      gate.resolve();
      const result = await running;

      expect(result).toEqual({ outcome: "synced", pushed: 1, rejected: 0, pulled: 0, skipped: 0 });
      // The provider was handed the queued content, so the mirror must end on that content too:
      // the entry carrying it is gone, and neither the pull nor the drain's own write is a copy.
      expect(firstCall(syncing.push, "provider push")[0].note).toMatchObject({ body: "new body" });
      expect(await h.outbox.list()).toEqual([]);
      expect(await h.store.readNote("project", SLUG)).toMatchObject({
        id: REMOTE_ID,
        status: "active",
        body: "new body",
      });
    });
  });
});

describe("an offline forget and the sync that acknowledges it", () => {
  test("AC-5: a proposal forget is queued with the note in place and (forget pending) showing", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });
      const existing = note();
      await h.store.writeNote(existing);

      const forgotten = await h.forget();

      expect(forgotten).toEqual({ slug: SLUG, status: "pending", delivered: false });
      expect(h.provider.push).not.toHaveBeenCalled();
      // A proposal changes nothing locally: the note is the mirror's, untouched.
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
      const queued = await soleEntry(h);
      expect(queued).toMatchObject({
        kind: "forget",
        scope: "project",
        slug: SLUG,
        reason: REASON,
        writeMode: "proposal",
        state: "queued",
      });
      // The marker is the outbox speaking: the note itself still reads active.
      expect((await indexLineFor(h)).endsWith(" (forget pending)")).toBe(true);
    });
  });

  test("AC-5: the sync pushes the queued forget, the acknowledgement leaves no note and no entry", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: [false, true], push: { id: REMOTE_ID, status: "deleted" } });
      await h.store.writeNote(note());
      const forgotten = await h.forget();
      const queued = await soleEntry(h);

      const result = await h.sync();

      expect(forgotten.delivered).toBe(false);
      expect(result).toEqual({ outcome: "synced", pushed: 1, rejected: 0, pulled: 0, skipped: 0 });
      const request = pushedRequest(h);
      expect(request).toMatchObject({
        kind: "forget",
        clientId: queued.clientId,
        scope: "project",
        slug: SLUG,
        writeMode: "proposal",
        reason: REASON,
      });
      // `deleted` is the acknowledgement: the mirrored note goes, and the entry with it.
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(await h.outbox.list()).toEqual([]);
      // The refreshed index no longer lists the retired slug.
      const index = await readFile(h.store.paths.index, "utf8");
      expect(index).not.toContain(SLUG);
    });
  });

  test("AC-5: an acknowledgement that is not `deleted` keeps the note and clears the entry", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: [false, true], push: { id: REMOTE_ID, status: "pending" } });
      const existing = note();
      await h.store.writeNote(existing);
      await h.forget();

      const result = await h.sync();

      expect(result).toMatchObject({ outcome: "synced", pushed: 1 });
      // The provider recorded the forget but has not carried it out: the note stays.
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
      expect(await h.outbox.list()).toEqual([]);
    });
  });
});

/**
 * US-004: the round trip for a forget the provider merely holds.
 *
 * A `direct` forget deletes its note when the request is queued, and the entry carries no copy
 * of it — so the drain cannot put it back the way a hand-over does. The pull can: the provider
 * still holds the row as active, and the drain sends the scope's pull back to the beginning so
 * this run reads it in full. An incremental pull is modelled here — a page is served only to a
 * cursor at the start of the sequence — because that is what makes the rewind load-bearing.
 */
describe("US-004: a queued direct forget the provider holds pending", () => {
  test("AC-9: the sync's pull brings the provider's active row back into the mirror", async () => {
    await withTempDir(async (dir) => {
      const active = note({ id: REMOTE_ID, status: "active" });
      const h = harness(dir, {
        reachable: [false, true],
        push: { id: REMOTE_ID, status: "pending" },
        pull: (asked) => (asked.cursor === null ? { notes: [active], done: true } : { notes: [], done: true }),
      });
      await h.store.writeNote(note());
      // An earlier pull already moved past this slug: only a pull from the beginning re-reads it.
      await h.store.writeSyncState({
        provider: "scripted",
        cursor: { project: "page-9", user: null },
        lastPullAt: STAMP,
        lastError: null,
      });

      const forgotten = await h.forget({ writeMode: "direct" });
      // Direct retires the note at once; the queue is what tells the provider later.
      expect(forgotten).toEqual({ slug: SLUG, status: "deleted", delivered: false });
      expect(await h.store.readNote("project", SLUG)).toBeNull();

      const result = await h.sync();

      expect(result).toEqual({ outcome: "synced", pushed: 1, rejected: 0, pulled: 1, skipped: 0 });
      // The provider never carried the retire out, so the mirror keeps the note it holds.
      expect(await h.store.readNote("project", SLUG)).toEqual(active);
      expect(await h.outbox.list()).toEqual([]);
    });
  });
});
