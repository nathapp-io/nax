/**
 * US-012: step 2 of a sync — the probe, bounded by the cancellable timeout race —
 * and the `raceTimeout` primitive itself.
 *
 * The race arms its timer only after the run has done its real awaits (the lock,
 * the directory, the outbox), so a test that drives it on a fake clock first waits
 * for the timer to appear, then advances the clock, then awaits the run: `advance`
 * drains microtasks only, and everything after the race is filesystem I/O.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_PROBE_TIMEOUT_MS,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryStore,
  type MemorySyncState,
  type MemoryTimers,
  type MemoryWriteRequest,
  raceTimeout,
  syncMemory,
} from "@nathapp/nax-agent";
import type { MemorySyncInput } from "#src/memory/index";
import {
  assertNaxError,
  type FakeClock,
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
const STAMP = "2026-11-02T08:11:00.000Z";
/** The pid each harness claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 4343;

/** The sync state a run finds already on disk: a previous sync, with both cursors set. */
const PREVIOUS_STATE: MemorySyncState = {
  provider: "scripted",
  cursor: { project: "cursor-project", user: "cursor-user" },
  lastPullAt: "2026-11-01T09:00:00.000Z",
  lastError: "previous failure",
};

/** The note a queued write carries; the outbox is asked to deliver it, never to lose it. */
function note(): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: STAMP,
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
  };
}

/** A queued `save` request: what an unreachable run must leave exactly as it found it. */
function saveRequest(): Omit<MemoryWriteRequest, "clientId"> & { clientId: string } {
  return {
    kind: "save",
    clientId: "client-1",
    scope: "project",
    slug: "replay-budget",
    writeMode: "direct",
    note: note(),
  };
}

/** The pieces one sync runs against, all pointed at `<dir>/project`. */
interface ProbeHarness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  input(overrides?: Partial<MemorySyncInput>): MemorySyncInput;
}

function probeHarness(dir: string, script: MemoryProviderScript = {}): ProbeHarness {
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
      // A holder nobody's pid proves live is a stale one: this run takes the lock over.
      isAlive: () => false,
      ...overrides,
    }),
  };
}

/** A fake clock behind a recording `MemoryTimers`: the ids armed and the ids cleared. */
function recordingTimers(clock: FakeClock): {
  readonly timers: MemoryTimers;
  readonly armed: unknown[];
  readonly cleared: unknown[];
} {
  const armed: unknown[] = [];
  const cleared: unknown[] = [];
  return {
    armed,
    cleared,
    timers: {
      setTimeout: (callback, ms) => {
        const id: unknown = clock.setTimeout(callback, ms);
        armed.push(id);
        return id;
      },
      clearTimeout: (id) => {
        cleared.push(id);
        if (typeof id === "number") clock.clearTimeout(id);
      },
    },
  };
}

