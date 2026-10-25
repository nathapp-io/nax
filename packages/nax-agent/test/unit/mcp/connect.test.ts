import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectMcp } from "#src/mcp/connect";
import { McpCallError, McpConnectError } from "#src/mcp/errors";
import { _mcpTransportDeps, type TransportHandle } from "#src/mcp/transport";
import type { McpTransportConfig } from "#src/mcp/types";
import { assertCaughtInstanceOf } from "#test/helpers/index";
import { type FixtureCtx, type FixtureTool, inMemoryServer } from "#test/helpers/mcp-servers";

const CONFIG: McpTransportConfig = { kind: "http", url: "http://fixture.invalid/mcp", headers: {} };
const OPTS = { signal: new AbortController().signal, timeoutMs: 2000, clientInfo: { name: "t", version: "0" } };
const CALL = { signal: new AbortController().signal, timeoutMs: 2000, maxBytes: 10_000 };

const original = _mcpTransportDeps.create;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((close) => close()));
  } finally {
    _mcpTransportDeps.create = original;
    jest.useRealTimers();
  }
});

async function connectTo(tools: readonly FixtureTool[], pageSize?: number, instructions?: string) {
  const fixture = await inMemoryServer(tools, pageSize, instructions);
  cleanups.push(() => fixture.server.close());
  _mcpTransportDeps.create = (): TransportHandle => ({
    transport: fixture.clientTransport,
    pid: () => null,
    stderrTail: () => "",
  });
  const connection = await connectMcp(CONFIG, OPTS);
  cleanups.push(() => connection.close());
  return { fixture, connection };
}

