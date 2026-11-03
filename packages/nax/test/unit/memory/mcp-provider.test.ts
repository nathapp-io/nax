/**
 * mcp-provider.ts — the MemoryProvider over one configured MCP memory server.
 *
 * Covers US-003 AC-1..AC-43 against a fake pool and a real id map in a temp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isMemoryPushRejected, type MemoryNote, type MemoryWriteRequest } from "@nathapp/nax-agent";
import { cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import type { MemoryMcpConfig } from "@/config";
import { NaxError } from "@/errors";
import type { McpCallResult, McpPool, McpToolDescriptor } from "@/mcp";
import { createMcpMemoryProvider, MEMORY_MCP_PROVIDER_PREFIX } from "@/memory";
import { createMcpIdMap, type McpIdMap } from "@/memory/mcp-id-map";
import { MCP_MEMORY_RESULT_MAX_BYTES } from "@/memory/mcp-provider";
import type { MemoryDirs } from "@/memory/paths";

const WORKDIR = "/repo";
const TIMEOUT_MS = 4321;
const ADD_OK: McpCallResult = {
  content: '{"results":[{"id":"r1","event":"ADD"}]}',
  isError: false,
  bytesPreTruncation: 0,
};

function tool(name: string): McpToolDescriptor {
  return { name, description: name, inputSchema: { type: "object" } };
}

function answer(content: string, isError = false): McpCallResult {
  return { content, isError, bytesPreTruncation: content.length };
}

interface PoolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly opts: { timeoutMs: number; maxBytes: number };
  readonly serverId: string;
  readonly workdir: string;
}

interface FakePool {
  readonly pool: Pick<McpPool, "listTools" | "call">;
  readonly calls: PoolCall[];
  readonly listCalls: Array<{ serverId: string; workdir: string }>;
  tools: () => Promise<readonly McpToolDescriptor[]>;
  respond: (call: PoolCall) => McpCallResult;
}

function fakePool(): FakePool {
  const fake: FakePool = {
    calls: [],
    listCalls: [],
    tools: async () => [tool("add_memories"), tool("search_memory"), tool("delete_memory")],
    respond: () => ADD_OK,
    pool: {
      listTools: async (serverId, workdir) => {
        fake.listCalls.push({ serverId, workdir });
        return fake.tools();
      },
      call: async (serverId, workdir, name, input, opts) => {
        const call = { serverId, workdir, tool: name, input, opts };
        fake.calls.push(call);
        return fake.respond(call);
      },
    },
  };
  return fake;
}

const DEFAULT_MCP: MemoryMcpConfig = {
  server: "om",
  tools: { search: "search_memory", add: "add_memories" },
  args: { query: "query", text: "text" },
};

const FORGET_MCP: MemoryMcpConfig = {
  server: "om",
  tools: { search: "search_memory", add: "add_memories", forget: "delete_memory" },
  args: { query: "query", text: "text", id: "memory_id" },
};

function noteOf(): MemoryNote {
  return {
    id: "note-id-1",
    slug: "s1",
    type: "reference",
    scope: "project",
    description: "d",
    source: "test",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
    body: "b",
  };
}

function saveRequest(): MemoryWriteRequest {
  return { kind: "save", clientId: "c-save", scope: "project", slug: "s1", writeMode: "direct", note: noteOf() };
}

function forgetRequest(): MemoryWriteRequest {
  return { kind: "forget", clientId: "c-forget", scope: "project", slug: "s1", writeMode: "direct" };
}

/** The NaxError a promise rejects with; fails the test when it resolves or rejects with anything else. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NaxError) return error;
    throw new Error(`expected a NaxError, got ${String(error)}`);
  }
  throw new Error("expected the promise to reject");
}

describe("createMcpMemoryProvider", () => {
  let base: string;
  let idMap: McpIdMap;
  let logger: MockLogger;
  let fake: FakePool;

  const make = (mcp: MemoryMcpConfig = DEFAULT_MCP) =>
    createMcpMemoryProvider({
      pool: fake.pool,
      serverId: "om",
      workdir: WORKDIR,
      mcp,
      idMap,
      logger,
      callTimeoutMs: TIMEOUT_MS,
    });

  beforeEach(() => {
    base = makeTempDir("nax-mcp-provider-");
    const dirs: MemoryDirs = { root: base, projectDir: join(base, "projects", "p-1"), userDir: join(base, "user") };
    idMap = createMcpIdMap({ dirs, server: "om" });
    logger = makeLogger();
    fake = fakePool();
  });

  afterEach(() => {
    cleanupTempDir(base);
  });

  describe("identity and pull", () => {
    test("id is mcp:<server> (AC-1)", () => {
      expect(make().id).toBe("mcp:om");
    });

    test("the prefix constant is mcp: (AC-38)", () => {
      expect(MEMORY_MCP_PROVIDER_PREFIX).toBe("mcp:");
    });

    test("pull resolves the empty finished page without calling the pool (AC-2)", async () => {
      const page = await make().pull({ scope: "project", cursor: null, take: 50 });
      expect(page).toEqual({ notes: [], done: true });
      expect(fake.calls).toEqual([]);
      expect(fake.listCalls).toEqual([]);
    });
  });

  describe("reachable", () => {
    test("true when the pool lists a tool for the server (AC-3)", async () => {
      expect(await make().reachable()).toBe(true);
      expect(fake.listCalls).toEqual([{ serverId: "om", workdir: WORKDIR }]);
    });

    test("false when listTools returns [] (AC-4, AC-43 connect failure / disabled server)", async () => {
      fake.tools = async () => [];
      expect(await make().reachable()).toBe(false);
    });

    test("false when listTools rejects (AC-5, AC-43 trust rejection)", async () => {
      fake.tools = async () => {
        throw new Error("repository is not trusted");
      };
      expect(await make().reachable()).toBe(false);
    });
  });

  describe("push save", () => {
    test("calls the add tool with the text argument and the bounded options (AC-6)", async () => {
      await make().push(saveRequest());
      expect(fake.calls).toEqual([
        {
          serverId: "om",
          workdir: WORKDIR,
          tool: "add_memories",
          input: { text: "s1: d\n\nb" },
          opts: { timeoutMs: TIMEOUT_MS, maxBytes: MCP_MEMORY_RESULT_MAX_BYTES },
        },
      ]);
      expect(MCP_MEMORY_RESULT_MAX_BYTES).toBe(65_536);
    });

    test("honours configured add tool and text argument names (AC-7)", async () => {
      fake.tools = async () => [tool("remember")];
      const mcp: MemoryMcpConfig = {
        server: "om",
        tools: { search: "search_memory", add: "remember" },
        args: { query: "query", text: "content" },
      };
      await make(mcp).push(saveRequest());
      expect(fake.calls.map((c) => [c.tool, c.input])).toEqual([["remember", { content: "s1: d\n\nb" }]]);
    });

    test("resolves the note id as active (AC-8)", async () => {
      expect(await make().push(saveRequest())).toEqual({ id: "note-id-1", status: "active" });
    });

    test("records the parsed remote ids under the scope and slug (AC-9)", async () => {
      await make().push(saveRequest());
      expect(await idMap.ids("project", "s1")).toEqual(["r1"]);
    });

    test("an add answering isError rejects with MEMORY_MCP_CALL_FAILED (AC-10)", async () => {
      fake.respond = () => answer("boom", true);
      const error = await rejection(make().push(saveRequest()));
      expect(error.code).toBe("MEMORY_MCP_CALL_FAILED");
    });

    test("MEMORY_MCP_CALL_FAILED is retryable, not a push rejection (AC-11)", async () => {
      fake.respond = () => answer("boom", true);
      expect(isMemoryPushRejected(await rejection(make().push(saveRequest())))).toBe(false);
    });

    test("the call-failed error names the server, tool and answer text (AC-40)", async () => {
      fake.respond = () => answer("quota exceeded", true);
      const error = await rejection(make().push(saveRequest()));
      expect(error.message).toContain("om");
      expect(error.message).toContain("add_memories");
      expect(error.message).toContain("quota exceeded");
    });

    test("an add tool missing from a connected server is a permanent rejection (AC-12)", async () => {
      fake.tools = async () => [tool("search_memory")];
      const error = await rejection(make().push(saveRequest()));
      expect(isMemoryPushRejected(error)).toBe(true);
      expect(fake.calls).toEqual([]);
    });

    test("the rejection message names the server and the tool (AC-13)", async () => {
      fake.tools = async () => [tool("search_memory")];
      const error = await rejection(make().push(saveRequest()));
      expect(error.message).toContain('"om"');
      expect(error.message).toContain('"add_memories"');
    });

    test("an answer without parseable ids still resolves active (AC-14)", async () => {
      fake.respond = () => answer("ok");
      expect(await make().push(saveRequest())).toEqual({ id: "note-id-1", status: "active" });
    });

    test("an answer without parseable ids records nothing (AC-15)", async () => {
      fake.respond = () => answer("ok");
      await make().push(saveRequest());
      expect(await idMap.ids("project", "s1")).toEqual([]);
    });

    test("listTools returning [] rejects MEMORY_MCP_UNAVAILABLE and makes no call (AC-16, AC-17)", async () => {
      fake.tools = async () => [];
      const error = await rejection(make().push(saveRequest()));
      expect(error.code).toBe("MEMORY_MCP_UNAVAILABLE");
      expect(isMemoryPushRejected(error)).toBe(false);
      expect(fake.calls).toEqual([]);
    });

    test("listTools rejecting rejects MEMORY_MCP_UNAVAILABLE and makes no call (AC-18, AC-19)", async () => {
      fake.tools = async () => {
        throw new Error("untrusted");
      };
      const error = await rejection(make().push(saveRequest()));
      expect(error.code).toBe("MEMORY_MCP_UNAVAILABLE");
      expect(error.message).toContain("untrusted");
      expect(fake.calls).toEqual([]);
    });

    test("a save without a note is a permanent rejection", async () => {
      const { note: _note, ...bare } = saveRequest();
      const error = await rejection(make().push(bare));
      expect(isMemoryPushRejected(error)).toBe(true);
      expect(fake.calls).toEqual([]);
    });
  });

  describe("push forget without tools.forget", () => {
    beforeEach(async () => {
      await idMap.add("project", "s1", ["r1"]);
      fake.tools = async () => [];
    });

    test("calls neither pool.call nor pool.listTools (AC-20)", async () => {
      await make().push(forgetRequest());
      expect(fake.calls).toEqual([]);
      expect(fake.listCalls).toEqual([]);
    });

    test("resolves deleted with the client id (AC-21)", async () => {
      expect(await make().push(forgetRequest())).toEqual({ id: "c-forget", status: "deleted" });
    });

    test("drops the recorded ids (AC-22)", async () => {
      await make().push(forgetRequest());
      expect(await idMap.ids("project", "s1")).toEqual([]);
    });
  });

  describe("push forget with tools.forget", () => {
    test("deletes each recorded id in order with the id argument (AC-23)", async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
      await make(FORGET_MCP).push(forgetRequest());
      expect(fake.calls.map((c) => [c.tool, c.input])).toEqual([
        ["delete_memory", { memory_id: "r1" }],
        ["delete_memory", { memory_id: "r2" }],
      ]);
      expect(fake.calls[0]?.opts).toEqual({ timeoutMs: TIMEOUT_MS, maxBytes: MCP_MEMORY_RESULT_MAX_BYTES });
    });

    test("resolves deleted and drops the id-map entry (AC-24)", async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
      const result = await make(FORGET_MCP).push(forgetRequest());
      expect(result).toEqual({ id: "c-forget", status: "deleted" });
      expect(await idMap.ids("project", "s1")).toEqual([]);
    });

    test.each([
      ["returns []", async (): Promise<McpToolDescriptor[]> => []],
      [
        "rejects",
        async (): Promise<McpToolDescriptor[]> => {
          throw new Error("down");
        },
      ],
    ])(
      "with recorded ids and listTools that %s: MEMORY_MCP_UNAVAILABLE and no call (AC-25, AC-26)",
      async (_n, tools) => {
        await idMap.add("project", "s1", ["r1"]);
        fake.tools = tools;
        const error = await rejection(make(FORGET_MCP).push(forgetRequest()));
        expect(error.code).toBe("MEMORY_MCP_UNAVAILABLE");
        expect(fake.calls).toEqual([]);
        expect(await idMap.ids("project", "s1")).toEqual(["r1"]);
      },
    );

    test("with no recorded ids calls neither listTools nor call and resolves deleted (AC-27, AC-28)", async () => {
      fake.tools = async () => [];
      const result = await make(FORGET_MCP).push(forgetRequest());
      expect(result).toEqual({ id: "c-forget", status: "deleted" });
      expect(fake.calls).toEqual([]);
      expect(fake.listCalls).toEqual([]);
    });

    describe("when the call for r1 answers isError", () => {
      beforeEach(async () => {
        await idMap.add("project", "s1", ["r1", "r2"]);
        fake.respond = (call) => (call.input.memory_id === "r1" ? answer("no such memory", true) : answer("ok"));
      });

      test("still tries r2 (AC-29)", async () => {
        await make(FORGET_MCP).push(forgetRequest());
        expect(fake.calls.map((c) => c.input.memory_id)).toEqual(["r1", "r2"]);
      });

      test("warns with stage, message and server/id/error (AC-30, AC-41)", async () => {
        await make(FORGET_MCP).push(forgetRequest());
        expect(logger.calls).toEqual([
          {
            level: "warn",
            stage: "memory",
            message: "memory mcp forget failed",
            data: { server: "om", id: "r1", error: "no such memory" },
          },
        ]);
      });

      test("resolves deleted and drops the entry (AC-31)", async () => {
        const result = await make(FORGET_MCP).push(forgetRequest());
        expect(result.status).toBe("deleted");
        expect(await idMap.ids("project", "s1")).toEqual([]);
      });
    });

    test("a late-finishing forget keeps ids a replacement save recorded meanwhile (B1)", async () => {
      await idMap.add("project", "s1", ["r1"]);
      const provider = make(FORGET_MCP);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let stalled: () => void = () => {};
      const stallStarted = new Promise<void>((resolve) => {
        stalled = resolve;
      });
      const realCall = fake.pool.call;
      let first = true;
      fake.pool.call = async (...args) => {
        if (first) {
          first = false;
          stalled();
          await gate; // the original forget stalls past the operations layer's deadline
        }
        return realCall(...args);
      };
      const original = provider.push(forgetRequest()); // times out upstream; keeps running here
      await stallStarted;
      // ...the outbox then delivers a queued replacement save, which records r2.
      fake.respond = (call) =>
        call.tool === "add_memories" ? answer('{"results":[{"id":"r2","event":"ADD"}]}') : answer("ok");
      await provider.push(saveRequest());
      expect(await idMap.ids("project", "s1")).toEqual(["r1", "r2"]);
      release();
      expect((await original).status).toBe("deleted");
      expect(await idMap.ids("project", "s1")).toEqual(["r2"]);
      // The next forget still deletes r2 on the server.
      await provider.push(forgetRequest());
      expect(fake.calls.filter((c) => c.tool === "delete_memory").map((c) => c.input.memory_id)).toEqual(["r1", "r2"]);
      expect(await idMap.ids("project", "s1")).toEqual([]);
    });

    test("a pool that throws for one id is also a warning, not a failure", async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
      let first = true;
      fake.respond = () => {
        if (first) {
          first = false;
          throw new Error("socket closed");
        }
        return answer("ok");
      };
      const result = await make(FORGET_MCP).push(forgetRequest());
      expect(result.status).toBe("deleted");
      expect(fake.calls).toHaveLength(2);
      expect(logger.calls[0]?.data).toEqual({ server: "om", id: "r1", error: "socket closed" });
    });

    test("a forget tool missing from a connected server is a permanent rejection naming both (AC-32, AC-39)", async () => {
      await idMap.add("project", "s1", ["r1"]);
      fake.tools = async () => [tool("add_memories")];
      const error = await rejection(make(FORGET_MCP).push(forgetRequest()));
      expect(isMemoryPushRejected(error)).toBe(true);
      expect(error.message).toContain('"om"');
      expect(error.message).toContain('"delete_memory"');
      expect(fake.calls).toEqual([]);
    });
  });

  describe("search", () => {
    test("calls the search tool with the query argument (AC-33)", async () => {
      fake.respond = () => answer("[]");
      await make().search?.({ scope: "project", text: "bun", limit: 5 });
      expect(fake.calls.map((c) => [c.tool, c.input])).toEqual([["search_memory", { query: "bun" }]]);
    });

    test("maps items to hits and keeps at most limit (AC-34)", async () => {
      fake.respond = () => answer('[{"id":"a","memory":"m1"},{"id":"b","memory":"m2"},{"id":"c","memory":"m3"}]');
      const hits = await make().search?.({ scope: "project", text: "bun", limit: 2 });
      expect(hits?.map((h) => h.slug)).toEqual(["mcp-a", "mcp-b"]);
    });

    test("an isError answer rejects MEMORY_MCP_CALL_FAILED (AC-35)", async () => {
      fake.respond = () => answer("down", true);
      const error = await rejection(make().search?.({ scope: "project", text: "bun", limit: 2 }) ?? Promise.resolve());
      expect(error.code).toBe("MEMORY_MCP_CALL_FAILED");
    });

    test("a non-JSON answer resolves [] (AC-36)", async () => {
      fake.respond = () => answer("no memories found");
      expect(await make().search?.({ scope: "project", text: "bun", limit: 2 })).toEqual([]);
    });

    test("JSON without a supported item list resolves [] (AC-42)", async () => {
      fake.respond = () => answer('{"memories":[{"memory":"x"}]}');
      expect(await make().search?.({ scope: "project", text: "bun", limit: 2 })).toEqual([]);
    });
  });
});

describe("@/memory barrel", () => {
  test("exports createMcpMemoryProvider (AC-37)", () => {
    expect(typeof createMcpMemoryProvider).toBe("function");
  });
});
