/**
 * US-018: `forgetMemoryNote` — the bounded forget of one note, and what a provider does
 * with it.
 *
 * A forget only ever acts on a note the mirror holds: an absent slug is a
 * `MEMORY_NOTE_NOT_FOUND` refusal and nothing is touched. Under `direct` the mirror
 * retires the note first — the agent's decision takes effect locally at once — and the
 * note is kept aside, because the one answer that will never change is a permanent
 * refusal and it has to be undone. Under `proposal` the note stays exactly as it was:
 * the forget is a request for approval, so a pending result must not mutate the note it
 * names. The `(forget pending)` marker the index carries comes from the outbox alone.
 *
 * A slug the outbox already holds a queued write for is not pushed at all: the forget
 * joins the queue behind it, so the provider receives the writes in the order the agent
 * made them. Otherwise the provider is probed and then pushed, each through its own race
 * on the injected timers, and anything short of an answer — a probe that said `false`,
 * threw or timed out; a push that threw or timed out — queues the request and reports
 * `delivered: false`. A timeout is exercised here because that is the arm `raceTimeout`
 * owns; the delivered paths and the provider's own answers are exercised beside it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  createMemoryOutbox,
  createMemoryStore,
  forgetMemoryNote,
  MEMORY_FORGET_REASON_MAX_CHARS,
  MEMORY_OP_TIMEOUT_MS,
  MEMORY_PROBE_TIMEOUT_MS,
  type MemoryForgetInput,
  type MemoryForgetResult,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryStore,
  type MemoryWriteRequest,
  NaxError,
  syncMemory,
} from "@nathapp/nax-agent";
import { _atomicWriteDeps } from "#src/internal/atomic-write";
import { _memoryStoreDeps } from "#src/memory/store";
import { acquireSessionLock } from "#src/session-store/index";
import {
  assertDefined,
  assertNaxError,
  type FakeClock,
  firstCall,
  type MemoryProviderMock,
  type MockLogger,
  makeFakeClock,
  makeLogger,
  makeMemoryProvider,
  waitForCondition,
  withDepsRestore,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-09T09:45:00.000Z";
/** The slug every forget here retires. */
const SLUG = "replay-budget";
/** Why the agent is forgetting the note: carried to the provider, and onto a queued entry. */
const REASON = "the replay budget was retired in 0.92";
/** A UUID: the shape of the id a forget mints for the request it makes. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A store whose writes are refused reports this: the mirror cannot be written to. */
const MIRROR_READ_ONLY = "mirror is read-only";
/** What a full disk reports: a write-ahead entry that cannot be stored. */
const ENOSPC = "ENOSPC: no space left on device";
/** What a queue directory the process may not write reports: a refused entry that stays. */
const OUTBOX_READ_ONLY = "EACCES: the outbox is read-only";

/** The note already in the mirror: what a forget acts on, and what a refusal must put back. */
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

/** A provider refusal: the write will never be accepted, so retrying it is pointless. */
function refusal(reason = "note is pinned"): NaxError {
  return new NaxError(reason, "MEMORY_PUSH_REJECTED", { stage: "memory" });
}

/** The pieces one forget runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  readonly clock: FakeClock;
  /** The forget's input: this harness's pieces, plus any per-test override. */
  forget(overrides?: Partial<MemoryForgetInput>): Promise<MemoryForgetResult>;
}

function harness(dir: string, script: Parameters<typeof makeMemoryProvider>[0] = {}): Harness {
  const logger = makeLogger();
  const clock = makeFakeClock();
  const store = createMemoryStore({ projectDir: join(dir, "project"), logger });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const provider = makeMemoryProvider(script);
  return {
    store,
    outbox,
    provider,
    logger,
    clock,
    forget: (overrides = {}) =>
      forgetMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now: () => new Date(STAMP),
        timers: clock,
        scope: "project",
        slug: SLUG,
        reason: REASON,
        writeMode: "direct",
        ...overrides,
      }),
  };
}

