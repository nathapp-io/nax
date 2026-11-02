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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  createMemoryOutbox,
  createMemoryStore,
  forgetMemoryNote,
  MEMORY_OP_TIMEOUT_MS,
  type MemoryForgetInput,
  type MemoryForgetResult,
  type MemoryNote,
  type MemoryOutbox,
  type MemoryOutboxEntry,
  type MemoryStore,
  type MemoryWriteRequest,
  NaxError,
} from "@nathapp/nax-agent";
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

describe("forgetMemoryNote", () => {
  test("AC-1: a direct forget the provider answers deletes the note and resolves deleted", async () => {
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

  test("AC-2: a proposal forget pushes the request and leaves the note in place", async () => {
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

  test("a transient push failure is queued under direct, and the note stays retired", async () => {
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
