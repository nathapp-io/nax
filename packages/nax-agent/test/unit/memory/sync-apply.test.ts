/**
 * US-015: step 4 of a sync — what a pulled page *means* for the mirror.
 *
 * A page is the provider's answer about one scope, so the page's scope is where its
 * notes belong. Each note is validated before it may touch the disk: a slug outside
 * `MEMORY_SLUG_RE`, or a note the `MemoryNote` schema refuses, is counted in `skipped`
 * and reported once at `warn` — one bad note never costs the page its cursor. A key
 * the outbox still holds is left exactly as the local mirror has it and is not counted
 * at all: the local write is the newer fact, and a pulled copy must not roll it back.
 * A tombstone (`superseded | rejected | deleted`) deletes the mirrored note and is not
 * a pull. `decisions` replace `decisions.jsonl` on a project page only.
 *
 * The held-key read is deliberately asserted through the ordering: the AC-2 scripted
 * `pull` enqueues its write *while* the page is in flight, so only a read taken after
 * the page arrives can see it.
 */
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createMemoryOutbox,
  createMemoryStore,
  type MemoryDecision,
  type MemoryNote,
  type MemoryNoteStatus,
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
  makeLogger,
  makeMemoryProvider,
  withTempDir,
} from "#test/helpers/index";

/** The instant every test's injected clock reports. */
const STAMP = "2026-11-12T10:00:00.000Z";
/** The pid each harness claims as its own: never this process's, so a stale lock is taken over. */
const SYNC_PID = 6262;

/** The pieces a sync runs against, before the provider is scripted. */
interface Fixture {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly logger: MockLogger;
}

/** A script, or a function building one from the pieces it needs to drive mid-pull. */
type ScriptFor = MemoryProviderScript | ((fixture: Fixture) => MemoryProviderScript);

/** The pieces one sync runs against, all pointed at `<dir>/project`. */
interface Harness extends Fixture {
  readonly provider: MemoryProviderMock;
  input(overrides?: Partial<MemorySyncInput>): MemorySyncInput;
}

/** One note as a provider hands it over. */
function note(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: `mem_${slug}`,
    slug,
    type: "project",
    scope: "project",
    description: `${slug} description`,
    source: "nax-chat",
    updatedAt: STAMP,
    status: "active",
    body: `${slug} body.`,
    ...overrides,
  };
}

/** One decision as a project page may carry it. */
function decision(id: string): MemoryDecision {
  return { id, subject: "replay", predicate: "budget", object: "2048 MiB", updatedAt: STAMP, status: "active" };
}

/** A page that ends its sequence. */
function lastPage(notes: readonly MemoryNote[], nextCursor?: string): MemoryPage {
  return { notes, ...(nextCursor === undefined ? {} : { nextCursor }), done: true };
}

/** A page with more behind it. */
function morePage(notes: readonly MemoryNote[], nextCursor: string): MemoryPage {
  return { notes, nextCursor, done: false };
}

/** A `save` write request for `saved`, keyed by `clientId`. */
function saveRequest(saved: MemoryNote, clientId: string): MemoryWriteRequest {
  return { kind: "save", clientId, scope: saved.scope, slug: saved.slug, writeMode: "direct", note: saved };
}

