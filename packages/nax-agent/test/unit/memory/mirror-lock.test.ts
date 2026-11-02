/**
 * The lock protocol as a directory's writers share it, not as one project's mirror owns it.
 *
 * Two stores can name the same user directory — one per project, exactly as nax lays them
 * out — and a note in that directory belongs to both of them. A project-only lock leaves them
 * staging and rolling back the same user note at once, which is the shape of the failure this
 * suite pins: A stages a user note and waits on its provider, B delivers a replacement, A is
 * refused and its rollback removes the note B just delivered.
 *
 * The wait is proven on a fake clock, the way every lock wait in this package is: an operation
 * that has to queue behind a holder arms a timer it will not fire itself, so `pending() > 0`
 * is the observable difference between waiting and not waiting.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemorySaveResult,
  type MemoryStore,
  NaxError,
  saveMemoryNote,
} from "@nathapp/nax-agent";
import { acquireSessionLock } from "#src/session-store/index";
import {
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
const STAMP = "2026-11-09T09:45:00.000Z";
/** The user-scope slug both projects write. */
const SLUG = "replay-budget";
/** How long a test watches for something that must not happen. */
const NOT_YET_MS = 750;
/** A fake-clock step wide enough to fire the lock wait's poll. */
const POLL_STEP_MS = 1_000;

/** What one project's store looks like when it shares the user directory. */
interface Project {
  readonly store: MemoryStore;
  readonly logger: MockLogger;
}

function project(dir: string, name: string, userDir: string): Project {
  const logger = makeLogger();
  return { store: createMemoryStore({ projectDir: join(dir, name), userDir, logger }), logger };
}

/** One save against a project's store, over the pieces that project owns. */
function save(input: {
  readonly project: Project;
  readonly provider: MemoryProviderMock;
  readonly body: string;
  readonly timers?: FakeClock;
  readonly isAlive?: (pid: number) => boolean;
}): Promise<MemorySaveResult> {
  return saveMemoryNote({
    store: input.project.store,
    outbox: createMemoryOutbox({ dir: input.project.store.paths.outboxDir }),
    provider: input.provider,
    logger: input.project.logger,
    now: () => new Date(STAMP),
    ...(input.timers === undefined ? {} : { timers: input.timers }),
    ...(input.isAlive === undefined ? {} : { isAlive: input.isAlive }),
    write: { slug: SLUG, type: "user", scope: "user", description: "prefers terse commit messages", body: input.body },
    writeMode: "direct",
    source: "nax-chat",
  });
}

/** A provider refusal: the one answer a save undoes by deleting the note it staged. */
function refusal(reason: string): NaxError {
  return new NaxError(reason, "MEMORY_PUSH_REJECTED", { stage: "memory" });
}

/**
 * Whether `predicate` comes true within `ms` — a bounded observation for "this must not have
 * happened yet". `waitForCondition` reports that by throwing, and there is no unbounded way to
 * observe an absence.
 */
async function reachesWithin(predicate: () => boolean, ms: number): Promise<boolean> {
  return await waitForCondition(predicate, ms).then(
    () => true,
    () => false,
  );
}

/** A pid no test process has: the file another nax process would leave behind. */
const FOREIGN_PID = 8412;

/**
 * The shared user lock as another process holds it: a real lock file, a pid that is not this
 * process's, and a liveness probe that says it is there. Releasing it is the caller's job.
 */
async function heldByAnotherProcess(path: string, logger: MockLogger): Promise<() => Promise<void>> {
  const isAlive = (pid: number): boolean => pid === FOREIGN_PID;
  await mkdir(dirname(path), { recursive: true });
  const deps = { dir: dirname(path), pid: FOREIGN_PID, now: () => new Date(STAMP), logger, isAlive };
  return acquireSessionLock(path, deps, isAlive);
}

