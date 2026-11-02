/**
 * US-013: step 3 of a sync — draining the outbox.
 *
 * The drain is the one step that moves a write: every `queued` entry is pushed in
 * `seq` order, a `save` is mirrored back with the provider's `id` and `status`, a
 * `forget` removes the mirrored note only when the provider reports it `deleted`,
 * and a permanent refusal (`MEMORY_PUSH_REJECTED`) is recorded on the entry while
 * the drain carries on. Any other failure — a throw, or the `MEMORY_OP_TIMEOUT_MS`
 * race firing — stops the drain, keeps the entry queued and ends the run `failed`.
 *
 * The timeout test drives the operation race on a fake clock, so it first waits
 * for the push's timer to appear (the probe's own timer is cleared before the
 * push), advances the clock, and only then awaits the run: `advance` drains
 * microtasks only, and everything after the race is real filesystem I/O.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_OP_TIMEOUT_MS,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryPushResult,
  type MemoryStore,
  type MemorySyncState,
  type MemoryWriteRequest,
  NaxError,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import {
  assertDefined,
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
const STAMP = "2026-11-05T09:20:00.000Z";
/** The pid each harness claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 5151;
/** What a provider that accepted the first save answers: the note is live under a new id. */
const ANSWER_ACTIVE: MemoryPushResult = { id: "mem_remote_1", status: "active" };
/** What a provider that accepted a proposal answers: recorded, not yet live. */
const ANSWER_PENDING: MemoryPushResult = { id: "mem_remote_2", status: "pending" };

/** The first note the tests queue: the example note from the memory-store design. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "local-replay-budget",
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

/** The second note: the one a drain must still deliver after the first was refused. */
function otherNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return note({
    id: "local-export-window",
    slug: "export-window",
    description: "exports land before 09:00",
    ...overrides,
  });
}

/** A `save` write request for `saved`, keyed by `clientId`. */
function saveRequest(saved: MemoryNote, clientId: string): MemoryWriteRequest {
  return {
    kind: "save",
    clientId,
    scope: saved.scope,
    slug: saved.slug,
    writeMode: "direct",
    note: saved,
  };
}

