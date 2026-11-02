/**
 * US-016: `saveMemoryNote` — the validated, delivered save.
 *
 * A save validates before it touches anything: a refused write is a
 * `MEMORY_WRITE_REFUSED` throw carrying the validator's own reason, with no note,
 * no outbox entry and no index written. A write that passes is staged in the
 * mirror under a freshly minted id (the client id the provider is asked with),
 * pushed through the probe and the operation race, and rewritten with the id and
 * status the provider answered. The index is refreshed before the call returns,
 * so the next session reads the note the save just made.
 *
 * The provider, the store and the index are the seams these tests read: the
 * validator's rules are exercised in `validate.test.ts`, so a refusal here is
 * only ever compared against `validateMemoryNoteWrite`'s own answer, never
 * restated.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as pub from "@nathapp/nax-agent";
import {
  createMemoryOutbox,
  createMemoryStore,
  MEMORY_NOTE_BODY_MAX_BYTES,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryPushResult,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  type MemoryWriteRequest,
  saveMemoryNote,
  validateMemoryNoteWrite,
} from "@nathapp/nax-agent";
import {
  assertCaughtInstanceOf,
  assertDefined,
  assertNaxError,
  type FakeClock,
  firstCall,
  type MemoryProviderMock,
  type MockLogger,
  makeFakeClock,
  makeLogger,
  makeMemoryProvider,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-07T10:15:00.000Z";
/** The label every save in these tests is made under. */
const SOURCE = "nax-chat";
/** A UUID: the shape of the id a save mints for the note it stages. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What the provider answers a delivered direct save: the note is live under its own id. */
const ANSWER_ACTIVE: MemoryPushResult = { id: "mem_1", status: "active" };
/** What a store whose writes are refused reports: the mirror cannot be written to. */
const MIRROR_READ_ONLY = "mirror is read-only";

/** The write a save carries: the example note from the memory-store design. */
function write(overrides: Partial<MemoryNoteWrite> = {}): MemoryNoteWrite {
  return {
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** The note already in the mirror: what a refused save must leave exactly as it was. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_existing",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 1,024 MiB",
    source: "nax-run",
    updatedAt: "2026-11-01T09:00:00.000Z",
    status: "active",
    body: "The replay budget stays at 1,024 MiB.",
    ...overrides,
  };
}

/** The pieces one save runs against, all pointed at `<dir>/project`. */
interface Harness {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProviderMock;
  readonly logger: MockLogger;
  readonly clock: FakeClock;
  /** The save's input: this harness's pieces, plus any per-test override. */
  save(overrides?: Partial<MemorySaveInput>): Promise<MemorySaveResult>;
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
    save: (overrides = {}) =>
      saveMemoryNote({
        store,
        outbox,
        provider,
        logger,
        now: () => new Date(STAMP),
        timers: clock,
        write: write(),
        writeMode: "direct",
        source: SOURCE,
        ...overrides,
      }),
  };
}

/** What one push saw: the request it was handed, and the mirror as it stood at that instant. */
interface PushSighting {
  request?: MemoryWriteRequest;
  mirrored: MemoryNote | null;
}

/** A provider whose push records {@link PushSighting} before answering `answer`. */
function observingProvider(
  read: () => Promise<MemoryNote | null>,
  answer: MemoryPushResult,
): { readonly provider: MemoryProviderMock; readonly sighting: PushSighting } {
  const sighting: PushSighting = { mirrored: null };
  const provider = makeMemoryProvider({
    push: async (request): Promise<MemoryPushResult> => {
      sighting.request = request;
      sighting.mirrored = await read();
      return answer;
    },
  });
  return { provider, sighting };
}

/**
 * The same store, with `writeNote` failing on exactly its `call`-th call.
 *
 * The save writes the mirror more than once — the staged note, then whatever the
 * provider made of it, and possibly a rollback — so which write fails is what
 * separates "the provider never took it" from "the provider took it and the
 * bookkeeping did not".
 */
