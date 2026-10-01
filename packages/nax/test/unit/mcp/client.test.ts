import { afterEach, describe, expect, test } from "bun:test";
import { _mcpClientDeps, connectMcpServer } from "@/mcp/client";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

function fakeSdk(over: {
  tools?: unknown[];
  call?: (name: string, args: Record<string, unknown>) => unknown;
  connect?: () => Promise<void>;
}) {
  const closed: string[] = [];
  Object.assign(_mcpClientDeps, {
    createTransport: () => ({ pid: 4242, close: async () => void closed.push("transport") }),
    createClient: () => ({
      connect: over.connect ?? (async () => {}),
      listTools: async () => ({ tools: over.tools ?? [] }),
      callTool: async (params: { name: string; arguments: Record<string, unknown> }) =>
        over.call ? over.call(params.name, params.arguments) : { content: [] },
      close: async () => void closed.push("client"),
    }),
  });
  return closed;
}

const connect = () =>
  connectMcpServer({
    serverId: "memory",
    workdir: "/w",
    command: "fake",
    args: [],
    env: {},
    connectTimeoutMs: 1000,
  });

describe("connectMcpServer", () => {
  test("exposes the transport pid", async () => {
    fakeSdk({});
    const conn = await connect();
    expect(conn.pid).toBe(4242);
    await conn.close();
  });

  test("maps tool descriptors, defaulting a missing description", async () => {
    fakeSdk({
      tools: [
        { name: "search_graph", description: "Search", inputSchema: { type: "object" } },
        { name: "bare", inputSchema: { type: "object" } },
      ],
    });
    const conn = await connect();
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_graph", "bare"]);
    expect(tools[0]?.description).toBe("Search");
    expect(tools[1]?.description).toBe("");
    await conn.close();
  });

  test("joins text content blocks and reports non-text ones without dropping the result", async () => {
    fakeSdk({
      call: () => ({
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "..." },
          { type: "text", text: "b" },
        ],
      }),
    });
    const conn = await connect();
    const result = await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 1000 });
    expect(result.content).toBe("a\n[image content omitted]\nb");
    expect(result.isError).toBe(false);
    await conn.close();
  });

  test("carries the server's isError through as data", async () => {
    fakeSdk({ call: () => ({ isError: true, content: [{ type: "text", text: "boom" }] }) });
    const conn = await connect();
    expect(await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 1000 })).toMatchObject({
      isError: true,
      content: "boom",
    });
    await conn.close();
  });

  test("truncates to maxBytes and reports the pre-truncation size", async () => {
    fakeSdk({ call: () => ({ content: [{ type: "text", text: "x".repeat(5000) }] }) });
    const conn = await connect();
    const result = await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 100 });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(100);
    expect(result.bytesPreTruncation).toBe(5000);
    await conn.close();
  });

  test("a rejecting connect() surfaces as a NaxError naming the server", async () => {
    fakeSdk({
      connect: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(connect()).rejects.toThrow(/memory/);
  });

  test("close() closes the client", async () => {
    const closed = fakeSdk({});
    const conn = await connect();
    await conn.close();
    expect(closed).toContain("client");
  });
});
