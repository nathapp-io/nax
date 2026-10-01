import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLock, mcpLockPath, readMcpLock, schemaHash, writeMcpLock } from "@/mcp/lock";
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