/** A `forget` write request: the slug to drop, with the reason the caller gave. */
function forgetRequest(slug: string, clientId: string): MemoryWriteRequest {
  return {
    kind: "forget",
    clientId,
    scope: "project",
    slug,
    writeMode: "direct",
    reason: "superseded by replay-budget",
  };
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

function harness(dir: string, script: MemoryProviderScript = {}): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
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

/** What the provider was asked to push, in call order. */
function pushed(provider: MemoryProviderMock): MemoryWriteRequest[] {
  return provider.push.mock.calls.map(([request]) => request);
}

/** The state the `sync.json` on disk holds. */
async function recordedSyncState(path: string): Promise<MemorySyncState> {
  const parsed: MemorySyncState = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

describe("syncMemory step 3 (drain)", () => {
  test("AC-1: two queued saves are pushed once each in seq order, and the run is synced", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const firstNote = note();
      const secondNote = otherNote();
      const first = await h.outbox.enqueue(saveRequest(firstNote, "client-a"));
      const second = await h.outbox.enqueue(saveRequest(secondNote, "client-b"));

      const result = await syncMemory(h.input());

      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(pushed(h.provider)).toEqual([saveRequest(firstNote, "client-a"), saveRequest(secondNote, "client-b")]);
      expect(result).toEqual({ outcome: "synced", pushed: 2, rejected: 0, pulled: 0, skipped: 0 });
    });
  });

  test("AC-2: both entries are removed and each mirrored note carries the provider's id and status", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: [ANSWER_ACTIVE, ANSWER_PENDING] });
      const firstNote = note({ id: "client-a", status: "pending" });
      const secondNote = otherNote({ id: "client-b", status: "pending" });
      await h.store.writeNote(firstNote);
      await h.store.writeNote(secondNote);
      await h.outbox.enqueue(saveRequest(firstNote, "client-a"));
      await h.outbox.enqueue(saveRequest(secondNote, "client-b"));

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "synced", pushed: 2, rejected: 0 });
      expect(await h.outbox.list()).toEqual([]);
      // The delivery rewrote the mirror: the provider's id and status, nothing else changed.
      expect(await h.store.readNote("project", "replay-budget")).toEqual({
        ...firstNote,
        id: ANSWER_ACTIVE.id,
        status: ANSWER_ACTIVE.status,
      });
      expect(await h.store.readNote("project", "export-window")).toEqual({
        ...secondNote,
        id: ANSWER_PENDING.id,
        status: ANSWER_PENDING.status,
      });
    });
  });

  test("AC-3: a forget deletes the mirrored note only when the provider reports it deleted", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, {
        push: [
          { id: "mem_doomed", status: "deleted" },
          { id: "mem_kept", status: "pending" },
        ],
      });
      const doomed = note();
      const kept = otherNote();
      await h.store.writeNote(doomed);
      await h.store.writeNote(kept);
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));
      await h.outbox.enqueue(forgetRequest("export-window", "client-f2"));

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "synced", pushed: 2, rejected: 0 });
      expect(await h.store.readNote("project", "replay-budget")).toBeNull();
      // A `pending` forget is a proposal the provider has not carried out: the note stays.
      expect(await h.store.readNote("project", "export-window")).toEqual(kept);
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-4: a MEMORY_PUSH_REJECTED refusal keeps its entry with the reason and the drain continues", async () => {
    await withTempDir(async (dir) => {
      const refusal = new NaxError("note kind not available", "MEMORY_PUSH_REJECTED", { stage: "memory" });
      const h = harness(dir, { push: [refusal, ANSWER_ACTIVE] });
      const refused = note();
      const accepted = otherNote();
      await h.store.writeNote(refused);
      await h.store.writeNote(accepted);
      await h.outbox.enqueue(saveRequest(refused, "client-a"));
      await h.outbox.enqueue(saveRequest(accepted, "client-b"));

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "synced", pushed: 1, rejected: 1, pulled: 0, skipped: 0 });
      const remaining = await h.outbox.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({
        clientId: "client-a",
        state: "rejected",
        reason: "note kind not available",
      });
      // The refusal touched nothing mirrored; the entry behind it was delivered.
      expect(await h.store.readNote("project", "replay-budget")).toEqual(refused);
      expect(await h.store.readNote("project", "export-window")).toEqual({
        ...accepted,
        id: ANSWER_ACTIVE.id,
        status: ANSWER_ACTIVE.status,
      });
    });
  });

  test("AC-5: a transient push failure stops the drain, skips the pull and is recorded", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: [new Error("connection reset by peer"), ANSWER_ACTIVE] });
      const queuedA = await h.outbox.enqueue(saveRequest(note(), "client-a"));
      const queuedB = await h.outbox.enqueue(saveRequest(otherNote(), "client-b"));

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "failed", pushed: 0, rejected: 0, error: "connection reset by peer" });
      // The second entry was never attempted, and both stay queued for the next run.
      expect(h.provider.push.mock.calls).toHaveLength(1);
      expect(h.provider.pull).not.toHaveBeenCalled();
      expect(await h.outbox.list()).toEqual([queuedA, queuedB]);
      expect(await recordedSyncState(h.store.paths.syncState)).toMatchObject({
        lastError: "connection reset by peer",
      });
    });
  });

  test("AC-6: a push that never settles is a failed run once the operation deadline fires", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: "hang" });
      const queued = await h.outbox.enqueue(saveRequest(note(), "client-a"));
      const clock = makeFakeClock();

      const running = syncMemory(h.input({ timers: clock }));
      // The probe's timer is cleared before the push: the one timer left is the operation's.
      await waitForCondition(() => h.provider.push.mock.calls.length === 1 && clock.pending() > 0, 5_000);
      expect(clock.pending()).toBe(1);

      await clock.advance(MEMORY_OP_TIMEOUT_MS);
      const result = await running;

      expect(result.outcome).toBe("failed");
      expect(await h.outbox.list()).toEqual([queued]);
      // The timeout the provider never answered was recorded, and nothing is left armed.
      const recorded = await recordedSyncState(h.store.paths.syncState);
      expect(typeof result.error).toBe("string");
      expect(recorded.lastError).toBe(result.error ?? "");
      expect(clock.pending()).toBe(0);
    });
  });

  test("AC-7: a forget left queued by a transient failure is marked in the index", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: new Error("provider unavailable") });
      await h.store.writeNote(note());
      await h.outbox.enqueue(forgetRequest("replay-budget", "client-f1"));

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("failed");
      const index = await readFile(h.store.paths.index, "utf8");
      const line = index.split("\n").find((text) => text.includes("replay-budget"));
      assertDefined(line, "the forgotten note's index line");
      expect(line.endsWith(" (forget pending)")).toBe(true);
    });
  });

  test("an entry an earlier sync rejected is not pushed again", async () => {
    await withTempDir(async (dir) => {
      const refusal = new NaxError("note kind not available", "MEMORY_PUSH_REJECTED", { stage: "memory" });
      const h = harness(dir, { push: [refusal, ANSWER_ACTIVE] });
      await h.outbox.enqueue(saveRequest(note(), "client-a"));

      await syncMemory(h.input());
      // The rejected entry is still on disk; the next run leaves it alone.
      const second = await syncMemory(h.input());

      expect(second).toMatchObject({ outcome: "synced", pushed: 0, rejected: 0 });
      expect(h.provider.push.mock.calls).toHaveLength(1);
      expect(await h.outbox.list()).toMatchObject([{ clientId: "client-a", state: "rejected" }]);
    });
  });

  test("[B4] delivering an older queued write leaves a newer generation that is still queued alone", async () => {
    await withTempDir(async (dir) => {
      // The second push fails, so nothing after the first delivery can repair the mirror: what
      // the drain does with the older entry's answer is the whole of the outcome.
      const h = harness(dir, { push: [ANSWER_ACTIVE, new Error("connection reset by peer")] });
      const older = note({ id: "local-older", body: "older body" });
      const newer = note({ id: "local-newer", body: "newer body" });
      // The mirror holds the newer write — staged by a save that has not been delivered — and
      // the queue holds both it and the older one in front of it.
      await h.store.writeNote(newer);
      await h.outbox.enqueue(saveRequest(older, "local-older"));
      const queued = await h.outbox.enqueue(saveRequest(newer, "local-newer"));

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "failed", pushed: 1, error: "connection reset by peer" });
      // The older delivery's id and status belong to the older note, not to this one.
      expect(await h.store.readNote("project", "replay-budget")).toEqual(newer);
      // The newer write is still waiting, so its copy of the note is the one the next run takes.
      expect(await h.outbox.list()).toEqual([queued]);
    });
  });
});
