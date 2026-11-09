/**
 * mcp-provider.ts — a forget whose remote delete failed.
 *
 * Covers US-002 AC-1..AC-20: a delete the server refused keeps its id recorded, and the
 * push fails as retryable, so the outbox delivers the forget again and the next attempt
 * deletes only what is left. The ids a failed delete left are read back through the real
 * id map, in a temp directory, over a fake pool.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isMemoryBadResponse,
  isMemoryPushRejected,
  type MemoryNote,
  type MemoryWriteRequest,
} from "@nathapp/nax-agent";
import { cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import type { MemoryMcpConfig } from "@/config";
import { NaxError } from "@/errors";
import type { McpCallResult, McpPool, McpToolDescriptor } from "@/mcp";
import { createMcpMemoryProvider } from "@/memory";
import { _mcpIdMapDeps, createMcpIdMap, type McpIdMap } from "@/memory/mcp-id-map";
import type { MemoryDirs } from "@/memory/paths";

const WORKDIR = "/repo";
const TIMEOUT_MS = 4321;

const FORGET_MCP: MemoryMcpConfig = {
  server: "om",
  tools: { search: "search_memory", add: "add_memories", forget: "delete_memory" },
  args: { query: "query", text: "text", id: "memory_id" },
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
}

interface FakePool {
  readonly pool: Pick<McpPool, "listTools" | "call">;
  readonly calls: PoolCall[];
  respond: (call: PoolCall) => McpCallResult;
}

function fakePool(): FakePool {
  const fake: FakePool = {
    calls: [],
    respond: () => answer("ok"),
    pool: {
      listTools: async () => [tool("add_memories"), tool("search_memory"), tool("delete_memory")],
      call: async (_serverId, _workdir, name, input) => {
        const call = { tool: name, input };
        fake.calls.push(call);
        return fake.respond(call);
      },
    },
  };
  return fake;
}

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

/** A filesystem failure with the code the id map reads. */
function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: failure`), { code });
}

describe("the MCP provider over the id map", () => {
  let base: string;
  let idMap: McpIdMap;
  let logger: MockLogger;
  let fake: FakePool;
  let originalIdMapDeps: typeof _mcpIdMapDeps;

  const make = (mcp: MemoryMcpConfig = FORGET_MCP) =>
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
    base = makeTempDir("nax-mcp-provider-ids-");
    const dirs: MemoryDirs = { root: base, projectDir: join(base, "projects", "p-1"), userDir: join(base, "user") };
    idMap = createMcpIdMap({ dirs, server: "om" });
    logger = makeLogger();
    fake = fakePool();
    originalIdMapDeps = { ..._mcpIdMapDeps };
  });

  afterEach(() => {
    Object.assign(_mcpIdMapDeps, originalIdMapDeps);
    cleanupTempDir(base);
  });

  describe("a save over an unreadable id map", () => {
    test("the push rejects with MEMORY_MCP_ID_MAP_READ_FAILED (AC-1)", async () => {
      _mcpIdMapDeps.readText = async () => {
        throw fsError("EACCES");
      };
      fake.respond = () => answer('{"results":[{"id":"r1","event":"ADD"}]}');

      const error = await rejection(make().push(saveRequest()));

      expect(error).toMatchObject({ code: "MEMORY_MCP_ID_MAP_READ_FAILED", context: { retryable: true } });
    });

    test("the rejection is not a permanent refusal, so the outbox retries (AC-2)", async () => {
      _mcpIdMapDeps.readText = async () => {
        throw fsError("EACCES");
      };
      fake.respond = () => answer('{"results":[{"id":"r1","event":"ADD"}]}');

      const error = await rejection(make().push(saveRequest()));

      expect(isMemoryPushRejected(error)).toBe(false);
    });
  });

  describe("a forget whose delete the server answered isError", () => {
    beforeEach(async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
      fake.respond = (call) => (call.input.memory_id === "r1" ? answer("no such memory", true) : answer("ok"));
    });

    test("the push rejects with a retryable bad response (AC-3)", async () => {
      const error = await rejection(make().push(forgetRequest()));

      expect(error).toBeInstanceOf(NaxError);
      expect(error).toMatchObject({ code: "MEMORY_MCP_FORGET_BAD_RESPONSE", context: { retryable: true } });
    });

    test("the rejection is a bad response, so the drain counts it (AC-4)", async () => {
      const error = await rejection(make().push(forgetRequest()));

      expect(isMemoryBadResponse(error)).toBe(true);
    });

    test("the message names the tool that failed (AC-5)", async () => {
      const error = await rejection(make().push(forgetRequest()));

      expect(error.message).toContain('tool "delete_memory" failed');
    });

    test("the message carries the server's own text (AC-6)", async () => {
      const error = await rejection(make().push(forgetRequest()));

      expect(error.message).toContain("no such memory");
    });

    test("every recorded id is deleted, in order (AC-7)", async () => {
      await rejection(make().push(forgetRequest()));

      expect(fake.calls.map((call) => [call.tool, call.input])).toEqual([
        ["delete_memory", { memory_id: "r1" }],
        ["delete_memory", { memory_id: "r2" }],
      ]);
    });

    test("the id whose delete failed stays recorded (AC-8)", async () => {
      await rejection(make().push(forgetRequest()));

      expect(await idMap.ids("project", "s1")).toEqual(["r1"]);
    });

    test("the failed delete warns once, naming the server, the id and the text (AC-9)", async () => {
      await rejection(make().push(forgetRequest()));

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("memory", "memory mcp forget failed", {
        server: "om",
        id: "r1",
        error: "no such memory",
      });
    });
  });

  describe("a forget whose delete threw", () => {
    /** The pool throws for the first delete and answers every later one with `rest`. */
    function throwOnFirstDelete(rest: McpCallResult): void {
      let first = true;
      fake.respond = () => {
        if (first) {
          first = false;
          throw new Error("socket closed");
        }
        return rest;
      };
    }

    beforeEach(async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
    });

    test("the push rejects with MEMORY_MCP_CALL_FAILED (AC-10)", async () => {
      throwOnFirstDelete(answer("ok"));

      const error = await rejection(make().push(forgetRequest()));

      expect(error.code).toBe("MEMORY_MCP_CALL_FAILED");
    });

    test("the rejection is not a bad response, so the drain does not count it (AC-11)", async () => {
      throwOnFirstDelete(answer("ok"));

      const error = await rejection(make().push(forgetRequest()));

      expect(isMemoryBadResponse(error)).toBe(false);
    });

    test("the id whose delete threw stays recorded (AC-12)", async () => {
      throwOnFirstDelete(answer("ok"));

      await rejection(make().push(forgetRequest()));

      expect(await idMap.ids("project", "s1")).toEqual(["r1"]);
    });

    test("a delete that threw is a transport failure, whatever the other deletes answered (AC-13)", async () => {
      throwOnFirstDelete(answer("no such memory", true));

      const error = await rejection(make().push(forgetRequest()));

      expect(error.code).toBe("MEMORY_MCP_CALL_FAILED");
      expect(fake.calls.map((call) => call.input.memory_id)).toEqual(["r1", "r2"]);
    });
  });

  describe("a forget whose every delete the server answered isError", () => {
    beforeEach(async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
      fake.respond = () => answer("no such memory", true);
    });

    test("the push rejects with MEMORY_MCP_FORGET_BAD_RESPONSE (AC-14)", async () => {
      const error = await rejection(make().push(forgetRequest()));

      expect(error.code).toBe("MEMORY_MCP_FORGET_BAD_RESPONSE");
    });

    test("every id stays recorded (AC-15)", async () => {
      await rejection(make().push(forgetRequest()));

      expect(await idMap.ids("project", "s1")).toEqual(["r1", "r2"]);
    });
  });

  describe("a forget of one id the server answered isError with no text", () => {
    beforeEach(async () => {
      await idMap.add("project", "s1", ["r1"]);
      fake.respond = () => answer("", true);
    });

    test("the push rejects with MEMORY_MCP_FORGET_BAD_RESPONSE (AC-16)", async () => {
      const error = await rejection(make().push(forgetRequest()));

      expect(error.code).toBe("MEMORY_MCP_FORGET_BAD_RESPONSE");
    });

    test("the id stays recorded (AC-17)", async () => {
      await rejection(make().push(forgetRequest()));

      expect(await idMap.ids("project", "s1")).toEqual(["r1"]);
    });
  });

  describe("the retry of a forget whose first delete failed", () => {
    beforeEach(async () => {
      await idMap.add("project", "s1", ["r1", "r2"]);
      fake.respond = (call) => (call.input.memory_id === "r1" ? answer("no such memory", true) : answer("ok"));
    });

    test("the retry deletes only the id that is left (AC-18)", async () => {
      await rejection(make().push(forgetRequest()));
      fake.calls.length = 0;
      fake.respond = () => answer("ok");

      await make().push(forgetRequest());

      expect(fake.calls.map((call) => [call.tool, call.input])).toEqual([["delete_memory", { memory_id: "r1" }]]);
    });

    test("the retry resolves deleted with the client id (AC-19)", async () => {
      await rejection(make().push(forgetRequest()));
      fake.respond = () => answer("ok");

      expect(await make().push(forgetRequest())).toEqual({ id: "c-forget", status: "deleted" });
    });

    test("the retry forgets the id it deleted (AC-20)", async () => {
      await rejection(make().push(forgetRequest()));
      fake.respond = () => answer("ok");

      await make().push(forgetRequest());

      expect(await idMap.ids("project", "s1")).toEqual([]);
    });
  });
});
