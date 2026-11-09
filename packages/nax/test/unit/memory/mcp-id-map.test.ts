/**
 * mcp-id-map.ts — the durable, scope-specific record of the remote ids each
 * save produced, so a later forget can delete them.
 *
 * Covers US-002 AC-16..AC-27, and US-001 AC-1..AC-8 and AC-21..AC-22: a read
 * that fails for any reason but "the file is not there" refuses the mutation
 * instead of writing over a file nax could not read.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { _mcpIdMapDeps, createMcpIdMap } from "@/memory/mcp-id-map";
import type { MemoryDirs } from "@/memory/paths";

/** A filesystem failure with the code the module reads. */
function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: failure`), { code });
}

/** The NaxError `promise` rejects with; fails the test when it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
  return caught;
}

describe("createMcpIdMap", () => {
  let base: string;
  let dirs: MemoryDirs;
  let originalDeps: typeof _mcpIdMapDeps;

  const projectFile = (): string => join(dirs.projectDir, "mcp-ids.json");
  const userFile = (): string => join(dirs.userDir, "mcp-ids.json");
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text());

  beforeEach(() => {
    base = makeTempDir("nax-mcp-ids-");
    dirs = { root: base, projectDir: join(base, "projects", "p-1"), userDir: join(base, "user") };
    originalDeps = { ..._mcpIdMapDeps };
  });

  afterEach(() => {
    Object.assign(_mcpIdMapDeps, originalDeps);
    cleanupTempDir(base);
  });

  test("a second map over the same dirs reads back the recorded ids (AC-16)", async () => {
    await createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["a", "b"]);
    expect(await createMcpIdMap({ dirs, server: "om" }).ids("project", "s1")).toEqual(["a", "b"]);
  });

  test("writes the documented file shape for the configured server", async () => {
    await createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["a"]);
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: { s1: ["a"] } });
  });

  test("add appends ids not already recorded (AC-17)", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("project", "s1", ["a", "b"]);
    await map.add("project", "s1", ["b", "c"]);
    expect(await map.ids("project", "s1")).toEqual(["a", "b", "c"]);
  });

  test("add de-duplicates repeated ids inside one call", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("project", "s1", ["a", "a"]);
    expect(await map.ids("project", "s1")).toEqual(["a"]);
  });

  test("drop forgets one slug and keeps the others (AC-18)", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("project", "s1", ["a"]);
    await map.add("project", "s2", ["b"]);
    await map.drop("project", "s1");
    expect(await map.ids("project", "s1")).toEqual([]);
    expect(await map.ids("project", "s2")).toEqual(["b"]);
  });

  test("drop with ids removes only those ids and keeps the rest", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("project", "s1", ["a", "b", "c"]);
    await map.drop("project", "s1", ["a", "c"]);
    expect(await map.ids("project", "s1")).toEqual(["b"]);
  });

  test("drop with every recorded id removes the slug entry", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("project", "s1", ["a"]);
    await map.drop("project", "s1", ["a"]);
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: {} });
  });

  test("an id recorded under user scope is written to the user directory (AC-19)", async () => {
    await createMcpIdMap({ dirs, server: "om" }).add("user", "s1", ["u1"]);
    expect(await readJson(userFile())).toEqual({ version: 1, server: "om", notes: { s1: ["u1"] } });
    expect(await Bun.file(projectFile()).exists()).toBe(false);
  });

  test("an id recorded under user scope is not returned for project scope (AC-20)", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("user", "s1", ["u1"]);
    expect(await map.ids("project", "s1")).toEqual([]);
    expect(await map.ids("user", "s1")).toEqual(["u1"]);
  });

  test("a file of another version reads as empty (US-001 AC-21)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), '{"version":2,"server":"om","notes":{"s1":["a"]}}');
    expect(await createMcpIdMap({ dirs, server: "om" }).ids("project", "s1")).toEqual([]);
  });

  test("a file written for another server reads as empty (US-001 AC-21)", async () => {
    await createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["a"]);
    expect(await createMcpIdMap({ dirs, server: "other" }).ids("project", "s1")).toEqual([]);
  });

  test("a file that is not JSON reads as empty (US-001 AC-21)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), "this is not json");
    expect(await createMcpIdMap({ dirs, server: "om" }).ids("project", "s1")).toEqual([]);
  });

  test("a file whose notes field is not an object reads as empty (US-001 AC-21)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), '{"version":1,"server":"om","notes":[]}');
    expect(await createMcpIdMap({ dirs, server: "om" }).ids("project", "s1")).toEqual([]);
  });

  test("add after reading a non-JSON file records the new id (US-001 AC-22)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), "this is not json");
    const map = createMcpIdMap({ dirs, server: "om" });
    expect(await map.ids("project", "s1")).toEqual([]);
    await map.add("project", "s1", ["z"]);
    expect(await map.ids("project", "s1")).toEqual(["z"]);
  });

  test("a read that fails with EACCES refuses the read with a retryable error (US-001 AC-1)", async () => {
    _mcpIdMapDeps.readText = async () => {
      throw fsError("EACCES");
    };

    const error = await rejection(createMcpIdMap({ dirs, server: "om" }).ids("project", "s1"));

    expect(error).toBeInstanceOf(NaxError);
    expect(error).toMatchObject({ code: "MEMORY_MCP_ID_MAP_READ_FAILED", context: { retryable: true } });
  });

  test("the refusal names the file it could not read (US-001 AC-2)", async () => {
    _mcpIdMapDeps.readText = async () => {
      throw fsError("EACCES");
    };

    const error = await rejection(createMcpIdMap({ dirs, server: "om" }).ids("project", "s1"));

    expect(error.message).toContain(projectFile());
  });

  test("a missing file reads as empty (AC-26)", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    expect(await map.ids("project", "s1")).toEqual([]);
    expect(await map.ids("user", "s1")).toEqual([]);
  });

  test.each([
    ["invalid JSON", "garbage"],
    ["another version", '{"version":2,"server":"om","notes":{"s1":["old"]}}'],
    ["another server", '{"version":1,"server":"other","notes":{"s1":["old"]}}'],
    ["a non-object notes field", '{"version":1,"server":"om","notes":[]}'],
  ])("add rewrites a version-1 file for the configured server over %s (US-001 AC-22)", async (_label, content) => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), content);
    await createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["n"]);
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: { s1: ["n"] } });
  });

  test("drop rewrites an unusable file for the configured server (US-001 AC-22)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), '{"version":1,"server":"other","notes":{"s1":["old"]}}');
    await createMcpIdMap({ dirs, server: "om" }).drop("project", "s1");
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: {} });
  });

  test("add refuses to write over a file it could not read (US-001 AC-3, AC-4)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), '{"version":1,"server":"om","notes":{"s1":["old"]}}');
    const writes: string[] = [];
    _mcpIdMapDeps.writeText = async (path, text) => {
      writes.push(path);
      await Bun.write(path, text);
    };
    _mcpIdMapDeps.readText = async () => {
      throw fsError("EIO");
    };

    const error = await rejection(createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["n"]));

    expect(error.code).toBe("MEMORY_MCP_ID_MAP_READ_FAILED");
    expect(writes).toEqual([]);
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: { s1: ["old"] } });
  });

  test("drop refuses to write over a file it could not read (US-001 AC-5, AC-6)", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), '{"version":1,"server":"om","notes":{"s1":["old"]}}');
    const writes: string[] = [];
    _mcpIdMapDeps.writeText = async (path, text) => {
      writes.push(path);
      await Bun.write(path, text);
    };
    _mcpIdMapDeps.readText = async () => {
      throw fsError("EIO");
    };

    const error = await rejection(createMcpIdMap({ dirs, server: "om" }).drop("project", "s1"));

    expect(error.code).toBe("MEMORY_MCP_ID_MAP_READ_FAILED");
    expect(writes).toEqual([]);
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: { s1: ["old"] } });
  });

  test("a file that is not there is read as no records, so add writes the new one (US-001 AC-7, AC-8)", async () => {
    _mcpIdMapDeps.readText = async () => {
      throw fsError("ENOENT");
    };

    await createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["n"]);

    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: { s1: ["n"] } });
  });

  test("drop of a slug in a missing file writes nothing", async () => {
    await createMcpIdMap({ dirs, server: "om" }).drop("project", "s1");
    expect(await Bun.file(projectFile()).exists()).toBe(false);
  });

  test("writes go through a same-directory temporary file renamed into place", async () => {
    const renames: Array<[string, string]> = [];
    const realRename = _mcpIdMapDeps.rename;
    _mcpIdMapDeps.rename = async (from, to) => {
      renames.push([from, to]);
      await realRename(from, to);
    };
    await createMcpIdMap({ dirs, server: "om" }).add("project", "s1", ["a"]);
    expect(renames).toHaveLength(1);
    const [from, to] = renames[0] ?? ["", ""];
    expect(to).toBe(projectFile());
    expect(from).not.toBe(to);
    expect(join(from, "..")).toBe(dirs.projectDir);
    expect(await readdir(dirs.projectDir)).toEqual(["mcp-ids.json"]);
  });

  test("a failed write rejects with a NaxError, leaves no temporary file and keeps the old content", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await map.add("project", "s1", ["a"]);
    _mcpIdMapDeps.rename = async () => {
      throw new Error("EXDEV");
    };
    await expect(map.add("project", "s1", ["b"])).rejects.toMatchObject({ code: "MEMORY_MCP_ID_MAP_WRITE_FAILED" });
    expect(await readdir(dirs.projectDir)).toEqual(["mcp-ids.json"]);
    expect(await readJson(projectFile())).toEqual({ version: 1, server: "om", notes: { s1: ["a"] } });
  });

  test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "records, reads back and drops ids for the inherited-member slug %s",
    async (slug) => {
      const map = createMcpIdMap({ dirs, server: "om" });
      expect(await map.ids("project", slug)).toEqual([]);
      await map.add("project", slug, ["a"]);
      await map.add("project", slug, ["b"]);
      expect(await createMcpIdMap({ dirs, server: "om" }).ids("project", slug)).toEqual(["a", "b"]);
      const file = (await readJson(projectFile())) as { notes: Record<string, unknown> };
      expect(Object.keys(file.notes)).toEqual([slug]);
      await map.drop("project", slug);
      expect(await map.ids("project", slug)).toEqual([]);
    },
  );

  test("reads a slug that is only an inherited member name as empty", async () => {
    mkdirSync(dirs.projectDir, { recursive: true });
    await Bun.write(projectFile(), '{"version":1,"server":"om","notes":{"other":["x"]}}');
    expect(await createMcpIdMap({ dirs, server: "om" }).ids("project", "constructor")).toEqual([]);
  });

  test("concurrent adds on one map lose no ids", async () => {
    const map = createMcpIdMap({ dirs, server: "om" });
    await Promise.all([
      map.add("project", "s1", ["a"]),
      map.add("project", "s1", ["b"]),
      map.add("project", "s2", ["c"]),
    ]);
    expect(await map.ids("project", "s1")).toEqual(["a", "b"]);
    expect(await map.ids("project", "s2")).toEqual(["c"]);
  });
});
