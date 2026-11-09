/**
 * host.ts — a forget whose remote delete failed, over the real MCP provider.
 *
 * Covers US-002 AC-21..AC-23: a forget the server refused to delete is not delivered,
 * it stays queued, and the next sync delivers it and deletes the remote copy.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { McpServerConfig, NaxConfig } from "@/config";
import type { McpCallResult, McpPool, McpToolDescriptor } from "@/mcp";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";

const SERVER = "om";

/** The configured server: `mcp.servers.om`, with the call timeout the provider must be given. */
function omServer(): McpServerConfig {
  return {
    url: "http://localhost:8765/mcp",
    args: [],
    env: {},
    stages: ["*"],
    timeoutMs: 4321,
    enabled: true,
  };
}

/** A config whose memory provider is `mcp` over server `om`, with a forget tool configured. */
function mcpConfig(): NaxConfig {
  return makeNaxConfig({
    memory: {
      provider: "mcp",
      mcp: {
        server: SERVER,
        tools: { search: "search_memory", add: "add_memories", forget: "delete_memory" },
        args: { query: "query", text: "text", id: "memory_id" },
      },
    },
    mcp: { servers: { [SERVER]: omServer() } },
  });
}

function tool(name: string): McpToolDescriptor {
  return { name, description: name, inputSchema: { type: "object" } };
}

function answer(content: string, isError = false): McpCallResult {
  return { content, isError, bytesPreTruncation: content.length };
}

interface PoolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

interface FakePool {
  readonly pool: McpPool;
  readonly calls: PoolCall[];
  /** What the delete tool answers; the server refuses until a test says otherwise. */
  deleteAnswer: (call: PoolCall) => McpCallResult;
}

function fakePool(): FakePool {
  const fake: FakePool = {
    calls: [],
    deleteAnswer: () => answer("no such memory", true),
    pool: {
      listTools: async () => [tool("add_memories"), tool("search_memory"), tool("delete_memory")],
      call: async (_serverId, _workdir, name, input) => {
        const call = { tool: name, input };
        fake.calls.push(call);
        if (name === "add_memories") return answer('{"results":[{"id":"r1","event":"ADD"}]}');
        if (name === "delete_memory") return fake.deleteAnswer(call);
        return answer("[]");
      },
      events: () => [],
      close: async () => {},
    },
  };
  return fake;
}

describe("the memory host over an MCP server whose delete fails", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;
  let fake: FakePool;

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-mcp-forget-global-");
    repoRoot = makeTempDir("nax-host-mcp-forget-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
    fake = fakePool();
    _memoryHostDeps.createMcpPool = () => fake.pool;
  });

  afterEach(() => {
    Object.assign(_memoryHostDeps, originalDeps);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  async function open(): Promise<MemoryHost> {
    const host = await createMemoryHost({ config: mcpConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** Save the note and forget it while the server refuses to delete it. */
  async function saveAndForget(host: MemoryHost): Promise<void> {
    await host.save({ slug: "s1", type: "project", scope: "project", description: "d", body: "b" });
    await host.forget({ scope: "project", slug: "s1", reason: "outdated" });
  }

  const deleteCalls = (): PoolCall[] => fake.calls.filter((call) => call.tool === "delete_memory");

  test("a forget the server refused to delete is not delivered (AC-21)", async () => {
    const host = await open();

    await host.save({ slug: "s1", type: "project", scope: "project", description: "d", body: "b" });
    const result = await host.forget({ scope: "project", slug: "s1", reason: "outdated" });

    expect(result.delivered).toBe(false);
    expect((await host.status()).queued).toBe(1);
  });

  test("the next sync delivers the forget and deletes the remote copy (AC-22)", async () => {
    const host = await open();
    await saveAndForget(host);
    fake.deleteAnswer = () => answer("ok");

    await host.sync();

    expect(deleteCalls().map((call) => call.input.memory_id)).toEqual(["r1", "r1"]);
  });

  test("a further sync makes no further delete call (AC-23)", async () => {
    const host = await open();
    await saveAndForget(host);
    fake.deleteAnswer = () => answer("ok");
    await host.sync();
    const delivered = deleteCalls().length;

    await host.sync();

    expect(deleteCalls()).toHaveLength(delivered);
    expect((await host.status()).queued).toBe(0);
  });
});