describe("connectMcp", () => {
  test("AC-5: non-stdio never notifies onSpawn", async () => {
    const fixture = await inMemoryServer([]);
    cleanups.push(() => fixture.server.close());
    _mcpTransportDeps.create = () => ({
      transport: fixture.clientTransport,
      pid: () => null,
      stderrTail: () => "",
    });
    const onSpawn = jest.fn();
    const connection = await connectMcp(CONFIG, { ...OPTS, onSpawn });
    cleanups.push(() => connection.close());
    expect(connection.kind).toBe("http");
    expect(onSpawn).not.toHaveBeenCalled();
    await connection.close();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  test("lists every page of tools at connect", async () => {
    const names = ["a", "b", "c", "d", "e"];
    const { connection } = await connectTo(
      names.map((name) => ({ name, description: `tool ${name}` })),
      2,
    );
    expect(connection.tools.map((t) => t.name)).toEqual(names);
    expect(connection.tools[0]).toEqual({
      name: "a",
      description: "tool a",
      inputSchema: { type: "object", properties: {} },
    });
    await connection.close();
  });

  test("AC-1: a readOnlyHint of true yields readOnly true", async () => {
    const { connection } = await connectTo([{ name: "get", annotations: { readOnlyHint: true } }]);
    expect(connection.tools[0]?.readOnly).toBe(true);
    await connection.close();
  });

  test("AC-2: a readOnlyHint of false leaves no readOnly key", async () => {
    const { connection } = await connectTo([{ name: "put", annotations: { readOnlyHint: false } }]);
    expect(connection.tools[0]).toBeDefined();
    expect(connection.tools[0]).not.toHaveProperty("readOnly");
    await connection.close();
  });

  test("AC-3: a non-boolean readOnlyHint leaves no readOnly key", async () => {
    // The SDK's own tools/list schema rejects a string hint before connectMcp sees it, so the
    // defensive branch is reached by answering listTools with the raw page the SDK would not accept.
    const page = JSON.parse(
      '{"tools":[{"name":"put","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":"yes"}}]}',
    );
    const listTools = spyOn(Client.prototype, "listTools").mockResolvedValue(page);
    try {
      const { connection } = await connectTo([{ name: "put" }]);
      expect(listTools).toHaveBeenCalled();
      expect(connection.tools[0]).toBeDefined();
      expect(connection.tools[0]).not.toHaveProperty("readOnly");
      await connection.close();
    } finally {
      listTools.mockRestore();
    }
  });

  test("AC-4: a tool with no annotations keeps the exact { name, description, inputSchema } shape", async () => {
    const { connection } = await connectTo([{ name: "plain", description: "d" }]);
    expect(connection.tools[0]).toStrictEqual({
      name: "plain",
      description: "d",
      inputSchema: { type: "object", properties: {} },
    });
    await connection.close();
  });

  test("skips listed tools without a string name", async () => {
    const { connection } = await connectTo([{ name: "" }, { name: "ok" }]);
    expect(connection.tools.map((t) => t.name)).toEqual(["ok"]);
    await connection.close();
  });

  test("carries the server's initialize instructions", async () => {
    const { connection } = await connectTo([{ name: "a" }], undefined, "Call list_projects first");
    expect(connection.instructions).toBe("Call list_projects first");
    await connection.close();
  });

  test("a server with no initialize instructions leaves the field unset", async () => {
    const { connection } = await connectTo([{ name: "a" }]);
    expect(connection.instructions).toBeUndefined();
    await connection.close();
  });

  test("calls a tool and returns its text; isError is data, not a throw", async () => {
    const { connection, fixture } = await connectTo([
      { name: "echo", run: async (args) => ({ content: [{ type: "text", text: String(args.v) }] }) },
      { name: "fail", run: async () => ({ content: [{ type: "text", text: "no" }], isError: true }) },
    ]);
    expect(await connection.call("echo", { v: 7 }, CALL)).toEqual({ text: "7", isError: false, bytesBeforeCap: 1 });
    expect((await connection.call("fail", {}, CALL)).isError).toBe(true);
    expect(fixture.calls.map((c) => c.name)).toEqual(["echo", "fail"]);
    await connection.close();
  });

  test("a non-object input is sent as empty arguments", async () => {
    const { connection, fixture } = await connectTo([{ name: "echo" }]);
    await connection.call("echo", "not an object", CALL);
    expect(fixture.calls[0]?.args).toEqual({});
    await connection.close();
  });

  test("an aborted call throws McpCallError", async () => {
    const { connection } = await connectTo([
      {
        name: "slow",
        run: (_args, ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ content: [] }));
          }),
      },
    ]);
    const controller = new AbortController();
    const pending = connection.call("slow", {}, { ...CALL, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(McpCallError);
    await connection.close();
  });

  test("a call past timeoutMs throws McpCallError", async () => {
    const started = Promise.withResolvers<void>();
    const { connection } = await connectTo([
      {
        name: "hang",
        run: () => {
          started.resolve();
          return new Promise(() => {});
        },
      },
    ]);
    // The SDK owns the request timers and has no injectable clock seam.
    jest.useFakeTimers();
    let settled = false;
    const pending = connection.call("hang", {}, { ...CALL, timeoutMs: 50 }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started.promise;
    jest.advanceTimersByTime(49);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    jest.advanceTimersByTime(1);
    const error = await pending;
    assertCaughtInstanceOf(error, McpCallError);
    expect(error.message).toContain("Request timed out");
    await connection.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("progress notifications keep a slow call alive past timeoutMs", async () => {
    const started = Promise.withResolvers<FixtureCtx>();
    const finish = Promise.withResolvers<void>();
    const { connection } = await connectTo([
      {
        name: "slow",
        run: async (_args, ctx) => {
          started.resolve(ctx);
          await finish.promise;
          return { content: [{ type: "text", text: "done" }] };
        },
      },
    ]);
    jest.useFakeTimers();
    let settled = false;
    const pending = connection.call("slow", {}, { ...CALL, timeoutMs: 150 }).then(
      (result) => {
        settled = true;
        return result;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const ctx = await started.promise;
    try {
      for (let i = 1; i <= 3; i += 1) {
        jest.advanceTimersByTime(100);
        // Await delivery through the real SDK transport before moving time again.
        await ctx.progress(i);
        expect(settled).toBe(false);
        expect(jest.getTimerCount()).toBeGreaterThan(0);
      }
    } finally {
      finish.resolve();
    }
    expect(await pending).toEqual({ text: "done", isError: false, bytesBeforeCap: 4 });
    await connection.close();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a call after close throws McpCallError", async () => {
    const { connection } = await connectTo([{ name: "echo" }]);
    await connection.close();
    await connection.close(); // idempotent
    await expect(connection.call("echo", {}, CALL)).rejects.toBeInstanceOf(McpCallError);
  });

  test("a server that never answers initialize fails with McpConnectError within timeoutMs", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(
      () => clientTransport.close(),
      () => serverTransport.close(),
    );
    await serverTransport.start(); // accepts messages, never replies
    const started = Promise.withResolvers<void>();
    serverTransport.onmessage = (message) => {
      if ("method" in message && message.method === "initialize") started.resolve();
    };
    _mcpTransportDeps.create = () => ({ transport: clientTransport, pid: () => null, stderrTail: () => "" });
    jest.useFakeTimers();
    let settled = false;
    const pending = connectMcp(CONFIG, { ...OPTS, timeoutMs: 100 }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started.promise;
    jest.advanceTimersByTime(99);
    await Promise.resolve();
    expect(settled).toBe(false);
    // Advance the SDK request timeout even on runtimes with native abort timers.
    jest.advanceTimersByTime(1);
    const error = await pending;
    assertCaughtInstanceOf(error, McpConnectError);
    expect(error.message).toContain("timed out after 100 ms");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("an already-aborted signal fails connect with McpConnectError", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = await inMemoryServer([]);
    cleanups.push(() => fixture.server.close());
    _mcpTransportDeps.create = () => ({ transport: fixture.clientTransport, pid: () => null, stderrTail: () => "" });
    await expect(connectMcp(CONFIG, { ...OPTS, signal: controller.signal })).rejects.toBeInstanceOf(McpConnectError);
  });

  test("a transport that cannot be built fails with McpConnectError", async () => {
    _mcpTransportDeps.create = () => {
      throw new TypeError("Invalid URL");
    };
    await expect(connectMcp(CONFIG, OPTS)).rejects.toBeInstanceOf(McpConnectError);
  });
});