/** `user: true` gives the store the user directory a store may also mirror into. */
function harness(dir: string, script: ScriptFor = {}, user = false): Harness {
  const logger = makeLogger();
  const store = createMemoryStore({
    projectDir: join(dir, "project"),
    ...(user ? { userDir: join(dir, "user") } : {}),
    logger,
  });
  const outbox = createMemoryOutbox({ dir: store.paths.outboxDir, now: () => new Date(STAMP) });
  const fixture: Fixture = { store, outbox, logger };
  const provider = makeMemoryProvider(typeof script === "function" ? script(fixture) : script);
  const pieces = { ...fixture, provider };
  return {
    ...pieces,
    // A lock nobody's pid proves live is a stale one, so a run on a fresh store takes it over.
    input: (overrides = {}) => ({
      ...pieces,
      now: () => new Date(STAMP),
      pid: SYNC_PID,
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

/** Every line the logger recorded at `warn`, in order. */
function warnings(logger: MockLogger) {
  return logger.calls.filter((call) => call.level === "warn");
}

/** The non-empty lines of a record file: what `decisions.jsonl` actually holds. */
async function recordLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim() !== "");
}

describe("syncMemory step 4 (applying pulled notes)", () => {
  test("AC-1: a superseded note deletes the mirrored note of that slug and is not counted in pulled", async () => {
    await withTempDir(async (dir) => {
      const tombstone = note("retired-budget", { status: "superseded" });
      const h = harness(dir, { pull: [lastPage([tombstone])] });
      await h.store.writeNote(note("retired-budget"));

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 0 });
      expect(await h.store.readNote("project", "retired-budget")).toBeNull();
      expect(await h.store.listNotes("project")).toEqual([]);
    });
  });

  test.each(["rejected", "deleted"] as const)(
    "a %s tombstone deletes the mirrored note too, and is not counted in pulled",
    async (status: MemoryNoteStatus) => {
      await withTempDir(async (dir) => {
        const h = harness(dir, { pull: [lastPage([note("retired-budget", { status })])] });
        await h.store.writeNote(note("retired-budget"));

        const result = await syncMemory(h.input());

        expect(result.pulled).toBe(0);
        expect(result.skipped).toBe(0);
        expect(await h.store.readNote("project", "retired-budget")).toBeNull();
      });
    },
  );

  test("AC-2: a save enqueued before the page resolves leaves the mirrored note's local content alone", async () => {
    await withTempDir(async (dir) => {
      const local = note("held", { id: "mem_local", description: "local content", body: "local body." });
      const remote = note("held", { id: "mem_remote", description: "provider content", body: "provider body." });
      const h = harness(dir, ({ outbox }) => ({
        // The write is queued *while* the page is in flight: only a held read taken
        // after the page arrives can see it, which is the ordering the AC pins.
        pull: async () => {
          await outbox.enqueue(saveRequest(remote, "client-held"));
          return lastPage([remote]);
        },
      }));
      await h.store.writeNote(local);

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "synced", pulled: 0, skipped: 0 });
      expect(await h.store.readNote("project", "held")).toEqual(local);
    });
  });

  test("AC-3: a pulled note with slug `Bad Slug` is skipped once at warn and the cursor is still written", async () => {
    await withTempDir(async (dir) => {
      const badSlug = { ...note("bad-slug"), slug: "Bad Slug" };
      const h = harness(dir, { pull: [lastPage([badSlug], "c-bad")] });

      const result = await syncMemory(h.input());

      expect(result).toEqual({ outcome: "synced", pushed: 0, rejected: 0, pulled: 0, skipped: 1 });
      expect(warnings(h.logger)).toHaveLength(1);
      expect(warnings(h.logger)[0]?.data).toMatchObject({ scope: "project", slug: "Bad Slug" });
      expect(await h.store.listNotes("project")).toEqual([]);
      // The page's cursor is checkpointed whatever its notes were worth.
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        provider: "scripted",
        cursor: { project: "c-bad", user: null },
        lastPullAt: STAMP,
        lastError: null,
      });
    });
  });

  test("AC-4: a pulled object missing `description` is skipped and logged once at warn", async () => {
    await withTempDir(async (dir) => {
      // A payload whose `description` is absent: the schema, not the slug, is what refuses it.
      const missingDescription = Object.assign(note("no-description"), { description: undefined });
      const h = harness(dir, { pull: [lastPage([missingDescription])] });

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "synced", pulled: 0, skipped: 1 });
      expect(warnings(h.logger)).toHaveLength(1);
      expect(warnings(h.logger)[0]?.data).toMatchObject({ scope: "project", slug: "no-description" });
      expect(await h.store.listNotes("project")).toEqual([]);
    });
  });

  test("AC-5: a project page carrying decisions replaces decisions.jsonl with exactly those decisions", async () => {
    await withTempDir(async (dir) => {
      const pulled = [decision("d1"), decision("d2")];
      const h = harness(dir, { pull: [{ notes: [], decisions: pulled, done: true }] });
      await h.store.writeDecisions([decision("stale")]);

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      expect(await h.store.readDecisions()).toEqual(pulled);
      expect(await recordLines(h.store.paths.decisions)).toHaveLength(pulled.length);
    });
  });

  test("AC-6: with userDir set the user scope is pulled from its own cursor and its notes land under <userDir>/notes", async () => {
    await withTempDir(async (dir) => {
      const h = harness(
        dir,
        {
          pull: (input) =>
            lastPage(
              [note(input.scope === "user" ? "user-habit" : "project-habit", { scope: input.scope })],
              input.scope === "user" ? "u-next" : "p-next",
            ),
        },
        true,
      );
      await h.store.writeSyncState({
        provider: null,
        cursor: { project: null, user: "u-cursor-8" },
        lastPullAt: null,
        lastError: null,
      });

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "synced", pulled: 2 });
      expect(pullCalls(h.provider).map((call) => [call.scope, call.cursor])).toEqual([
        ["project", null],
        ["user", "u-cursor-8"],
      ]);
      expect(await h.store.readNote("user", "user-habit")).toEqual(note("user-habit", { scope: "user" }));
      expect(await readdir(h.store.paths.userNotesDir ?? "")).toContain("user-habit.md");
      expect(await h.store.readNote("project", "project-habit")).toEqual(note("project-habit"));
      expect(await readdir(h.store.paths.notesDir)).toContain("project-habit.md");
    });
  });

  test("AC-7: the user pull checkpoints cursor.user, and its decisions leave decisions.jsonl unchanged", async () => {
    await withTempDir(async (dir) => {
      const seeded = [decision("stale")];
      const h = harness(
        dir,
        {
          pull: (input) =>
            input.scope === "user"
              ? { notes: [], decisions: [decision("user-d1")], nextCursor: "u-next", done: true }
              : lastPage([], "p-next"),
        },
        true,
      );
      await h.store.writeDecisions(seeded);

      const result = await syncMemory(h.input());

      expect(result.outcome).toBe("synced");
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        provider: "scripted",
        cursor: { project: "p-next", user: "u-next" },
        lastPullAt: STAMP,
        lastError: null,
      });
      // A user page's decisions are not the mirror's to write: the project's copy stands.
      expect(await h.store.readDecisions()).toEqual(seeded);
    });
  });

  test("AC-8: when the project pull fails mid-way the user scope is not pulled", async () => {
    await withTempDir(async (dir) => {
      let projectPages = 0;
      const h = harness(
        dir,
        {
          pull: (input) => {
            if (input.scope === "user") return lastPage([note("user-habit", { scope: "user" })]);
            projectPages += 1;
            if (projectPages === 1) return morePage([note("project-habit")], "c1");
            throw new Error("project pull broke");
          },
        },
        true,
      );

      const result = await syncMemory(h.input());

      expect(result).toMatchObject({ outcome: "failed", error: "project pull broke", pulled: 1 });
      // Only the project's two pages were asked for: the user sequence never started.
      expect(pullCalls(h.provider).map((call) => call.scope)).toEqual(["project", "project"]);
      expect(await h.store.readNote("user", "user-habit")).toBeNull();
      expect(await recordedSyncState(h.store.paths.syncState)).toEqual({
        provider: "scripted",
        cursor: { project: "c1", user: null },
        lastPullAt: STAMP,
        lastError: "project pull broke",
      });
    });
  });
});