/** The one push a forget made, asserted to have happened and to carry a forget request. */
function pushedRequest(h: Harness): MemoryWriteRequest {
  expect(h.provider.push).toHaveBeenCalledTimes(1);
  const [request] = firstCall(h.provider.push, "provider push");
  return request;
}

/** The outbox's one queued entry, asserted to be the only one. */
async function soleEntry(h: Harness): Promise<MemoryOutboxEntry> {
  const entries = await h.outbox.list();
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  assertDefined(entry, "queued outbox entry");
  return entry;
}

/** The index line of the forgotten slug, whichever section rendered it. */
async function indexLineFor(h: Harness, slug: string): Promise<string> {
  const index = await readFile(h.store.paths.index, "utf8");
  const line = index.split("\n").find((text) => text.includes(slug));
  assertDefined(line, `index line for "${slug}"`);
  return line;
}

/** A pid no test process has: the file a second process's owner would leave behind. */
const FOREIGN_PID = 8412;

/** A fake-clock step wide enough to fire any poll a fenced forget is waiting on. */
const POLL_STEP_MS = 1_000;

/**
 * The store's lock, held the way an owner holds it: `pid` and the liveness probe that decides
 * whether that owner is still there. Releasing it is the caller's job. (The save suite holds
 * the same lock the same way; the protocol is real, only its holder is scripted.)
 */
async function heldLock(h: Harness, pid: number, isAlive: (pid: number) => boolean): Promise<() => Promise<void>> {
  await mkdir(h.store.paths.projectDir, { recursive: true });
  const deps = { dir: h.store.paths.projectDir, pid, now: () => new Date(STAMP), logger: h.logger, isAlive };
  return acquireSessionLock(h.store.paths.lock, deps, isAlive);
}

/** A sync of this process parked on its probe: it owns the mirror and this process's pid. */
function parkedSync(h: Harness, clock: FakeClock): Promise<{ readonly outcome: string }> {
  return syncMemory({
    store: h.store,
    outbox: h.outbox,
    provider: makeMemoryProvider({ reachable: "hang" }),
    logger: h.logger,
    now: () => new Date(STAMP),
    pid: process.pid,
    isAlive: () => true,
    timers: clock,
  });
}

/** The nonce of the lock file on disk: the same nonce means the lock was never taken over. */
async function lockNonce(h: Harness): Promise<string> {
  const held = JSON.parse(await readFile(h.store.paths.lock, "utf8"));
  assertDefined(held.nonce, "lock nonce");
  return held.nonce;
}

