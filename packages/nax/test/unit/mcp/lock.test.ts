import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import type { McpLockFile, ResolvedMcpLock } from "@/mcp/lock";
import {
  applyLock,
  globalMcpLockPath,
  lockedReadOnlyTools,
  mcpLockPath,
  readMcpLock,
  resolveMcpLock,
  schemaHash,
  writeMcpLock,
  writeMcpLockAt,
} from "@/mcp/lock";
import type { McpToolDescriptor } from "@/mcp/types";

const dirs: string[] = [];
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nax-mcp-lock-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tool = (name: string, schema: Record<string, unknown> = { type: "object" }): McpToolDescriptor => ({
  name,
  description: "d",
  inputSchema: schema,
});

describe("schemaHash", () => {
  test("is stable across key order", () => {
    expect(schemaHash({ a: 1, b: { c: 2, d: 3 } })).toBe(schemaHash({ b: { d: 3, c: 2 }, a: 1 }));
  });

  test("changes when the schema changes", () => {
    expect(schemaHash({ type: "object" })).not.toBe(schemaHash({ type: "object", required: ["q"] }));
  });
});

describe("applyLock", () => {
  test("admits a tool whose name and schema hash match", () => {
    const t = tool("search_graph");
    const result = applyLock({ search_graph: schemaHash(t.inputSchema) }, [t]);
    expect(result.admitted.map((x) => x.name)).toEqual(["search_graph"]);
    expect(result.withheld).toEqual([]);
  });

  test("withholds a tool absent from the lock", () => {
    const result = applyLock({}, [tool("delete_project")]);
    expect(result.admitted).toEqual([]);
    expect(result.withheld).toEqual([{ name: "delete_project", reason: "absent-from-lock" }]);
  });

  test("withholds a tool whose schema hash changed", () => {
    const result = applyLock({ search_graph: "deadbeef" }, [tool("search_graph")]);
    expect(result.admitted).toEqual([]);
    expect(result.withheld).toEqual([{ name: "search_graph", reason: "schema-changed" }]);
  });

  test("an absent lock section withholds everything", () => {
    expect(applyLock(undefined, [tool("a"), tool("b")]).withheld.map((w) => w.name)).toEqual(["a", "b"]);
  });
});

describe("read/write", () => {
  test("round-trips and is byte-identical for an unchanged tool set", async () => {
    const dir = await tempDir();
    const lock = { version: 1 as const, servers: { memory: { b: "2", a: "1" } } };
    await writeMcpLock(dir, lock);
    const first = await Bun.file(mcpLockPath(dir)).text();
    await writeMcpLock(dir, JSON.parse(JSON.stringify(lock)));
    expect(await Bun.file(mcpLockPath(dir)).text()).toBe(first);
    expect(await readMcpLock(dir)).toEqual(lock);
  });

  test("keys are sorted so a re-run produces no diff noise", async () => {
    const dir = await tempDir();
    await writeMcpLock(dir, { version: 1, servers: { z: { b: "2", a: "1" }, a: { c: "3" } } });
    const text = await Bun.file(mcpLockPath(dir)).text();
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"z"'));
  });

  test("a missing lock reads as undefined, not a throw", async () => {
    expect(await readMcpLock(await tempDir())).toBeUndefined();
  });

  test("a malformed lock reads as undefined", async () => {
    const dir = await tempDir();
    await Bun.write(mcpLockPath(dir), "{ not json");
    expect(await readMcpLock(dir)).toBeUndefined();
  });
});

describe("readOnly section", () => {
  test("round-trips through write and read, sorted", async () => {
    const dir = await tempDir();
    await writeMcpLock(dir, { version: 1, servers: { docs: { a: "1" } }, readOnly: { docs: ["b", "a"] } });
    expect((await readMcpLock(dir))?.readOnly).toEqual({ docs: ["a", "b"] });
  });

  test("a lock with no readOnly reads with no readOnly key", async () => {
    const dir = await tempDir();
    await writeMcpLock(dir, { version: 1, servers: { docs: { a: "1" } } });
    expect(Object.keys((await readMcpLock(dir)) ?? {})).toEqual(["version", "servers"]);
  });

  test("a malformed readOnly is dropped on read", async () => {
    const dir = await tempDir();
    await Bun.write(mcpLockPath(dir), JSON.stringify({ version: 1, servers: {}, readOnly: "x" }));
    expect((await readMcpLock(dir))?.readOnly).toBeUndefined();
  });

  test("lockedReadOnlyTools reads a malformed or missing entry as empty", () => {
    const lock = { version: 1 as const, servers: {}, readOnly: { docs: ["get"] } };
    expect([...lockedReadOnlyTools(lock, "docs")]).toEqual(["get"]);
    expect([...lockedReadOnlyTools(lock, "other")]).toEqual([]);
    expect([...lockedReadOnlyTools(undefined, "docs")]).toEqual([]);
  });
});

