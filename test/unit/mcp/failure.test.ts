import { afterEach, describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import type { McpLockFile } from "@/mcp/lock";
import { schemaHash } from "@/mcp/lock";
import { createMcpPool } from "@/mcp/pool";
import { createMcpProviders } from "@/mcp/provider";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

const schema = { type: "object" };
const server: McpServerConfig = { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 50, enabled: true };
const lock: McpLockFile = { version: 1, servers: { memory: { t: schemaHash(schema) } } };

function sdk(behaviour: { onCall?: () => unknown }) {
  Object.assign(_mcpClientDeps, {
    createTransport: () => ({ pid: 7, close: async () => {} }),
    createClient: () => ({
      connect: async () => {},
      listTools: async () => ({ tools: [{ name: "t", description: "d", inputSchema: schema }] }),
      callTool: async () => (behaviour.onCall ? behaviour.onCall() : { content: [{ type: "text", text: "ok" }] }),
      close: async () => {},
    }),
  });
}

function providerFor(pool: ReturnType<typeof createMcpPool>) {
  const [provider] = createMcpProviders({
    config: { servers: { memory: server } },
    pool,
    projectRoot: "/proj",
    readLock: async () => lock,
  });
  assertDefined(provider, "provider");
  return provider;
}

const ctx = { root: "/w", resolvedPaths: [], maxBytes: 40_000, maxFileBytes: 1 };

describe("US-006 failure behaviour", () => {
  test("a server whose command does not exist degrades: no tools, no throw", async () => {
    Object.assign(_mcpClientDeps, {
      createTransport: () => ({ pid: null, close: async () => {} }),
      createClient: () => ({
        connect: async () => {
          throw new Error("spawn ENOENT");
        },
        close: async () => {},
      }),
    });
    const pool = createMcpPool({ servers: { memory: server }, retry: { maxAttempts: 1, baseDelayMs: 0 } });
    expect(await providerFor(pool).tools("/w")).toEqual([]);
    await pool.close();
  });

  test("a server that dies mid-hop yields an error tool-result, not an exception", async () => {
    sdk({
      onCall: () => {
        throw new Error("EPIPE");
      },
    });
    const pool = createMcpPool({ servers: { memory: server } });
    const provider = providerFor(pool);
    const [tool] = await provider.tools("/w");
    assertDefined(tool, "tool");
    const result = await tool.run({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    await pool.close();
  });

  test("the advertised tool set is unchanged for the rest of the hop after a death (R9)", async () => {
    let calls = 0;
    sdk({
      onCall: () => {
        calls++;
        throw new Error("EPIPE");
      },
    });
    const pool = createMcpPool({ servers: { memory: server } });
    const provider = providerFor(pool);
    const [tool] = await provider.tools("/w");
    assertDefined(tool, "tool");
    await tool.run({}, ctx);
    // Same resolved list is still callable; a second call still answers as data.
    expect((await tool.run({}, ctx)).isError).toBe(true);
    expect(calls).toBe(2);
    await pool.close();
  });

  test("a call exceeding timeoutMs returns an error result rather than hanging", async () => {
    // Never resolves — the pool's own deadline must be what ends the call. A
    // fixed sleep is banned in tests (.nax/rules/forbidden-patterns-tests.md).
    sdk({ onCall: () => new Promise(() => {}) });
    const pool = createMcpPool({ servers: { memory: server } });
    const provider = providerFor(pool);
    const [tool] = await provider.tools("/w");
    assertDefined(tool, "tool");
    const started = Date.now();
    const result = await tool.run({}, ctx);
    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    await pool.close();
  }, 10_000);

  test("a degraded server never prevents a healthy one from being advertised", async () => {
    let connects = 0;
    Object.assign(_mcpClientDeps, {
      createTransport: () => ({ pid: 7, close: async () => {} }),
      createClient: () => ({
        connect: async () => {
          connects++;
          if (connects === 1) throw new Error("ENOENT");
        },
        listTools: async () => ({ tools: [{ name: "t", description: "d", inputSchema: schema }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      }),
    });
    const pool = createMcpPool({
      servers: { bad: { ...server }, memory: { ...server } },
      retry: { maxAttempts: 1, baseDelayMs: 0 },
    });
    const providers = createMcpProviders({
      config: { servers: { bad: server, memory: server } },
      pool,
      projectRoot: "/proj",
      readLock: async (): Promise<McpLockFile> => ({
        version: 1,
        servers: { bad: lock.servers.memory, memory: lock.servers.memory },
      }),
    });
    const [bad, memory] = providers;
    assertDefined(bad, "bad");
    assertDefined(memory, "memory");
    expect((await bad.tools("/w")).length).toBe(0);
    expect((await memory.tools("/w")).length).toBe(1);
    await pool.close();
  });
});
