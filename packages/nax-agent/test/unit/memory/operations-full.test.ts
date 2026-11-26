/**
 * US-008: `saveMemoryNote` — the `indexOverflows` save guard.
 *
 * The host that composes a save may pass an `indexOverflows(note)` hook: it renders the index
 * projection the host publishes and answers whether listing this note would drop another entry
 * off the end of it. A save stages the new note in the mirror before any provider is asked, and
 * an entry the index never lists is a note the next session cannot read — so the hook is asked
 * *before* anything is written, and a `true` answer is a `MEMORY_FULL` refusal: no note, no
 * outbox entry, no push, no index.
 *
 * Only a *new* slug is asked about. Overwriting a slug the mirror already holds replaces an entry
 * the projection already lists, so it cannot make the rendered index any longer — and the mirror's
 * note is what the slug means, whatever status it carries (`pending` included, because a proposal
 * waits in the mirror exactly like a note in force).
 *
 * The hook is a caller-supplied projection, so it can fail: a rejection is the caller's error
 * reaching the caller, with the mirror and the queue exactly as they were. The one write that
 * never consults it is the one fenced by a sync of this process, which is queued without staging
 * and leaves the mirror and the index to that sync.
 *
 * Everything else about a save — validation, staging, delivery, the queue — is exercised in
 * `operations.test.ts` and `operations-undelivered.test.ts`; these tests cover only the guard.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemoryOutbox,
  type MemoryPushResult,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  saveMemoryNote,
} from "@nathapp/nax-agent";
import { acquireMirrorDirLock, storeLockTargets } from "#src/memory/mirror-lock";
import { claimSync, releaseSync } from "#src/memory/sync-flight";
import {
  assertDefined,
  assertNaxError,
  type FakeClock,
  type MemoryProviderMock,
  type MockLogger,
  makeFakeClock,
  makeLogger,
  makeMemoryProvider,
  waitForCondition,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-09T07:45:00.000Z";
/** The label every save in these tests is made under. */
const SOURCE = "nax-chat";
/** The refusal's message: the generic one nax-agent owns (the host adds its own hint). */
const FULL_MESSAGE = "memory index is full: a new note would drop entries from the index";
/** A UUID: the shape of the id a save mints for the note it stages. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a provider answers a delivered direct save. */
const ANSWER_ACTIVE: MemoryPushResult = { id: "mem_1", status: "active" };

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

/** A note the mirror may already hold: the slug the saves here write, unless told otherwise. */
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
    body: "The replay budget stays 1,024 MiB.",
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

/** A hook that records the notes it is asked about and answers what the test said. */
function recordingHook(answer: boolean): {
  readonly hook: (note: MemoryNote) => Promise<boolean>;
  readonly seen: MemoryNote[];
} {
  const seen: MemoryNote[] = [];
  return {
    seen,
    hook: async (candidate) => {
      seen.push(candidate);
      return answer;
    },
  };
}