describe("forgetMemoryNote", () => {
  withDepsRestore(_memoryStoreDeps);

  test("AC-1 / US-004 AC-4: a direct forget the provider answers deletes the note and resolves deleted", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "deleted" } });
      await h.store.writeNote(note());

      const result = await h.forget();

      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: true });
      // The mirror no longer holds it: the file itself is gone, not only its status.
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(existsSync(join(h.store.paths.notesDir, `${SLUG}.md`))).toBe(false);
      // Probed once and pushed once, both races clearing the timer they armed.
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
      expect(h.clock.pending()).toBe(0);
    });
  });

  test("AC-1: the pushed request is a forget carrying the reason and a UUID client id", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "deleted" } });
      await h.store.writeNote(note());

      await h.forget();

      const request = pushedRequest(h);
      expect(request.kind).toBe("forget");
      expect(request.reason).toBe(REASON);
      expect(request.clientId).toMatch(UUID_RE);
      expect(request).toMatchObject({ scope: "project", slug: SLUG, writeMode: "direct" });
      // A forget names a slug; it never carries a note.
      expect(request).not.toHaveProperty("note");
      // A delivered forget leaves nothing behind for a sync to replay.
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-2 / US-004 AC-5: a proposal forget pushes the request and leaves the note in place", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "pending" } });
      const existing = note();
      await h.store.writeNote(existing);

      const result = await h.forget({ writeMode: "proposal" });

      expect(result).toEqual({ slug: SLUG, status: "pending", delivered: true });
      // A proposal is a request: the note it names is untouched, status included.
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
      const request = pushedRequest(h);
      expect(request).toMatchObject({ kind: "forget", writeMode: "proposal", slug: SLUG, reason: REASON });
      expect(request.clientId).toMatch(UUID_RE);
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-2: the pending result does not write a status onto the preserved note", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "pending" } });
      await h.store.writeNote(note({ status: "active" }));

      const result = await h.forget({ writeMode: "proposal" });

      expect(result.status).toBe("pending");
      // Read back from disk: still active, still the note the mirror held.
      const stored = await h.store.readNote("project", SLUG);
      assertDefined(stored, "preserved note");
      expect(stored.status).toBe("active");
      expect(existsSync(join(h.store.paths.notesDir, `${SLUG}.md`))).toBe(true);
    });
  });

  test("AC-3: an absent slug is a MEMORY_NOTE_NOT_FOUND refusal, and nothing is touched", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);

      const caught = await h.forget().catch((error: unknown) => error);

      assertNaxError(caught, "forget of an absent slug");
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
      expect(caught.context).toMatchObject({ stage: "memory", scope: "project", slug: SLUG });
      // The provider is never asked about a note this mirror does not hold.
      expect(h.provider.reachable).not.toHaveBeenCalled();
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-4: an unreachable provider queues the forget and reports it undelivered", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });
      await h.store.writeNote(note());

      const result = await h.forget();

      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: false });
      // The probe already answered: nothing was pushed.
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
      expect(h.provider.push).not.toHaveBeenCalled();
      const entry = await soleEntry(h);
      expect(entry).toMatchObject({
        kind: "forget",
        scope: "project",
        slug: SLUG,
        reason: REASON,
        writeMode: "direct",
        state: "queued",
      });
      expect(entry.clientId).toMatch(UUID_RE);
      // Direct retires the mirror at once; the queue is what tells the provider later.
      expect(await h.store.readNote("project", SLUG)).toBeNull();
    });
  });

  test("AC-4: a probe that throws is the same fact as an unreachable one", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: new Error("ECONNREFUSED 127.0.0.1:8443") });
      await h.store.writeNote(note());

      const result = await h.forget({ writeMode: "proposal" });

      expect(result).toEqual({ slug: SLUG, status: "pending", delivered: false });
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(await soleEntry(h)).toMatchObject({ kind: "forget", slug: SLUG, state: "queued" });
      // A proposal keeps the note, so the mirror still has it to forget on approval.
      expect(await h.store.readNote("project", SLUG)).toEqual(note());
    });
  });

  test("AC-4: a push that never settles is queued once the operation deadline fires", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: "hang" });
      await h.store.writeNote(note());

      const forgetting = h.forget({ writeMode: "proposal" });
      // The probe's timer is cleared before the push: the one left armed is the operation's.
      await waitForCondition(() => h.provider.push.mock.calls.length === 1 && h.clock.pending() > 0, 5_000);
      expect(h.clock.pending()).toBe(1);
      await h.clock.advance(MEMORY_OP_TIMEOUT_MS);
      const result = await forgetting;

      expect(result).toEqual({ slug: SLUG, status: "pending", delivered: false });
      expect(await soleEntry(h)).toMatchObject({ kind: "forget", slug: SLUG, state: "queued" });
      // The race cleared the deadline it armed.
      expect(h.clock.pending()).toBe(0);
    });
  });

  test("AC-5: an undelivered proposal forget marks the slug (forget pending) in the index", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });
      await h.store.writeNote(note());

      await h.forget({ writeMode: "proposal" });

      const line = await indexLineFor(h, SLUG);
      // The marker is the outbox speaking, not the note's status: the note still reads active.
      expect(line.endsWith(" (forget pending)")).toBe(true);
      expect(line).toContain(SLUG);
      expect(await h.store.readNote("project", SLUG)).toMatchObject({ status: "active" });
    });
  });

  test("AC-6: a direct forget the provider refuses puts the note back and rethrows", async () => {
    await withTempDir(async (dir) => {
      const rejected = refusal();
      const h = harness(dir, { push: rejected });
      const existing = note();
      await h.store.writeNote(existing);

      const caught = await h.forget().catch((error: unknown) => error);

      // The provider's own error reaches the caller; a refusal is not the mirror's to soften.
      expect(caught).toBe(rejected);
      assertNaxError(caught, "rejected forget");
      expect(caught.message).toBe("note is pinned");
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
      // Retrying would repeat the refusal, so nothing is queued.
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("[B6] a forget whose request cannot be queued leaves the note where it was", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { reachable: false });
      const existing = note();
      await h.store.writeNote(existing);
      // The provider is unreachable, so the request has to reach the queue — and the queue is
      // full. The intent must be durable before the note is touched, so this fails as a whole
      // rather than leaving a retire nothing records.
      const realOpen = _atomicWriteDeps.open;
      _atomicWriteDeps.open = async (path, flags, mode) => {
        if (String(path).startsWith(h.store.paths.outboxDir)) throw new Error(ENOSPC);
        return realOpen(path, flags, mode);
      };

      const caught = await h.forget().catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toContain(ENOSPC);
      // The mirror is exactly as it was: no retire, and nothing queued to replay one.
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
      expect(await h.outbox.list()).toEqual([]);

      // And the state is recoverable: the same forget goes through once the queue can take it.
      _atomicWriteDeps.open = realOpen;
      const result = await h.forget();

      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: false });
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(await soleEntry(h)).toMatchObject({ kind: "forget", slug: SLUG, state: "queued" });
    });
  });

  test("AC-6: a proposal forget the provider refuses rethrows and changes nothing", async () => {
    await withTempDir(async (dir) => {
      const rejected = refusal("slug is reserved");
      const h = harness(dir, { push: rejected });
      await h.store.writeNote(note());

      const caught = await h.forget({ writeMode: "proposal" }).catch((error: unknown) => error);

      assertNaxError(caught, "rejected proposal forget");
      expect(caught).toBe(rejected);
      // Nothing was retired, so there is nothing to put back — and nothing to queue.
      expect(await h.store.readNote("project", SLUG)).toEqual(note());
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-7: a slug the outbox already holds is queued behind it, and nothing is pushed", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      const waiting = await h.outbox.enqueue({
        kind: "forget",
        clientId: "client-waiting",
        scope: "project",
        slug: SLUG,
        writeMode: "proposal",
        reason: "an earlier reason",
      });

      const result = await h.forget({ writeMode: "proposal" });

      expect(result).toEqual({ slug: SLUG, status: "pending", delivered: false });
      // The queue already holds this key: pushing it now would deliver it out of order.
      expect(h.provider.reachable).not.toHaveBeenCalled();
      expect(h.provider.push).not.toHaveBeenCalled();
      const entries = await h.outbox.list();
      expect(entries.map((entry) => entry.clientId)).toEqual(["client-waiting", expect.any(String)]);
      const queued = entries[1];
      assertDefined(queued, "queued-behind entry");
      expect(queued.seq).toBeGreaterThan(waiting.seq);
      expect(queued).toMatchObject({ kind: "forget", slug: SLUG, reason: REASON, state: "queued" });
    });
  });

  test("AC-7: a direct forget of a key the queue already holds retires the mirror and queues behind it", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      const waiting = await h.outbox.enqueue({
        kind: "save",
        clientId: "client-waiting",
        scope: "project",
        slug: SLUG,
        writeMode: "direct",
        note: note({ description: "a newer local write" }),
      });

      const result = await h.forget();

      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: false });
      expect(h.provider.push).not.toHaveBeenCalled();
      // Direct is the agent's own decision, so the mirror retires the note before the queue is consulted.
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      const entries = await h.outbox.list();
      expect(entries).toHaveLength(2);
      const queued = entries[1];
      assertDefined(queued, "queued forget");
      expect(queued).toMatchObject({ kind: "forget", slug: SLUG, reason: REASON, state: "queued" });
      expect(queued.seq).toBeGreaterThan(waiting.seq);
    });
  });

  test("AC-8: forgetMemoryNote is exported from the public entry", () => {
    expect(typeof pub.forgetMemoryNote).toBe("function");
    expect(pub.forgetMemoryNote).toBe(forgetMemoryNote);
  });

  test("US-004 AC-10: a transient push failure is queued under direct, and the note stays retired", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: new Error("connection reset by peer") });
      await h.store.writeNote(note());

      const result = await h.forget();

      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: false });
      // Only a permanent refusal is undone; a transient failure leaves the decision standing.
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(await soleEntry(h)).toMatchObject({ kind: "forget", slug: SLUG, state: "queued", reason: REASON });
    });
  });

  test("[B9] a refusal whose entry cannot be removed still restores the note and keeps the refusal", async () => {
    await withTempDir(async (dir) => {
      const rejected = refusal();
      const h = harness(dir, { push: rejected });
      await h.store.writeNote(note());
      const realRm = _memoryStoreDeps.rm;
      // The queue cannot take the refused entry back off: that is bookkeeping, and it must not
      // decide whether the note the forget deleted is put back, nor what error the caller sees.
      _memoryStoreDeps.rm = async (path, options) => {
        if (String(path).startsWith(h.store.paths.outboxDir)) throw new Error(OUTBOX_READ_ONLY);
        return realRm(path, options);
      };

      const caught = await h.forget().catch((error: unknown) => error);

      assertNaxError(caught, "rejected forget");
      expect(caught).toBe(rejected);
      expect(await h.store.readNote("project", SLUG)).toEqual(note());
      const warns = h.logger.calls.filter((call) => call.level === "warn");
      expect(warns.map((call) => call.message)).toContain(
        "memory operation could not take a refused write off the queue",
      );
      // The entry the queue could not give up is what the next sync marks rejected.
      expect(await soleEntry(h)).toMatchObject({ kind: "forget", slug: SLUG, state: "queued" });
    });
  });

  test("a restore that fails is logged, and the refusal still reaches the caller", async () => {
    await withTempDir(async (dir) => {
      const rejected = refusal();
      const h = harness(dir, { push: rejected });
      await h.store.writeNote(note());
      const store: MemoryStore = {
        ...h.store,
        writeNote: async () => {
          throw new Error(MIRROR_READ_ONLY);
        },
      };

      const caught = await h.forget({ store }).catch((error: unknown) => error);

      assertNaxError(caught, "rejected forget");
      expect(caught).toBe(rejected);
      // The restore failed, so the note is still gone — and that was reported, not thrown.
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      const warns = h.logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatchObject({
        stage: "memory",
        message: "memory forget could not restore the note",
        data: { slug: SLUG, error: MIRROR_READ_ONLY },
      });
    });
  });
});