/** Raw write: the resolver tests must not depend on the writer's canonicalisation. */
async function writeLockFile(path: string, lock: unknown): Promise<void> {
  await Bun.write(path, JSON.stringify(lock));
}

const toolHash = schemaHash({ type: "object" });
const projectLock: McpLockFile = { version: 1, servers: { memory: { search_graph: toolHash } } };
const globalLock: McpLockFile = {
  version: 1,
  servers: { memory: { search_graph: toolHash, delete_project: toolHash } },
};

describe("globalMcpLockPath", () => {
  test("AC-6: defaults to <globalConfigDir>/mcp-lock.json, honouring NAX_GLOBAL_CONFIG_DIR", async () => {
    const dir = await tempDir();
    const previous = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = dir;
    try {
      expect(globalMcpLockPath()).toBe(join(globalConfigDir(), "mcp-lock.json"));
      expect(globalMcpLockPath()).toBe(join(dir, "mcp-lock.json"));
    } finally {
      if (previous === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = previous;
    }
  });

  test("AC-6: an explicit globalDir wins over the environment", async () => {
    const dir = await tempDir();
    expect(globalMcpLockPath(dir)).toBe(join(dir, "mcp-lock.json"));
  });
});

describe("resolveMcpLock", () => {
  test("AC-1: the project lock wins, with source project, even when a global lock exists", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await writeLockFile(mcpLockPath(root), projectLock);
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toEqual({ ...projectLock, source: "project" });
  });

  test("AC-2: falls back to the global lock, with source global, when the project has none", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toEqual({ ...globalLock, source: "global" });
  });

  test("AC-3: a malformed project lock fails closed rather than falling through to the global lock", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await writeLockFile(mcpLockPath(root), { version: 2, servers: {} });
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toBeUndefined();
  });

  test("AC-4: a malformed global lock resolves to undefined", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await writeLockFile(join(globalDir, "mcp-lock.json"), "{ not json");

    expect(await resolveMcpLock(root, globalDir)).toBeUndefined();
  });

  test("AC-5: no project lock and no global lock resolves to undefined", async () => {
    expect(await resolveMcpLock(await tempDir(), await tempDir())).toBeUndefined();
  });

  // B1: a project lock the lookup cannot resolve is NOT an absent project lock.
  // `stat` answers ENOENT for a dangling symlink, which read as "no project lock"
  // and silently widened the grant to the global lock.

  test("B1: a dangling project-lock symlink fails closed instead of adopting the global lock", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await mkdir(join(root, PROJECT_NAX_DIR), { recursive: true });
    await symlink(join(root, "target-never-written"), mcpLockPath(root));
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toBeUndefined();
  });

  test("B1: a lookup that errors (self-referential .nax symlink, ELOOP) fails closed", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    // `.nax` points at itself, so resolving any path beneath it is ELOOP — an
    // unreadable lookup rather than a confirmed absence.
    await symlink(PROJECT_NAX_DIR, join(root, PROJECT_NAX_DIR));
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toBeUndefined();
  });

  test("B1: a directory at the project lock path fails closed", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await mkdir(mcpLockPath(root), { recursive: true });
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toBeUndefined();
  });

  test("B1: a genuinely absent project lock still consults the global lock", async () => {
    const root = await tempDir();
    const globalDir = await tempDir();
    await mkdir(join(root, PROJECT_NAX_DIR), { recursive: true });
    await writeLockFile(join(globalDir, "mcp-lock.json"), globalLock);

    expect(await resolveMcpLock(root, globalDir)).toEqual({ ...globalLock, source: "global" });
  });
});

describe("writeMcpLockAt", () => {
  test("AC-13: never serialises the resolver's source field", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "mcp-lock.json");
    const resolved: ResolvedMcpLock = { ...globalLock, source: "global" };
    await writeMcpLockAt(path, resolved);

    const text = await Bun.file(path).text();
    expect(text).not.toContain("source");
    expect(JSON.parse(text)).toEqual({ version: 1, servers: globalLock.servers });
  });

  test("AC-17: writeMcpLock still writes key-sorted version-and-servers JSON with a trailing newline", async () => {
    const dir = await tempDir();
    await writeMcpLock(dir, { version: 1, servers: { z: { b: "2", a: "1" }, a: { c: "3" } } });

    expect(await Bun.file(mcpLockPath(dir)).text()).toBe(
      `${JSON.stringify({ version: 1, servers: { a: { c: "3" }, z: { a: "1", b: "2" } } }, null, 2)}\n`,
    );
  });
});
