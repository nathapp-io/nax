/**
 * The store's held-forget source: the provider-neutral set of `"<scope>/<slug>"` keys a
 * caller of `createMemoryStore` hands in, and the index that marks them.
 *
 * The source is optional, so a store created without one has no `readHeldForgetKeys` at
 * all — `markedForgets` merges nothing more. A source that throws is the mirror's problem,
 * not the caller's: the read answers the empty set after one warning, and the index is
 * still written, because a held-forget read that failed must not cost a session its index.
 *
 * What the source is *not* is a record: it never reaches `pending-forgets.jsonl`, so
 * `readPendingForgets` still answers only what the mirror recorded, and an approval still
 * decides from that record alone — a koda-held forget stays koda's decision.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  approveMemoryNote,
  createMemoryStore,
  type MemoryNote,
  type MemoryNoteType,
  type MemoryScope,
  type MemoryStore,
  refreshMemoryIndex,
} from "@nathapp/nax-agent";
import { assertDefined, makeLogger, withTempDir } from "#test/helpers/index";

/** One note, with overrides: the shape every index assertion starts from. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: "2026-11-02T08:11:00.000Z",
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** A user-scope note, with overrides. */
function userNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return note({ scope: "user", type: "user", ...overrides });
}

/** A source that answers the same set every time, spelled as `"<scope>/<slug>"`. */
function sourceOf(...keys: string[]): () => Promise<ReadonlySet<string>> {
  const held = new Set(keys);
  return async () => held;
}

/** A source that rejects: the failure a provider outage reaches the store as. */
function failingSource(message: string): () => Promise<ReadonlySet<string>> {
  return async () => {
    throw new Error(message);
  };
}

/** A project directory the store has to create for itself. */
function projectPath(dir: string): string {
  return join(dir, "project");
}

/** The index file of one scope, read as text. */
async function indexText(store: MemoryStore, scope: MemoryScope = "project"): Promise<string> {
  const path = scope === "user" ? store.paths.userIndex : store.paths.index;
  assertDefined(path, `index path for the "${scope}" scope`);
  return await readFile(path, "utf8");
}

/** The index line of one note, found by the prefix every note line starts with. */
function entryLineFor(text: string, type: MemoryNoteType, slug: string): string {
  const line = text.split("\n").find((row) => row.startsWith(`- [${type}] ${slug} `));
  assertDefined(line, `index line for "${slug}"`);
  return line;
}

describe("memory store held forgets", () => {
  describe("readHeldForgetKeys", () => {
    test("AC-1: a store given a heldForgets source answers the keys that source holds", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: sourceOf("project/x"),
        });
        assertDefined(store.readHeldForgetKeys, "readHeldForgetKeys");

        const keys = await store.readHeldForgetKeys();

        expect(keys.has("project/x")).toBe(true);
        expect([...keys]).toEqual(["project/x"]);
      });
    });

    test("AC-2: a store created without a source has no readHeldForgetKeys at all", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({ projectDir: projectPath(dir), logger: makeLogger() });

        expect(store.readHeldForgetKeys).toBeUndefined();
        // Not a member that answers `undefined`: the source is what puts the member there.
        expect("readHeldForgetKeys" in store).toBe(false);
      });
    });

    test("AC-3: a rejecting source answers the empty set", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: failingSource("koda is unreachable"),
        });
        assertDefined(store.readHeldForgetKeys, "readHeldForgetKeys");

        expect(await store.readHeldForgetKeys()).toEqual(new Set());
      });
    });

    test("AC-4: a rejecting source warns once per failed call at stage memory, naming the error", async () => {
      await withTempDir(async (dir) => {
        const logger = makeLogger();
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger,
          heldForgets: failingSource("koda is unreachable"),
        });
        assertDefined(store.readHeldForgetKeys, "readHeldForgetKeys");

        await store.readHeldForgetKeys();
        await store.readHeldForgetKeys();

        const warns = logger.calls.filter((call) => call.level === "warn");
        // One per failed call — not one per store, and not silent.
        expect(warns).toHaveLength(2);
        expect(warns[0]?.stage).toBe("memory");
        expect(warns[0]?.data?.error).toBe("koda is unreachable");
      });
    });
  });

  describe("refreshMemoryIndex", () => {
    test("AC-5: the project index marks a note the store's source holds", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: sourceOf("project/replay-budget"),
        });
        await store.writeNote(note({ slug: "replay-budget" }));
        await store.writeNote(note({ slug: "export-window" }));

        await refreshMemoryIndex(store);

        const text = await indexText(store);
        expect(entryLineFor(text, "project", "replay-budget").endsWith(" (forget pending)")).toBe(true);
        expect(entryLineFor(text, "project", "export-window").endsWith(" (forget pending)")).toBe(false);
      });
    });

    test("AC-6: the user index marks a user note the store's source holds", async () => {
      await withTempDir(async (dir) => {
        const user = join(dir, "user");
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          userDir: user,
          logger: makeLogger(),
          heldForgets: sourceOf("user/short-answers"),
        });
        await store.writeNote(userNote({ slug: "short-answers" }));

        await refreshMemoryIndex(store);

        const text = await indexText(store, "user");
        expect(entryLineFor(text, "user", "short-answers").endsWith(" (forget pending)")).toBe(true);
      });
    });

    test("AC-7: the caller's keys, the recorded forgets and the source's keys all mark their note", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: sourceOf("project/c"),
        });
        for (const slug of ["a", "b", "c"]) await store.writeNote(note({ slug }));
        await store.writePendingForgets([
          { clientId: randomUUID(), scope: "project", slug: "b", reason: "the budget changed" },
        ]);

        await refreshMemoryIndex(store, { heldForgets: new Set(["project/a"]) });

        const text = await indexText(store);
        for (const slug of ["a", "b", "c"]) {
          expect(entryLineFor(text, "project", slug).endsWith(" (forget pending)")).toBe(true);
        }
      });
    });

    test("AC-8: a rejecting source still writes the index, with no entry marked by it", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: failingSource("koda is unreachable"),
        });
        await store.writeNote(note({ slug: "replay-budget" }));

        await refreshMemoryIndex(store);

        const text = await indexText(store);
        expect(text).toContain("# Memory");
        expect(entryLineFor(text, "project", "replay-budget").endsWith(" (forget pending)")).toBe(false);
      });
    });
  });

  describe("what the source does not change", () => {
    test("AC-9: a key the store's source holds is not a recorded pending forget", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: sourceOf("project/x"),
        });
        await store.writeNote(note({ slug: "x", status: "pending" }));

        expect(await store.readPendingForgets()).toEqual([]);
      });
    });

    test("AC-10: an approval puts a pending note in force though the source holds its key", async () => {
      await withTempDir(async (dir) => {
        const store = createMemoryStore({
          projectDir: projectPath(dir),
          logger: makeLogger(),
          heldForgets: sourceOf("project/x"),
        });
        await store.writeNote(note({ slug: "x", status: "pending" }));
        await store.writePendingForgets([]);

        const approved = await approveMemoryNote({ store, scope: "project", slug: "x" });

        expect(approved.status).toBe("active");
        expect((await store.readNote("project", "x"))?.status).toBe("active");
        // A held forget is not a forget this mirror recorded, so nothing retires the note.
        expect(existsSync(join(store.paths.notesDir, "x.md"))).toBe(true);
      });
    });
  });
});