/**
 * US-004: a provider that holds the forget instead of carrying it out.
 *
 * `pending` is not a retire: the provider recorded the request and has not acted on it, so
 * under `direct` the note the forget already deleted has to come back. The order is the
 * assertion in AC-3 — the note is written before the index is rendered, so the index the
 * next session reads still lists it.
 */
describe("US-004: a direct forget the provider holds pending", () => {
  test("AC-1/AC-2: the note is put back exactly as it was, and nothing is left queued", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "pending" } });
      const existing = note();
      await h.store.writeNote(existing);

      const result = await h.forget();

      // The provider answered, it just has not carried the retire out.
      expect(result).toEqual({ slug: SLUG, status: "pending", delivered: true });
      // The answer is not a delete: the mirror keeps the note it had, field for field.
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
      expect(existsSync(join(h.store.paths.notesDir, `${SLUG}.md`))).toBe(true);
      // Accepted, so the request comes off the queue: there is nothing left to replay.
      expect(await h.outbox.list()).toEqual([]);
    });
  });

  test("AC-3: the note is restored before the index is refreshed, so the index still lists it", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "pending" } });
      await h.store.writeNote(note());

      await h.forget();

      // A refresh that ran before the restore would render a mirror without the note.
      const line = await indexLineFor(h, SLUG);
      expect(line).toContain(SLUG);
      expect(line.endsWith(" (forget pending)")).toBe(false);
    });
  });
});