/** The state a `sync.json` on disk holds. */
async function recordedSyncState(path: string): Promise<MemorySyncState> {
  const parsed: MemorySyncState = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

/** A promise that never settles: what a provider that has stopped answering hands back. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe("raceTimeout", () => {
  test("AC-1: resolves with the promise's value and clears the timer it armed", async () => {
    const clock = makeFakeClock();
    const { timers, armed, cleared } = recordingTimers(clock);
    const answer = Promise.withResolvers<boolean>();

    const raced = raceTimeout(answer.promise, MEMORY_PROBE_TIMEOUT_MS, timers);
    expect(armed).toHaveLength(1);
    answer.resolve(true);

    expect(await raced).toBe(true);
    // The id `setTimeout` returned is the id `clearTimeout` was given.
    expect(cleared).toEqual(armed);
  });

  test("AC-2: rejects with NaxError MEMORY_TIMEOUT when the clock passes the deadline first", async () => {
    const clock = makeFakeClock();
    const { timers } = recordingTimers(clock);

    const raced = raceTimeout(neverSettles<boolean>(), MEMORY_PROBE_TIMEOUT_MS, timers);
    // The rejection is handled from the start: the loser of a race is nobody's to await.
    const handled = raced.catch((error: unknown) => error);
    await clock.advance(MEMORY_PROBE_TIMEOUT_MS - 1);
    expect(await Promise.race([raced.then(() => "settled"), Promise.resolve("running")])).toBe("running");

    await clock.advance(1);
    const caught = await handled;

    assertNaxError(caught, "raceTimeout rejection");
    expect(caught.code).toBe("MEMORY_TIMEOUT");
    expect(caught.context).toMatchObject({ stage: "memory", timeoutMs: MEMORY_PROBE_TIMEOUT_MS });
  });

  test("AC-3: a fake clock stands in for MemoryTimers and is left with nothing pending", async () => {
    const fake = makeFakeClock();
    const timers: MemoryTimers = fake;
    const answer = Promise.withResolvers<number>();

    // Resolved first: the deadline was armed and cleared, so nothing is left behind.
    const done = raceTimeout(answer.promise, MEMORY_PROBE_TIMEOUT_MS, timers);
    expect(fake.pending()).toBe(1);
    answer.resolve(7);
    expect(await done).toBe(7);
    expect(fake.pending()).toBe(0);

    // Timed out first: the timer fired, and firing removes it.
    const timedOut = raceTimeout(neverSettles<number>(), MEMORY_PROBE_TIMEOUT_MS, timers).catch(
      (error: unknown) => error,
    );
    expect(fake.pending()).toBe(1);
    await fake.advance(MEMORY_PROBE_TIMEOUT_MS);
    assertNaxError(await timedOut, "raceTimeout rejection");
    expect(fake.pending()).toBe(0);
  });
});

describe("syncMemory step 2 (probe)", () => {
  test("AC-4: reachable() false is unreachable — no push, no pull, outbox untouched, cursors kept", async () => {
    await withTempDir(async (dir) => {
      const h = probeHarness(dir, { reachable: false });
      await h.store.writeSyncState(PREVIOUS_STATE);
      const queued = await h.outbox.enqueue(saveRequest());

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(h.provider.pull).not.toHaveBeenCalled();
      expect(await h.outbox.list()).toEqual([queued]);
      // Only the error changed: the cursors a failed probe learned nothing about carry over.
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        ...PREVIOUS_STATE,
        lastError: "unreachable",
      });
    });
  });

  test("AC-5: reachable() that rejects is unreachable, and the record says so", async () => {
    await withTempDir(async (dir) => {
      const h = probeHarness(dir, { reachable: new Error("connection refused") });
      await h.store.writeSyncState(PREVIOUS_STATE);

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(h.provider.pull).not.toHaveBeenCalled();
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        ...PREVIOUS_STATE,
        lastError: "unreachable",
      });
    });
  });

  test("AC-6: reachable() that never settles is unreachable once the probe deadline fires", async () => {
    await withTempDir(async (dir) => {
      const h = probeHarness(dir, { reachable: "hang" });
      const clock = makeFakeClock();

      const running = syncMemory(h.input({ timers: clock }));
      await waitForCondition(() => clock.pending() > 0, 5_000);
      expect(clock.pending()).toBe(1);

      await clock.advance(MEMORY_PROBE_TIMEOUT_MS);
      const result = await running;

      expect(result).toEqual({ outcome: "unreachable", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(h.provider.pull).not.toHaveBeenCalled();
      // The race cleared what it armed: the timed-out provider left no live timer behind.
      expect(clock.pending()).toBe(0);
      expect((await recordedSyncState(h.store.paths.syncState)).lastError).toBe("unreachable");
    });
  });

  test("AC-7: raceTimeout is exported from @nathapp/nax-agent", () => {
    expect(typeof pub.raceTimeout).toBe("function");
    expect(pub.raceTimeout).toBe(raceTimeout);
  });
});
