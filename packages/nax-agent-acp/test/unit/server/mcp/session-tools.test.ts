import { describe, expect, test } from "bun:test";
import type { McpCallOptions, McpCallResult, McpConnection } from "@nathapp/nax-agent/mcp";
import { McpCallError } from "@nathapp/nax-agent/mcp";
import { createMcpSessionTools, MCP_CALL_TIMEOUT_MS, MCP_RESULT_BYTES } from "#src/server/mcp/session-tools";

interface FakeConnection extends McpConnection {
  readonly calls: { name: string; input: unknown; opts: McpCallOptions }[];
  exit(reason: string): void;
  readonly closed: () => number;
}

function fakeConnection(answer: (name: string) => Promise<McpCallResult>): FakeConnection {
  const calls: { name: string; input: unknown; opts: McpCallOptions }[] = [];
  const listeners: ((r: string) => void)[] = [];
  let closed = 0;
  return {
    kind: "stdio",
    pid: null,
    tools: [],
    calls,
    call: async (name, input, opts) => {
      calls.push({ name, input, opts });
      return answer(name);
    },
    onClose: (l) => listeners.push(l),
    close: async () => {
      closed += 1;
    },
    exit: (reason) => {
      for (const l of listeners) l(reason);
    },
    closed: () => closed,
  };
}

const ok = async (): Promise<McpCallResult> => ({ text: "out sekret-value", isError: false, bytesBeforeCap: 16 });
const scrub = (t: string) => t.replaceAll("sekret-value", "[REDACTED]");
const CTX = { sessionId: "s", toolCallId: "c1", signal: new AbortController().signal };
const TOOL = {
  modelName: "git__status",
  server: "git",
  tool: "status",
  description: "[git] status",
  inputSchema: { type: "object", properties: {} },
};

function setup(answer = ok) {
  const connection = fakeConnection(answer);
  const disconnects: string[] = [];
  const tools = createMcpSessionTools({
    servers: [{ name: "git", connection }],
    tools: [TOOL],
    scrub,
    onDisconnect: (server, reason) => disconnects.push(`${server}: ${reason}`),
  });
  return { connection, tools, disconnects };
}

describe("McpSessionTools", () => {
  test("offers tools in ask (approval always) and full (never), none in none/read", () => {
    const { tools } = setup();
    expect(tools.embedderTools("none")).toEqual([]);
    expect(tools.embedderTools("read")).toEqual([]);
    expect(tools.embedderTools("ask").map((t) => [t.name, t.approval])).toEqual([["git__status", "always"]]);
    expect(tools.embedderTools("full").map((t) => [t.name, t.approval])).toEqual([["git__status", "never"]]);
    expect(tools.offersTools("ask")).toBe(true);
    expect(tools.offersTools("read")).toBe(false);
    expect(tools.connectedCount).toBe(1);
  });

  test("run calls the original tool name with the call bounds and scrubs the text", async () => {
    const { tools, connection } = setup();
    const [tool] = tools.embedderTools("full");
    const result = await tool?.run({ a: 1 }, CTX);
    expect(result).toEqual({ content: "out [REDACTED]", isError: false });
    expect(connection.calls[0]).toMatchObject({
      name: "status",
      input: { a: 1 },
      opts: { timeoutMs: MCP_CALL_TIMEOUT_MS, maxBytes: MCP_RESULT_BYTES, signal: CTX.signal },
    });
  });

  test("a McpCallError becomes a scrubbed error result naming the server", async () => {
    const { tools } = setup(async () => {
      throw new McpCallError("MCP call status failed: boom sekret-value");
    });
    const result = await tools.embedderTools("full")[0]?.run({}, CTX);
    expect(result).toEqual({
      content: "MCP server `git`: MCP call status failed: boom [REDACTED]",
      isError: true,
    });
  });

  test("an unexpected exit marks the server dead once: one onDisconnect, then error results without calling", async () => {
    const { tools, connection, disconnects } = setup();
    connection.exit("the server process exited");
    connection.exit("again");
    expect(disconnects).toEqual(["git: the server process exited"]);
    const result = await tools.embedderTools("ask")[0]?.run({}, CTX);
    expect(result).toEqual({
      content: "MCP server `git` disconnected: the server process exited; reopen the session to reconnect",
      isError: true,
    });
    expect(connection.calls).toHaveLength(0);
  });

  test("a tool whose server is not connected is an error result and is not called", async () => {
    const connection = fakeConnection(ok);
    const tools = createMcpSessionTools({
      servers: [{ name: "git", connection }],
      tools: [{ ...TOOL, modelName: "other__status", server: "other" }],
      scrub,
      onDisconnect: () => {},
    });
    const result = await tools.embedderTools("full")[0]?.run({}, CTX);
    expect(result).toEqual({ content: "MCP server `other` is not connected", isError: true });
    expect(connection.calls).toHaveLength(0);
  });

  test("titleFor maps model names to `server: tool`", () => {
    const { tools } = setup();
    expect(tools.titleFor("git__status")).toBe("git: status");
    expect(tools.titleFor("Read")).toBeUndefined();
  });

  test("an HTTP call failure is an error result and never a disconnect notice", async () => {
    const http: FakeConnection = {
      ...fakeConnection(async () => {
        throw new McpCallError("MCP call status failed: fetch failed");
      }),
      kind: "http",
    };
    const disconnects: string[] = [];
    const tools = createMcpSessionTools({
      servers: [{ name: "web", connection: http }],
      tools: [{ ...TOOL, modelName: "web__status", server: "web" }],
      scrub,
      onDisconnect: (server) => disconnects.push(server),
    });
    const result = await tools.embedderTools("full")[0]?.run({}, CTX);
    expect(result).toEqual({ content: "MCP server `web`: MCP call status failed: fetch failed", isError: true });
    expect(disconnects).toEqual([]);
  });

  test("closeAll closes every connection once and suppresses disconnect notices", async () => {
    const { tools, connection, disconnects } = setup();
    await tools.closeAll();
    await tools.closeAll();
    connection.exit("closed by us");
    expect(connection.closed()).toBe(1);
    expect(disconnects).toEqual([]);
  });
});
