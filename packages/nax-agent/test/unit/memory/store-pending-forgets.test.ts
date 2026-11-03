/**
 * The mirror's `pending-forgets.jsonl`: one queued forget per line, read and written
 * by the store exactly as `decisions.jsonl` is. The record is the one place a
 * `proposal` forget survives the process that asked for it, so a line that is not a
 * pending forget is skipped (with one warning naming the line) rather than trusted,
 * and a missing file reads as the empty record.
 *
 * The shape rules are the store's: `clientId` is an outbox id, `scope` is one of
 * `MEMORY_SCOPES`, `slug` is a note slug and `reason` is a string. The first block
 * pins the file and the round trip; the rest pin what is skipped.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createMemoryStore, type MemoryPendingForget } from "@nathapp/nax-agent";
import { makeLogger, withTempDir } from "#test/helpers/index";

/** One pending forget, with overrides: the example from the design. */
function pendingForget(overrides: Partial<MemoryPendingForget> = {}): MemoryPendingForget {
  return {
    clientId: "5b0c2f4e-7c1d-4a8e-9f3a-2d6b8e1c4a70",
    scope: "project",
    slug: "replay-budget",
    reason: "the budget changed",
    ...overrides,
  };
}

/** A project directory the store has to create for itself. */
function projectPath(dir: string): string {
  return join(dir, "project");
}

/** Drop the record file into the mirror by hand, creating its directory. */
async function writeFixture(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}

/** The record file the store owns for a project directory. */
function recordPath(project: string): string {
  return join(project, "pending-forgets.jsonl");
}

describe("memory store pending forgets", () => {
  test("AC-1: paths.pendingForgets is <projectDir>/pending-forgets.jsonl", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      expect(store.paths.pendingForgets).toBe(recordPath(project));
    });
  });

  test("AC-2: a mirror with no record file reads the empty record and is not created", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const logger = makeLogger();
      const store = createMemoryStore({ projectDir: project, logger });

      expect(await store.readPendingForgets()).toEqual([]);

      // Reading a record is not what creates it: the mirror may not exist at all.
      expect(existsSync(recordPath(project))).toBe(false);
      expect(existsSync(project)).toBe(false);
      expect(logger.calls).toEqual([]);
    });
  });

  test("AC-3: writePendingForgets then readPendingForgets round-trips in order", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });
      const first = pendingForget();
      const second = pendingForget({ clientId: "client-2", slug: "export-append", reason: "the export landed" });

      await store.writePendingForgets([first, second]);

      expect(await store.readPendingForgets()).toEqual([first, second]);
      // One JSON object per line: the file is a line log, not one JSON document.
      const text = await Bun.file(recordPath(project)).text();
      expect(text.split("\n").filter((line) => line !== "")).toEqual([JSON.stringify(first), JSON.stringify(second)]);
    });
  });

  test("AC-4: writePendingForgets([]) then readPendingForgets resolves []", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      await store.writePendingForgets([]);

      expect(await store.readPendingForgets()).toEqual([]);
      // An emptied record is an empty file, not a line holding an empty array.
      expect(await Bun.file(recordPath(project)).text()).toBe("");
    });
  });

  test("AC-5: a line that is not JSON is skipped, the first and third are read", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const first = pendingForget();
      const third = pendingForget({ clientId: "client-3", slug: "export-append" });
      await writeFixture(recordPath(project), `${JSON.stringify(first)}\nnot json\n${JSON.stringify(third)}\n`);
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      expect(await store.readPendingForgets()).toEqual([first, third]);
    });
  });

  test("AC-6: reading that record logs one warn naming the path and the line", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const path = recordPath(project);
      const first = pendingForget();
      const third = pendingForget({ clientId: "client-3" });
      await writeFixture(path, `${JSON.stringify(first)}\nnot json\n${JSON.stringify(third)}\n`);
      const logger = makeLogger();
      const store = createMemoryStore({ projectDir: project, logger });

      await store.readPendingForgets();

      const warns = logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0]?.stage).toBe("memory");
      expect(warns[0]?.message).toBe("skipping a pending-forgets line that is not a pending forget");
      // The line is named so the bad entry can be found in the record.
      expect(warns[0]?.data).toEqual({ path, line: 2 });
    });
  });

  test("AC-7: a line whose clientId is not an outbox id is skipped", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const kept = pendingForget();
      await writeFixture(
        recordPath(project),
        `${JSON.stringify(pendingForget({ clientId: "has space" }))}\n${JSON.stringify(kept)}\n`,
      );
      const logger = makeLogger();
      const store = createMemoryStore({ projectDir: project, logger });

      expect(await store.readPendingForgets()).toEqual([kept]);
      expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(1);
    });
  });

  test("AC-8: a line whose scope is not a memory scope is skipped", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const kept = pendingForget();
      // A scope the mirror cannot address: reading it as a pending forget would leak it.
      await writeFixture(
        recordPath(project),
        `${JSON.stringify({ ...pendingForget(), scope: "team" })}\n${JSON.stringify(kept)}\n`,
      );
      const logger = makeLogger();
      const store = createMemoryStore({ projectDir: project, logger });

      expect(await store.readPendingForgets()).toEqual([kept]);
      expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(1);
    });
  });

  test.each([
    ["slug", { ...pendingForget(), slug: "Bad_Slug" }],
    ["reason", { ...pendingForget(), reason: 42 }],
  ])("a line whose %s is not a pending forget's is skipped", async (_field, broken) => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const kept = pendingForget();
      await writeFixture(recordPath(project), `${JSON.stringify(broken)}\n${JSON.stringify(kept)}\n`);
      const logger = makeLogger();
      const store = createMemoryStore({ projectDir: project, logger });

      expect(await store.readPendingForgets()).toEqual([kept]);
      expect(logger.calls.filter((call) => call.level === "warn")).toHaveLength(1);
    });
  });

  test("a record file linked outside the mirror is MEMORY_PATH_OUTSIDE", async () => {
    await withTempDir(async (dir) => {
      const project = projectPath(dir);
      const outside = join(dir, "outside-pending-forgets.jsonl");
      // A pending forget the reader would happily decode: only the link's destination decides.
      await writeFixture(outside, `${JSON.stringify(pendingForget())}\n`);
      await mkdir(project, { recursive: true });
      await symlink(outside, recordPath(project));
      const store = createMemoryStore({ projectDir: project, logger: makeLogger() });

      await expect(store.readPendingForgets()).rejects.toMatchObject({ code: "MEMORY_PATH_OUTSIDE" });
    });
  });
});