describe("a user directory two projects share", () => {
  test("[B3] a second project's save waits for the first, so its note is not rolled back", async () => {
    await withTempDir(async (dir) => {
      const userDir = join(dir, "user");
      const first = project(dir, "project-a", userDir);
      const second = project(dir, "project-b", userDir);
      // Both stores must name one canonical user directory, or there is nothing to share.
      expect(first.store.paths.userNotesDir).toBe(second.store.paths.userNotesDir);

      const gate = Promise.withResolvers<void>();
      const rejecting = makeMemoryProvider({
        push: async () => {
          await gate.promise;
          throw refusal("note is pinned");
        },
      });
      const delivering = makeMemoryProvider({ push: () => ({ id: "mem_b", status: "active" }) });

      const savingFirst = save({ project: first, provider: rejecting, body: "first body" });
      await waitForCondition(() => rejecting.push.mock.calls.length === 1, 5_000);
      const savingSecond = save({ project: second, provider: delivering, body: "second body" });

      // The two projects are two writers of one user directory, so the second save may not
      // reach its provider while the first still owns that directory. Asserting that nothing
      // happened is the one claim a test can only make against a bounded observation.
      expect(await reachesWithin(() => delivering.push.mock.calls.length === 1, NOT_YET_MS)).toBe(false);
      // The mirror still holds the *first* project's staged note: the second has written nothing.
      expect(await second.store.readNote("user", SLUG)).toMatchObject({ body: "first body" });

      gate.reject(refusal("note is pinned"));
      await expect(savingFirst).rejects.toMatchObject({ code: "MEMORY_PUSH_REJECTED" });
      const delivered = await savingSecond;

      // The refusal undid the first save's note, and the second save's own write survived it.
      expect(delivered).toEqual({ slug: SLUG, status: "active", delivered: true });
      expect(await second.store.readNote("user", SLUG)).toMatchObject({
        id: "mem_b",
        status: "active",
        body: "second body",
      });
      // Both locks are handed back, the shared one included.
      expect(existsSync(first.store.paths.lock)).toBe(false);
      expect(existsSync(join(userDir, "sync.lock"))).toBe(false);
    });
  });

  test("[B3] a store that names the shared user directory through a link shares its lock", async () => {
    await withTempDir(async (dir) => {
      const userDir = join(dir, "user");
      const alias = join(dir, "user-alias");
      await mkdir(userDir, { recursive: true });
      await symlink(userDir, alias);
      const first = project(dir, "project-a", userDir);
      // Two spellings of one directory: the lock, the deduplicated set and the in-process
      // chain all have to name the same thing, or both projects write it at once.
      const second = project(dir, "project-b", alias);
      expect(second.store.paths.userDir).not.toBe(first.store.paths.userDir);

      const gate = Promise.withResolvers<void>();
      const rejecting = makeMemoryProvider({
        push: async () => {
          await gate.promise;
          throw refusal("note is pinned");
        },
      });
      const delivering = makeMemoryProvider({ push: () => ({ id: "mem_b", status: "active" }) });

      const savingFirst = save({ project: first, provider: rejecting, body: "first body" });
      await waitForCondition(() => rejecting.push.mock.calls.length === 1, 5_000);
      const savingSecond = save({ project: second, provider: delivering, body: "second body" });

      // The alias is not a second mirror: the second save waits for the first to release it.
      expect(await reachesWithin(() => delivering.push.mock.calls.length === 1, NOT_YET_MS)).toBe(false);

      gate.reject(refusal("note is pinned"));
      await expect(savingFirst).rejects.toMatchObject({ code: "MEMORY_PUSH_REJECTED" });
      expect((await savingSecond).delivered).toBe(true);
      // The refusal undid the first save, and the second save's own note survived it.
      expect(await second.store.readNote("user", SLUG)).toMatchObject({ id: "mem_b", body: "second body" });
      expect(existsSync(join(userDir, "sync.lock"))).toBe(false);
    });
  });

  test("[B3] a user-scope save holds the shared user lock while it runs", async () => {
    await withTempDir(async (dir) => {
      const userDir = join(dir, "user");
      const only = project(dir, "project-a", userDir);
      const gate = Promise.withResolvers<void>();
      const provider = makeMemoryProvider({
        push: async () => {
          await gate.promise;
          return { id: "mem_a", status: "active" };
        },
      });

      const saving = save({ project: only, provider, body: "only body" });
      await waitForCondition(() => provider.push.mock.calls.length === 1, 5_000);

      // The lock a second project — in this process or another — has to take is held.
      expect(existsSync(join(userDir, "sync.lock"))).toBe(true);
      expect(existsSync(only.store.paths.lock)).toBe(true);

      gate.resolve();
      expect((await saving).delivered).toBe(true);
      expect(existsSync(join(userDir, "sync.lock"))).toBe(false);
    });
  });

  test("[B3] a user-scope save waits out another process holding the shared user lock", async () => {
    await withTempDir(async (dir) => {
      const userDir = join(dir, "user");
      const only = project(dir, "project-a", userDir);
      const otherProcess = await heldByAnotherProcess(join(userDir, "sync.lock"), only.logger);
      const clock = makeFakeClock();

      const saving = save({
        project: only,
        provider: makeMemoryProvider(),
        body: "body",
        timers: clock,
        isAlive: (pid) => pid === FOREIGN_PID,
      });
      // The shared directory has a live writer: this save polls instead of taking the file.
      await waitForCondition(() => clock.pending() > 0, 5_000);
      expect(await only.store.readNote("user", SLUG)).toBeNull();

      await otherProcess();
      await clock.advance(POLL_STEP_MS);
      expect((await saving).delivered).toBe(true);
      expect(await only.store.readNote("user", SLUG)).toMatchObject({ body: "body" });
    });
  });
});
