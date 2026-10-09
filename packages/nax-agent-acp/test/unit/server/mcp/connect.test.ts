import { describe, expect, test } from "bun:test";
import { McpConnectError, type McpConnection, type McpToolInfo, type McpTransportConfig } from "@nathapp/nax-agent/mcp";
import {
  bridgeTools,
  type Candidate,
  connectNothing,
  createMcpConnector,
  MCP_MAX_TOOLS,
} from "#src/server/mcp/connect";
import { parseMcpServers } from "#src/server/mcp/parse";

function connection(tools: readonly McpToolInfo[], closed: string[] = [], name = ""): McpConnection {
  return {
    kind: "stdio",
    tools,
    call: async () => ({ text: "", isError: false, bytesBeforeCap: 0 }),
    onClose: () => {},
    close: async () => {
      closed.push(name);
    },
  };
}

const tool = (name: string, extra: Partial<McpToolInfo> = {}): McpToolInfo => ({
  name,
  description: `d ${name}`,
  inputSchema: { type: "object", properties: {} },
  ...extra,
});

const signal = new AbortController().signal;
const stdio = (name: string, env: { name: string; value: string }[] = []) => ({ name, command: name, args: [], env });

describe("connectSessionMcp", () => {
  test("connects every server in parallel with the session cwd and builds named tools", async () => {
    const configs: McpTransportConfig[] = [];
    const connector = createMcpConnector({
      timeoutMs: 1000,
      clientVersion: "9.9.9",
      connect: async (config, opts) => {
        configs.push(config);
        expect(opts.timeoutMs).toBe(1000);
        expect(opts.clientInfo).toEqual({ name: "nax-agent", version: "9.9.9" });
        return connection([tool(config.kind === "stdio" ? `${config.command}-tool` : "h")]);
      },
    });
    const out = await connector({
      parsed: parseMcpServers([stdio("a"), stdio("b")]),
      cwd: "/work",
      signal,
      onDisconnect: () => {},
    });
    expect(configs.map((c) => c.kind === "stdio" && c.cwd)).toEqual(["/work", "/work"]);
    expect(out.tools.embedderTools("full").map((t) => t.name)).toEqual(["a__a-tool", "b__b-tool"]);
    expect(out.tools.embedderTools("full")[0]?.description).toBe("[a] d a-tool");
    expect(out.noticeLines).toEqual([]);
  });

  test("a failed server is skipped with a scrubbed line including its stderr tail; others connect", async () => {
    const connector = createMcpConnector({
      timeoutMs: 1000,
      clientVersion: "1",
      connect: async (config) => {
        if (config.kind === "stdio" && config.command === "bad")
          throw new McpConnectError("MCP connect failed: exit 1 using tok-secret-123", "no TOKEN tok-secret-123");
        return connection([tool("ok")]);
      },
    });
    const out = await connector({
      parsed: parseMcpServers([stdio("bad", [{ name: "API_TOKEN", value: "tok-secret-123" }]), stdio("good")]),
      cwd: "/w",
      signal,
      onDisconnect: () => {},
    });
    expect(out.tools.connectedCount).toBe(1);
    expect(out.noticeLines).toEqual([
      "`bad`: MCP connect failed: exit 1 using [REDACTED] (stderr: no TOKEN [REDACTED])",
    ]);
  });

  test("a hanging server times out without delaying the others past the timeout", async () => {
    const connector = createMcpConnector({
      timeoutMs: 100,
      clientVersion: "1",
      connect: async (config, opts) => {
        if (config.kind === "stdio" && config.command === "slow")
          return new Promise((_resolve, reject) =>
            setTimeout(
              () => reject(new McpConnectError(`MCP connect failed: timed out after ${opts.timeoutMs} ms`)),
              opts.timeoutMs,
            ),
          );
        return connection([tool("t")]);
      },
    });
    const started = Date.now();
    const out = await connector({
      parsed: parseMcpServers([stdio("slow"), stdio("fast")]),
      cwd: "/w",
      signal,
      onDisconnect: () => {},
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.tools.connectedCount).toBe(1);
    expect(out.noticeLines[0]).toContain("`slow`: MCP connect failed: timed out after 100 ms");
  });

  test("skipped parse lines come first; bad schemas and the tool limit add lines", async () => {
    const many = Array.from({ length: MCP_MAX_TOOLS + 1 }, (_, i) => tool(`t${i}`));
    const connector = createMcpConnector({
      timeoutMs: 1000,
      clientVersion: "1",
      connect: async (config) =>
        config.kind === "stdio" && config.command === "a"
          ? connection([tool("bad", { inputSchema: { type: "string" } }), ...many])
          : connection([tool("late")]),
    });
    const out = await connector({
      parsed: parseMcpServers([{ type: "sse", name: "old" }, stdio("a"), stdio("b")]),
      cwd: "/w",
      signal,
      onDisconnect: () => {},
    });
    expect(out.tools.embedderTools("full")).toHaveLength(MCP_MAX_TOOLS);
    expect(out.noticeLines).toEqual([
      "`old`: SSE transport is not supported",
      '`a`: tool `bad` dropped: input schema type must be "object"',
      `MCP tool limit (${MCP_MAX_TOOLS}) reached; dropped 2 tools: \`a\`: t200; \`b\`: late`,
    ]);
  });

  test("two tools of the same name collide: one is kept and one is dropped with a line", async () => {
    const connector = createMcpConnector({
      timeoutMs: 1000,
      clientVersion: "1",
      connect: async () => connection([tool("dup"), tool("dup")]),
    });
    const out = await connector({
      parsed: parseMcpServers([stdio("a")]),
      cwd: "/w",
      signal,
      onDisconnect: () => {},
    });
    expect(out.tools.embedderTools("full").map((t) => t.name)).toHaveLength(1);
    expect(out.noticeLines).toEqual(["`a`: tool `dup` dropped: duplicate name"]);
  });

  test("more than ten rejected schemas are capped with an and-N-more suffix", async () => {
    const badTools = Array.from({ length: 12 }, (_, i) => tool(`bad${i}`, { inputSchema: { type: "string" } }));
    const connector = createMcpConnector({
      timeoutMs: 1000,
      clientVersion: "1",
      connect: async () => connection(badTools),
    });
    const out = await connector({
      parsed: parseMcpServers([stdio("a")]),
      cwd: "/w",
      signal,
      onDisconnect: () => {},
    });
    expect(out.noticeLines).toHaveLength(10);
    expect(out.noticeLines[9]).toBe('`a`: tool `bad9` dropped: input schema type must be "object"; and 2 more');
  });

  test("a named tool with no matching candidate info is skipped", () => {
    const candidates: Candidate[] = [{ server: "a", tool: "t", info: tool("t") }];
    const out = bridgeTools(candidates, [
      { server: "a", tool: "t", modelName: "a__t" },
      { server: "a", tool: "ghost", modelName: "a__ghost" },
    ]);
    expect(out.map((t) => t.tool)).toEqual(["t"]);
  });

  test("an aborted signal closes what connected and rejects", async () => {
    const closed: string[] = [];
    const controller = new AbortController();
    const connector = createMcpConnector({
      timeoutMs: 1000,
      clientVersion: "1",
      connect: async () => {
        controller.abort();
        return connection([tool("t")], closed, "x");
      },
    });
    await expect(
      connector({
        parsed: parseMcpServers([stdio("a")]),
        cwd: "/w",
        signal: controller.signal,
        onDisconnect: () => {},
      }),
    ).rejects.toThrow("aborted");
    expect(closed).toEqual(["x"]);
  });

  test("connectNothing returns no tools and no lines", async () => {
    const out = await connectNothing({
      parsed: parseMcpServers([stdio("a")]),
      cwd: "/w",
      signal,
      onDisconnect: () => {},
    });
    expect(out.tools.connectedCount).toBe(0);
    expect(out.noticeLines).toEqual([]);
  });
});