describe("saveMemoryNote and the indexOverflows guard", () => {
  test("AC-1: a new slug whose indexOverflows answers true is refused with MEMORY_FULL", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { hook } = recordingHook(true);

      const caught = await h.save({ indexOverflows: hook }).catch((error: unknown) => error);

      assertNaxError(caught, "refused save");
      expect(caught.code).toBe("MEMORY_FULL");
      expect(caught.message).toBe(FULL_MESSAGE);
      expect(caught.context).toMatchObject({ stage: "memory" });
    });
  });

  test("AC-2: after that refusal the mirror holds no note under the slug", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { hook } = recordingHook(true);

      const caught = await h.save({ indexOverflows: hook }).catch((error: unknown) => error);

      assertNaxError(caught, "refused save");
      expect(caught.code).toBe("MEMORY_FULL");
      // Nothing was staged: the note file the mirror would have written is not there.
      expect(await h.store.readNote("project", "replay-budget")).toBeNull();
      expect(existsSync(join(h.store.paths.notesDir, "replay-budget.md"))).toBe(false);
      expect(await h.store.listNotes("project")).toEqual([]);
    });
  });

  test("AC-3: after that refusal the outbox is empty", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { hook } = recordingHook(true);

      const caught = await h.save({ indexOverflows: hook }).catch((error: unknown) => error);

      assertNaxError(caught, "refused save");
      expect(await h.outbox.list()).toEqual([]);
      expect(await h.outbox.heldKeys()).toEqual(new Set());
    });
  });

  test("AC-4: after that refusal the provider's push was not called", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { hook } = recordingHook(true);

      const caught = await h.save({ indexOverflows: hook }).catch((error: unknown) => error);

      assertNaxError(caught, "refused save");
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(h.provider.reachable).not.toHaveBeenCalled();
      // No index was rendered either: there is nothing new to list.
      expect(existsSync(h.store.paths.index)).toBe(false);
    });
  });

  test("AC-5: indexOverflows is handed the note the save would stage", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const { hook, seen } = recordingHook(false);
      const staged = write({
        slug: "deploy-window",
        description: "deploys land on tuesday",
        body: "Deploys land Tuesday.",
      });

      await h.save({ write: staged, indexOverflows: hook });

      expect(seen).toHaveLength(1);
      const [candidate] = seen;
      assertDefined(candidate, "note handed to indexOverflows");
      // The write's own fields, under the id, status, source and clock the save mints them with.
      expect(candidate).toMatchObject({
        slug: "deploy-window",
        scope: "project",
        type: "project",
        description: "deploys land on tuesday",
        body: "Deploys land Tuesday.",
        status: "active",
        source: SOURCE,
        updatedAt: STAMP,
      });
      expect(candidate.id).toMatch(UUID_RE);
    });
  });

  test("AC-6: overwriting an existing slug saves the note and never calls indexOverflows", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });
      await h.store.writeNote(note());
      const { hook, seen } = recordingHook(true);

      const result = await h.save({ indexOverflows: hook });

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      // A slug the mirror holds is an entry the projection already lists, so the guard is moot.
      expect(seen).toEqual([]);
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({
        id: ANSWER_ACTIVE.id,
        description: "replay budget stays 2,048 MiB",
        source: SOURCE,
      });
      // The control: the very same hook is live, and refuses a slug the mirror does not hold —
      // so it was skipped here because of what the slug is, not because it was never wired.
      const caught = await h
        .save({ write: write({ slug: "deploy-window" }), indexOverflows: hook })
        .catch((error: unknown) => error);
      assertNaxError(caught, "new-slug save under the same hook");
      expect(caught.code).toBe("MEMORY_FULL");
      expect(seen.map((candidate) => candidate.slug)).toEqual(["deploy-window"]);
    });
  });

  test("AC-7: overwriting a slug the mirror holds as pending saves it and never calls indexOverflows", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });
      await h.store.writeNote(note({ status: "pending" }));
      const { hook, seen } = recordingHook(true);

      const result = await h.save({ indexOverflows: hook });

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      // A proposal waits in the mirror like a note in force: the projection already lists it.
      expect(seen).toEqual([]);
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({
        id: ANSWER_ACTIVE.id,
        description: "replay budget stays 2,048 MiB",
      });
      // The control: the same hook still refuses a slug the mirror does not hold.
      const caught = await h
        .save({ write: write({ slug: "deploy-window" }), indexOverflows: hook })
        .catch((error: unknown) => error);
      assertNaxError(caught, "new-slug save under the same hook");
      expect(caught.code).toBe("MEMORY_FULL");
      expect(seen.map((candidate) => candidate.slug)).toEqual(["deploy-window"]);
    });
  });

  test("AC-8: a new slug whose indexOverflows answers false is saved and delivered as usual", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });
      const { hook, seen } = recordingHook(false);

      const result = await h.save({ indexOverflows: hook });

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      // Asked exactly once, for the one note this save would add to the index.
      expect(seen).toHaveLength(1);
      expect(h.provider.push).toHaveBeenCalledTimes(1);
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({
        id: ANSWER_ACTIVE.id,
        status: "active",
      });
      expect(await readFile(h.store.paths.index, "utf8")).toContain("- [project] replay-budget");
    });
  });

  test("AC-9: without an indexOverflows a new slug is saved as it always was", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir, { push: ANSWER_ACTIVE });

      const result = await h.save();

      expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: true });
      expect(h.provider.push).toHaveBeenCalledTimes(1);
      expect(await h.store.readNote("project", "replay-budget")).toMatchObject({
        id: ANSWER_ACTIVE.id,
        source: SOURCE,
      });
    });
  });

  test("AC-10: an indexOverflows that rejects rejects the save and changes nothing", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const failure = new Error("index projection could not be rendered");

      const caught = await h
        .save({
          indexOverflows: async () => {
            throw failure;
          },
        })
        .catch((error: unknown) => error);

      // The caller's own error, neither wrapped nor replaced.
      expect(caught).toBe(failure);
      expect(await h.store.readNote("project", "replay-budget")).toBeNull();
      expect(await h.outbox.list()).toEqual([]);
      expect(h.provider.push).not.toHaveBeenCalled();
      expect(existsSync(h.store.paths.index)).toBe(false);
    });
  });

  test("AC-11: with a sync of this process in flight the write is queued and the guard is not asked", async () => {
    await withTempDir(async (dir) => {
      const h = harness(dir);
      const targets = storeLockTargets(h.store);
      expect(targets).toHaveLength(1);
      const [target] = targets;
      assertDefined(target, "mirror lock target");
      const { hook, seen } = recordingHook(true);
      // The claim a sync of this process takes before it first yields.
      expect(claimSync(target.path)).toBe(true);
      try {
        const result = await h.save({ indexOverflows: hook });

        // Fenced: queued without staging, so the mirror the sync owns is left alone.
        expect(result).toEqual({ slug: "replay-budget", status: "active", delivered: false });
        expect(seen).toEqual([]);
        expect(await h.store.readNote("project", "replay-budget")).toBeNull();
        const entries = await h.outbox.list();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: "save", slug: "replay-budget", state: "queued" });
      } finally {
        releaseSync(target.path);
      }
      // The control: once no sync holds the mirror, the same hook is asked and refuses.
      const caught = await h
        .save({ write: write({ slug: "deploy-window" }), indexOverflows: hook })
        .catch((error: unknown) => error);
      assertNaxError(caught, "new-slug save after the sync released the mirror");
      expect(caught.code).toBe("MEMORY_FULL");
      expect(seen.map((candidate) => candidate.slug)).toEqual(["deploy-window"]);
    });
  });
});

test("a fenced save during prune survives in the next mirror generation", async () => {
  await withTempDir(async (dir) => {
    const h = harness(dir);
    const projectDir = h.store.paths.projectDir;
    const userDir = join(dir, "user");
    const store = createMemoryStore({ projectDir, userDir, logger: h.logger });
    const release = await acquireMirrorDirLock({ dir: projectDir, logger: h.logger });
    assertDefined(release, "prune lock");
    const userLock = storeLockTargets(store).find((target) => target.dir.endsWith("/user"))?.path;
    assertDefined(userLock, "canonical user lock");
    claimSync(userLock);
    let finished = false;
    const save = h.save({ store }).finally(() => {
      finished = true;
    });
    try {
      await waitForCondition(() => h.clock.pending() > 0 || finished, 5000);
      await rename(projectDir, join(dir, "detached"));
      await rm(join(dir, "detached"), { recursive: true });
    } finally {
      await release();
      await h.clock.advance(10);
      releaseSync(userLock);
    }
    await save;
    expect((await h.outbox.list()).map((e) => e.slug)).toEqual([write().slug]);
  });
});
