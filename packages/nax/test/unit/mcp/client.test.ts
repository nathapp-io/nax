import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectMcpOptions, McpTransportConfig, McpConnection as SharedConnection } from "@nathapp/nax-agent/mcp";
import { _mcpClientDeps, connectMcpServer } from "@/mcp/client";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

interface FakeCallResult {
  text: string;
  isError: boolean;
  bytesBeforeCap: number;
}

/** A fake of the SHARED connection (`@nathapp/nax-agent/mcp`), assigned at the adapter's `_mcpClientDeps.connect` seam. */
function fakeShared(
  over: {
    pid?: number | null;
    tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
    call?: (name: string) => FakeCallResult;
    rejectConnect?: Error;
  } = {},
): {
  closed: string[];
  calls: { config: McpTransportConfig; opts: ConnectMcpOptions }[];
} {
  const closed: string[] = [];
  const calls: { config: McpTransportConfig; opts: ConnectMcpOptions }[] = [];
  const connection: SharedConnection = {
    kind: "stdio",
    pid: over.pid ?? 4242,
    tools: over.tools ?? [],
    call: async (name) => (over.call ? over.call(name) : { text: "", isError: false, bytesBeforeCap: 0 }),
    onClose: () => {},
    close: async () => void closed.push("connection"),
  };
  Object.assign(_mcpClientDeps, {
    connect: async (config: McpTransportConfig, opts: ConnectMcpOptions) => {
      calls.push({ config, opts });
      if (over.rejectConnect) throw over.rejectConnect;
      return connection;
    },
  });
  return { closed, calls };
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
    fakeShared({});
    const conn = await connect();
    expect(conn.pid).toBe(4242);
    await conn.close();
  });

  test("maps tool descriptors, defaulting a missing description", async () => {
    fakeShared({
      tools: [
        { name: "search_graph", description: "Search", inputSchema: { type: "object" } },
        { name: "bare", description: "", inputSchema: {} },
      ],
    });
    const conn = await connect();
    const tools = await conn.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search_graph", "bare"]);
    expect(tools[0]?.description).toBe("Search");
    expect(tools[1]?.description).toBe("");
    await conn.close();
  });

  test("hands the shared layer a stdio config and nax's client info", async () => {
    const { calls } = fakeShared({});
    await connect();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config).toEqual({ kind: "stdio", command: "fake", args: [], env: {}, cwd: "/w" });
    expect(calls[0]?.opts.timeoutMs).toBe(1000);
    expect(calls[0]?.opts.clientInfo).toEqual({ name: "nax", version: "1" });
    expect(calls[0]?.opts.signal).toBeInstanceOf(AbortSignal);
  });

  test("maps the shared call result onto nax's vocabulary", async () => {
    fakeShared({ call: () => ({ text: "a", isError: false, bytesBeforeCap: 27 }) });
    const conn = await connect();
    expect(await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 1000 })).toEqual({
      content: "a",
      isError: false,
      bytesPreTruncation: 27,
    });
    await conn.close();
  });

  test("carries the server's isError through as data", async () => {
    fakeShared({ call: () => ({ text: "boom", isError: true, bytesBeforeCap: 4 }) });
    const conn = await connect();
    expect(await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 1000 })).toMatchObject({
      isError: true,
      content: "boom",
    });
    await conn.close();
  });

  test("truncates to maxBytes and reports the pre-truncation size", async () => {
    fakeShared({ call: () => ({ text: "x".repeat(5000), isError: false, bytesBeforeCap: 5000 }) });
    const conn = await connect();
    const result = await conn.callTool("t", {}, { timeoutMs: 100, maxBytes: 100 });
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(100);
    expect(result.bytesPreTruncation).toBe(5000);
    await conn.close();
  });

  test("a rejecting connect() surfaces as a NaxError naming the server and the code", async () => {
    fakeShared({ rejectConnect: new Error("ENOENT") });
    expect(connect()).rejects.toThrow(/memory/);
    expect(connect()).rejects.toMatchObject({ code: "MCP_CONNECT_FAILED" });
  });

  test("close() closes the shared connection", async () => {
    const { closed } = fakeShared({});
    const conn = await connect();
    await conn.close();
    expect(closed).toContain("connection");
  });
});
