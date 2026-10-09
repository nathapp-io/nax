import { afterEach, describe, expect, test } from "bun:test";
import { connectMcp } from "#src/mcp/connect";
import { McpCallError, McpConnectError } from "#src/mcp/errors";
import { _mcpTransportDeps, type TransportHandle } from "#src/mcp/transport";
import type { McpTransportConfig } from "#src/mcp/types";
import { assertCaughtInstanceOf } from "#test/helpers/index";
import { type FixtureTool, inMemoryServer } from "#test/helpers/mcp-servers";

const CONFIG: McpTransportConfig = { kind: "http", url: "http://fixture.invalid/mcp", headers: {} };
const OPTS = { signal: new AbortController().signal, timeoutMs: 2000, clientInfo: { name: "t", version: "0" } };
const CALL = { signal: new AbortController().signal, timeoutMs: 2000, maxBytes: 10_000 };

const original = _mcpTransportDeps.create;
afterEach(() => {
  _mcpTransportDeps.create = original;
});

async function connectTo(tools: readonly FixtureTool[], pageSize?: number) {
  const fixture = await inMemoryServer(tools, pageSize);
  _mcpTransportDeps.create = (): TransportHandle => ({
    transport: fixture.clientTransport,
    pid: () => null,
    stderrTail: () => "",
  });
  return { fixture, connection: await connectMcp(CONFIG, OPTS) };
}

describe("connectMcp", () => {
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

  test("skips listed tools without a string name", async () => {
    const { connection } = await connectTo([{ name: "" }, { name: "ok" }]);
    expect(connection.tools.map((t) => t.name)).toEqual(["ok"]);
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
    const { connection } = await connectTo([{ name: "hang", run: () => new Promise(() => {}) }]);
    await expect(connection.call("hang", {}, { ...CALL, timeoutMs: 50 })).rejects.toBeInstanceOf(McpCallError);
    await connection.close();
  });

  test("progress notifications keep a slow call alive past timeoutMs", async () => {
    const { connection } = await connectTo([
      {
        name: "slow",
        run: async (_args, ctx) => {
          for (let i = 1; i <= 3; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            await ctx.progress(i);
          }
          return { content: [{ type: "text", text: "done" }] };
        },
      },
    ]);
    expect((await connection.call("slow", {}, { ...CALL, timeoutMs: 150 })).text).toBe("done");
    await connection.close();
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
    await serverTransport.start(); // accepts messages, never replies
    _mcpTransportDeps.create = () => ({ transport: clientTransport, pid: () => null, stderrTail: () => "" });
    const started = Date.now();
    const error = await connectMcp(CONFIG, { ...OPTS, timeoutMs: 100 }).catch((e: unknown) => e);
    assertCaughtInstanceOf(error, McpConnectError);
    expect(error.message).toContain("timed out after 100 ms");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("an already-aborted signal fails connect with McpConnectError", async () => {
    const controller = new AbortController();
    controller.abort();
    const fixture = await inMemoryServer([]);
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
