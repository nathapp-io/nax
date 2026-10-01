import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { McpServerConfig } from "@/config";
import type { McpLockFile } from "@/mcp/lock";
import { schemaHash } from "@/mcp/lock";
import type { McpPool } from "@/mcp/pool";
import type { McpWithheldEntry } from "@/mcp/provider";
import { createMcpProviders } from "@/mcp/provider";
import type { McpToolDescriptor } from "@/mcp/types";

// `JSONSchema` is `Record<string, unknown>` (src/context/engine/types.ts:79), so
// a plain object literal assigns with no cast. `as never` is lint-banned
// repo-wide (biome-plugins/no-as-never.grit) — every fixture here is typed.
const schema = { type: "object", properties: { q: { type: "string" } } };
const hash = schemaHash(schema);

const descriptors: McpToolDescriptor[] = [
  { name: "search_graph", description: "Search the graph", inputSchema: schema },
  { name: "delete_project", description: "Danger", inputSchema: schema },
];

interface Call {
  workdir: string;
  tool: string;
}

function fakePool(over: Partial<McpPool> = {}): McpPool & { calls: Call[] } {
  const calls: Call[] = [];
  const base: McpPool = {
    listTools: async () => descriptors,
    call: async (_id, workdir, tool) => {
      calls.push({ workdir, tool });
      return { content: "ok", isError: false, bytesPreTruncation: 2 };
    },
    events: () => [],
    close: async () => {},
  };
  return { ...base, ...over, calls };
}

const server: McpServerConfig = {
  command: "fake",
  args: [],
  env: {},
  stages: ["run"],
  timeoutMs: 1234,
  enabled: true,
};

const lock: McpLockFile = { version: 1, servers: { memory: { search_graph: hash, delete_project: hash } } };

const build = (over: Partial<McpServerConfig> = {}, pool = fakePool()) =>
  createMcpProviders({
    config: { servers: { memory: { ...server, ...over } } },
    pool,
    projectRoot: "/proj",
    readLock: async () => lock,
  });

describe("createMcpProviders", () => {
  test("one provider per configured server, id = server id, kind = discovered", () => {
    const [provider] = build();
    assertDefined(provider, "provider");
    expect(provider.id).toBe("memory");
    expect(provider.kind).toBe("discovered");
    expect(provider.stages).toEqual(["run"]);
  });

  test("a disabled server contributes no provider", () => {
    expect(build({ enabled: false })).toEqual([]);
  });

  test("tools() returns every locked tool when allowedTools is omitted", async () => {
    const [provider] = build();
    assertDefined(provider, "provider");
    expect((await provider.tools("/w")).map((t) => t.localName)).toEqual(["search_graph", "delete_project"]);
  });

  test("allowedTools narrows, and never widens past the lock", async () => {
    const [provider] = build({ allowedTools: ["search_graph", "not_advertised"] });
    assertDefined(provider, "provider");
    expect((await provider.tools("/w")).map((t) => t.localName)).toEqual(["search_graph"]);
  });

  test("a tool absent from the lock is withheld", async () => {
    const withheld: McpWithheldEntry[] = [];
    const providers = createMcpProviders({
      config: { servers: { memory: server } },
      pool: fakePool(),
      projectRoot: "/proj",
      readLock: async (): Promise<McpLockFile> => ({ version: 1, servers: { memory: { search_graph: hash } } }),
      onWithheld: (entry) => withheld.push(entry),
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    expect((await provider.tools("/w")).map((t) => t.localName)).toEqual(["search_graph"]);
    expect(withheld).toEqual([{ serverId: "memory", name: "delete_project", reason: "absent-from-lock" }]);
  });

  test("a tool whose schema changed is withheld", async () => {
    const providers = createMcpProviders({
      config: { servers: { memory: server } },
      pool: fakePool(),
      projectRoot: "/proj",
      readLock: async (): Promise<McpLockFile> => ({
        version: 1,
        servers: { memory: { search_graph: "stale", delete_project: hash } },
      }),
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    expect((await provider.tools("/w")).map((t) => t.localName)).toEqual(["delete_project"]);
  });

  test("run() calls the pool at the workdir tools() was resolved for, not the runtime's", async () => {
    const pool = fakePool();
    const [provider] = build({}, pool);
    assertDefined(provider, "provider");
    const [tool] = await provider.tools("/worktree/story-3");
    assertDefined(tool, "tool");
    await tool.run({ q: "x" }, { root: "/worktree/story-3", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 1 });
    expect(pool.calls).toEqual([{ workdir: "/worktree/story-3", tool: "search_graph" }]);
  });

  test("run() forwards the server's timeoutMs and the hop's maxBytes", async () => {
    const seen: unknown[] = [];
    const pool = fakePool({
      call: async (_id, _w, _t, _i, opts) => {
        seen.push(opts);
        return { content: "ok", isError: false, bytesPreTruncation: 2 };
      },
    });
    const [provider] = build({}, pool);
    assertDefined(provider, "provider");
    const [tool] = await provider.tools("/w");
    assertDefined(tool, "tool");
    await tool.run({}, { root: "/w", resolvedPaths: [], maxBytes: 999, maxFileBytes: 1 });
    expect(seen).toEqual([{ timeoutMs: 1234, maxBytes: 999 }]);
  });

  test("an error result comes back as data on ToolResult, never as a throw", async () => {
    const pool = fakePool({
      call: async () => ({ content: "server unavailable", isError: true, bytesPreTruncation: 18 }),
    });
    const [provider] = build({}, pool);
    assertDefined(provider, "provider");
    const [tool] = await provider.tools("/w");
    assertDefined(tool, "tool");
    const result = await tool.run({}, { root: "/w", resolvedPaths: [], maxBytes: 10, maxFileBytes: 1 });
    expect(result).toMatchObject({ isError: true, content: "server unavailable" });
  });

  test("the lock is read once, not once per hop", async () => {
    let reads = 0;
    const providers = createMcpProviders({
      config: { servers: { memory: server } },
      pool: fakePool(),
      projectRoot: "/proj",
      readLock: async () => {
        reads++;
        return lock;
      },
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    await provider.tools("/a");
    await provider.tools("/b");
    expect(reads).toBe(1);
  });

  test("a duplicate provider id is refused at construction", () => {
    // Two servers cannot share an id through config (object keys are unique),
    // so the guard is against a future STATIC provider colliding: the helper
    // validates its own ids and rejects a collision with a reserved prefix.
    expect(() =>
      createMcpProviders({
        config: { servers: { bad__id: server } },
        pool: fakePool(),
        projectRoot: "/proj",
        readLock: async () => lock,
      }),
    ).toThrow(/provider id/);
  });
});
