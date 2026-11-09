/**
 * host.ts — a forget whose remote delete failed, over the real MCP provider, and a
 * forget on a server that has no delete tool at all.
 *
 * Covers US-002 AC-21..AC-23: a forget the server refused to delete is not delivered,
 * it stays queued, and the next sync delivers it and deletes the remote copy. US-003
 * AC-16..AC-19: a server with no delete tool keeps its copy, so nax hides it and its
 * own search no longer shows the note it forgot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { McpServerConfig, NaxConfig } from "@/config";
import type { McpCallResult, McpPool, McpToolDescriptor } from "@/mcp";
import { _memoryHostDeps, createMemoryHost, type MemoryHost } from "@/memory";
import { _mcpIdMapDeps } from "@/memory/mcp-id-map";

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

/** The same server with no forget tool: its copies cannot be deleted there. */
function noForgetConfig(): NaxConfig {
  return makeNaxConfig({
    memory: {
      provider: "mcp",
      mcp: {
        server: SERVER,
        tools: { search: "search_memory", add: "add_memories" },
        args: { query: "query", text: "text" },
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
  /** The tools the server lists. */
  tools: string[];
  /** What the delete tool answers; the server refuses until a test says otherwise. */
  deleteAnswer: (call: PoolCall) => McpCallResult;
  /** What the add tool answers; the remote id it carries. */
  addAnswer: (call: PoolCall) => McpCallResult;
  /** What the search tool answers. */
  searchAnswer: (call: PoolCall) => McpCallResult;
}

function fakePool(): FakePool {
  const fake: FakePool = {
    calls: [],
    tools: ["add_memories", "search_memory", "delete_memory"],
    deleteAnswer: () => answer("no such memory", true),
    addAnswer: () => answer('{"results":[{"id":"r1","event":"ADD"}]}'),
    searchAnswer: () => answer("[]"),
    pool: {
      listTools: async () => fake.tools.map(tool),
      call: async (_serverId, _workdir, name, input) => {
        const call = { tool: name, input };
        fake.calls.push(call);
        if (name === "add_memories") return fake.addAnswer(call);
        if (name === "delete_memory") return fake.deleteAnswer(call);
        if (name === "search_memory") return fake.searchAnswer(call);
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

describe("the memory host over an MCP server with no delete tool", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;
  let originalIdMapDeps: typeof _mcpIdMapDeps;
  let fake: FakePool;

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-mcp-nodelete-global-");
    repoRoot = makeTempDir("nax-host-mcp-nodelete-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
    originalIdMapDeps = { ..._mcpIdMapDeps };
    fake = fakePool();
    fake.tools = ["add_memories", "search_memory"];
    _memoryHostDeps.createMcpPool = () => fake.pool;
  });

  afterEach(() => {
    Object.assign(_memoryHostDeps, originalDeps);
    Object.assign(_mcpIdMapDeps, originalIdMapDeps);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  async function open(): Promise<MemoryHost> {
    const host = await createMemoryHost({ config: noForgetConfig(), repoRoot, source: "nax-chat", logger });
    assertDefined(host, "the memory host");
    return host;
  }

  /** Save the note, so the server holds a copy of it, and forget it. */
  async function saveAndForget(host: MemoryHost, scope: "project" | "user" = "project"): Promise<void> {
    await host.save({ slug: "s1", type: scope, scope, description: "budget note", body: "budget" });
    await host.forget({ scope, slug: "s1", reason: "outdated" });
  }

  test("the copy the server keeps is not in the search results (AC-16)", async () => {
    const host = await open();
    await saveAndForget(host);
    fake.searchAnswer = () => answer('[{"id":"r1","memory":"s1: budget note"}]');

    const hits = await host.search({ text: "budget", limit: 5 });

    expect(hits.map((hit) => hit.slug)).not.toContain("mcp-r1");
  });

  test("the other copies the server holds are still in the search results (AC-17)", async () => {
    const host = await open();
    await saveAndForget(host);
    fake.searchAnswer = () => answer('[{"id":"r1","memory":"s1: budget note"},{"id":"r9","memory":"s9: budget"}]');

    const hits = await host.search({ text: "budget", limit: 5 });

    expect(hits.map((hit) => hit.slug)).toContain("mcp-r9");
  });

  test("a copy hidden in the user scope is not in the search results either (AC-18)", async () => {
    fake.addAnswer = () => answer('{"results":[{"id":"ru1","event":"ADD"}]}');
    const host = await open();
    await saveAndForget(host, "user");
    fake.searchAnswer = () => answer('[{"id":"ru1","memory":"s1: budget note"}]');

    const hits = await host.search({ text: "budget", limit: 5 });

    expect(hits.map((hit) => hit.slug)).not.toContain("mcp-ru1");
  });

  test("an id map that cannot be read leaves the local hits and warns (AC-19)", async () => {
    const host = await open();
    await host.save({ slug: "s1", type: "project", scope: "project", description: "budget note", body: "budget" });
    _mcpIdMapDeps.readText = async () => {
      throw Object.assign(new Error("EACCES: failure"), { code: "EACCES" });
    };

    const hits = await host.search({ text: "budget", limit: 5 });

    expect(hits.map((hit) => hit.slug)).toEqual(["s1"]);
    expect(hits.filter((hit) => hit.slug.startsWith("mcp-"))).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "memory",
      "memory remote search failed",
      expect.objectContaining({ provider: `mcp:${SERVER}` }),
    );
  });
});