describe("forgetMemoryNote and the mirror's lock", () => {
  test("[F1] a forget waits for the mirror's live holder before retiring the note or queueing", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      const owner = await heldLock(h, FOREIGN_PID, () => true);

      const forgetting = h.forget({ isAlive: () => true });
      // The owner has the mirror: nothing is retired, nothing is queued, and the wait is a poll
      // on this operation's own timers.
      await waitForCondition(() => h.clock.pending() > 0, 5_000);
      expect(await h.store.readNote("project", SLUG)).toEqual(note());
      expect(await h.outbox.list()).toEqual([]);
      expect(h.provider.push).not.toHaveBeenCalled();

      await owner();
      await h.clock.advance(POLL_STEP_MS);
      const result = await forgetting;

      // Handed over: the forget takes its turn, then releases what it took.
      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: true });
      expect(await h.store.readNote("project", SLUG)).toBeNull();
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });

  test("[F1] a forget whose own process is syncing the mirror queues instead of taking the lock over", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      await h.store.writeNote(note());
      const clock = makeFakeClock();
      const running = parkedSync(h, clock);
      await waitForCondition(() => clock.pending() > 0, 5_000);
      const nonce = await lockNonce(h);

      const result = await h.forget();

      expect(result).toEqual({ slug: SLUG, status: "deleted", delivered: false });
      // The sync owns the mirror: this forget neither deletes from it nor renders its index.
      expect(await h.store.readNote("project", SLUG)).toEqual(note());
      expect(existsSync(h.store.paths.index)).toBe(false);
      // Our own pid is not permission to steal the lock the sync still believes it holds.
      expect(await lockNonce(h)).toBe(nonce);
      const entries = await h.outbox.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "forget", slug: SLUG, reason: REASON, state: "queued" });
      // The sync ends unreachable and hands the lock back, so the mirror is free again.
      await clock.advance(MEMORY_PROBE_TIMEOUT_MS);
      expect((await running).outcome).toBe("unreachable");
      expect(existsSync(h.store.paths.lock)).toBe(false);
    });
  });

  test("[F1] a reason over the cap is refused, reported MEMORY_WRITE_REFUSED, and nothing is persisted", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: { id: "mem_1", status: "deleted" } });
      const existing = note();
      await h.store.writeNote(existing);

      const overLong = "a".repeat(MEMORY_FORGET_REASON_MAX_CHARS + 1);
      const caught = await h.forget({ reason: overLong }).catch((error: unknown) => error);

      assertNaxError(caught, "forget with an over-long reason");
      expect(caught.code).toBe("MEMORY_WRITE_REFUSED");
      expect(caught.message).toBe(`reason must be at most ${MEMORY_FORGET_REASON_MAX_CHARS} characters`);
      // Refused before the mirror or the queue is touched: no entry, no probe, no push.
      expect(await h.outbox.list()).toEqual([]);
      expect(h.provider.reachable).not.toHaveBeenCalled();
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(await h.store.readNote("project", SLUG)).toEqual(existing);
    });
  });

  test("[F1] a fenced forget still refuses a slug the mirror does not hold", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const clock = makeFakeClock();
      const running = parkedSync(h, clock);
      await waitForCondition(() => clock.pending() > 0, 5_000);

      const caught = await h.forget().catch((error: unknown) => error);

      assertNaxError(caught, "fenced forget of an absent slug");
      expect(caught.code).toBe("MEMORY_NOTE_NOT_FOUND");
      // Nothing is queued for a note that does not exist, whichever writer owns the mirror.
      expect(await h.outbox.list()).toEqual([]);
      await clock.advance(MEMORY_PROBE_TIMEOUT_MS);
      expect((await running).outcome).toBe("unreachable");
    });
  });
});