function storeFailingWrite(store: MemoryStore, call: number): MemoryStore {
  let writes = 0;
  return {
    ...store,
    writeNote: async (written) => {
      writes += 1;
      if (writes === call) throw new Error(MIRROR_READ_ONLY);
      await store.writeNote(written);
    },
  };
}

describe("saveMemoryNote", () => {
  test("AC-1: a valid direct save the provider answers resolves delivered with the provider's status", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });

      const result = await h.save();

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      // Probed, then pushed once; both races cleared the timer they armed.
      expect(h.provider.reachable).toHaveBeenCalledTimes(1);
      expect(h.provider.push).toHaveBeenCalledTimes(1);
      expect(h.clock.pending()).toBe(0);
    });
  });

  test("AC-2: the mirror keeps the provider's id and status beside the caller's source and clock", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });

      await h.save();

      expect(await h.store.readNote("project", "replay-budget")).toEqual({
        id: "mem_1",
        slug: "replay-budget",
        type: "project",
        scope: "project",
        description: "replay budget stays 2,048 MiB",
        source: SOURCE,
        updatedAt: STAMP,
        status: "active",
        body: "The replay budget stays at 2,048 MiB.",
      });
    });
  });

  test("AC-3: push carries a save request keyed by the note's id, whose note is the mirrored one", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { provider, sighting } = observingProvider(
        () => h.store.readNote("project", "replay-budget"),
        ANSWER_ACTIVE,
      );

      await h.save({ provider });

      const { request } = sighting;
      assertDefined(request, "recorded push request");
      const mirroredAtPush = sighting.mirrored;
      assertDefined(mirroredAtPush, "mirror at push time");
      expect(request.kind).toBe("save");
      expect(request.writeMode).toBe("direct");
      expect(request.slug).toBe("replay-budget");
      expect(request.scope).toBe("project");
      // The request is keyed by the id the note was staged under, and that id is a UUID.
      expect(request.clientId).toBe(mirroredAtPush.id);
      expect(request.clientId).toHaveLength(36);
      expect(request.clientId).toMatch(UUID_RE);
      // What was pushed is the mirror as it stood, before the answer was applied.
      expect(request.note).toEqual(mirroredAtPush);
      expect(request.note?.status).toBe("active");
      // Only afterwards does the provider's id land in the mirror.
      expect((await h.store.readNote("project", "replay-budget"))?.id).toBe(ANSWER_ACTIVE.id);
    });
  });

  test("AC-4: a proposal is mirrored pending before the push and resolves the provider's pending", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { provider, sighting } = observingProvider(() => h.store.readNote("project", "replay-budget"), {
        id: "mem_2",
        status: "pending",
      });

      const result = await h.save({ provider, writeMode: "proposal" });

      expect(result).toEqual({ slug: "replay-budget", status: "pending", delivered: true });
      // The note was already a proposal when the provider was asked, and it was asked as one.
      expect(sighting.mirrored?.status).toBe("pending");
      expect(sighting.request?.writeMode).toBe("proposal");
      expect(sighting.request?.note?.status).toBe("pending");
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({ id: "mem_2", status: "pending" });
    });
  });

  test("AC-5: a body carrying a GitHub token is refused, and nothing is written", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const token = "ghp_abcdefghijklmnopqrstu";

      const caught = await h
        .save({ write: write({ body: `the deploy key is ${token}` }) })
        .catch((error: unknown) => error);

      assertNaxError(caught, "refused save");
      expect(caught.code).toBe("MEMORY_WRITE_REFUSED");
      // The reason names the pattern's kind and never the token itself.
      expect(caught.message).toContain("github");
      expect(caught.message).not.toContain(token);
      expect(caught.context).toMatchObject({ stage: "memory", field: "body" });
      expect(existsSync(join(h.store.paths.notesDir, "replay-budget.md"))).toBe(false);
      expect(await h.outbox.list()).toEqual([]);
      // Validation is ahead of every seam: no provider was asked and no index was written.
      expect(h.provider.reachable).not.toHaveBeenCalled();
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(existsSync(h.store.paths.index)).toBe(false);
    });
  });

  test("AC-6: a delivered save leaves the new slug in the index the next session reads", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });

      await h.save();

      const index = await readFile(h.store.paths.index, "utf8");
      expect(index).toContain("replay-budget");
      // An active note is not marked pending, so the line carries no marker.
      expect(index).toContain("- [project] replay-budget");
      expect(index).not.toContain("(pending)");
    });
  });

  test("AC-7: saveMemoryNote is exported from the public entry", () => {
    expect(typeof pub.saveMemoryNote).toBe("function");
    expect(pub.saveMemoryNote).toBe(saveMemoryNote);
  });

  test.each([
    ["a bad slug", { write: write({ slug: "Replay_Budget" }), source: SOURCE }],
    ["a bad description", { write: write({ description: "one line\nand another" }), source: SOURCE }],
    ["a bad source", { write: write(), source: "nax-chat\nnax-run" }],
    ["an oversized body", { write: write({ body: "é".repeat(MEMORY_NOTE_BODY_MAX_BYTES / 2 + 1) }), source: SOURCE }],
  ])("AC-8: %s is refused with the validator's first reason and changes nothing", async (_label, attempt) => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const existing = note();
      await h.store.writeNote(existing);
      const queued = await h.outbox.enqueue({
        kind: "save",
        clientId: "client-queued",
        scope: "project",
        slug: "export-window",
        writeMode: "direct",
      });
      const refusal = validateMemoryNoteWrite(attempt.write, attempt.source);
      assertDefined(refusal, "validator refusal");

      const caught = await h.save(attempt).catch((error: unknown) => error);

      assertNaxError(caught, "refused save");
      expect(caught.code).toBe("MEMORY_WRITE_REFUSED");
      // The operation adds no second opinion: the message is the validator's own reason.
      expect(caught.message).toBe(refusal.reason);
      expect(caught.context).toMatchObject({ stage: "memory", field: refusal.field });
      expect(await h.store.readNote("project", "replay-budget")).toEqual(existing);
      expect(await h.outbox.list()).toEqual([queued]);
      expect(h.provider.push).not.toHaveBeenCalled();
    });
  });

  test("F2: a mirror write that fails after the provider accepted the save keeps the accepted note", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });
      const previous = note();
      await h.store.writeNote(previous);

      const caught = await h.save({ store: storeFailingWrite(h.store, 2) }).catch((error: unknown) => error);

      // The bookkeeping failed, so the caller is told — but the provider took the note.
      assertCaughtInstanceOf(caught, Error, "delivered write failure");
      expect(caught.message).toBe(MIRROR_READ_ONLY);
      expect(h.provider.push).toHaveBeenCalledTimes(1);
      const mirrored = await h.store.readNote("project", "replay-budget");
      assertDefined(mirrored, "mirrored note");
      // The note the provider accepted is kept, not the one it replaced.
      expect(mirrored.description).toBe("replay budget stays 2,048 MiB");
      expect(mirrored.source).toBe(SOURCE);
      // Its staged id is what keyed the accepted push; the answer was never recorded.
      const [pushed] = firstCall(h.provider.push, "provider push");
      expect(mirrored.id).toBe(pushed.clientId);
      expect(mirrored.id).not.toBe(previous.id);
      expect(mirrored.id).not.toBe(ANSWER_ACTIVE.id);
      // A save whose bookkeeping failed never reached the index.
      expect(existsSync(h.store.paths.index)).toBe(false);
    });
  });

  test("F2: a mirror write that fails after acceptance does not delete a new note", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });

      const caught = await h.save({ store: storeFailingWrite(h.store, 2) }).catch((error: unknown) => error);

      assertCaughtInstanceOf(caught, Error, "delivered write failure");
      expect(caught.message).toBe(MIRROR_READ_ONLY);
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({
        id: firstCall(h.provider.push, "provider push")[0].clientId,
        source: SOURCE,
        status: "active",
      });
    });
  });
});
