import { describe, expect, test } from "bun:test";
import * as resources from "@/resources";

const origin = { kind: "claude-project" } as const;
const path = "/repo/.mcp.json";

function parse(servers: Record<string, unknown>) {
  return resources.parseMcpJson(path, JSON.stringify({ mcpServers: servers }), origin, "project");
}

describe("parseMcpJson", () => {
  test.each([
    {
      label: "AC-5",
      entry: { command: "npx", args: ["x"] },
      transport: "stdio",
      server: { transport: "stdio", command: "npx", args: ["x"], env: {} },
    },
    {
      label: "AC-6",
      entry: { type: "http", url: "https://h" },
      transport: "http",
      server: { transport: "http", url: "https://h", headers: {} },
    },
    {
      label: "sse wins over command",
      entry: { type: "sse", command: "unused", url: "https://s" },
      transport: "sse",
      server: { transport: "sse", url: "https://s", headers: {} },
    },
  ] satisfies {
    label: string;
    entry: Record<string, unknown>;
    transport: resources.McpServerResource["transport"];
    server: resources.McpServerSpec;
  }[])("$label parses transport", ({ entry, transport, server }) => {
    expect(parse({ ctx: entry })).toEqual({
      resources: [{ kind: "mcp", name: "ctx", transport, scope: "project", server, path, origin }],
      diagnostics: [],
    });
  });
  test("AC-7 skips invalid entries with warnings, preserving valid siblings", () => {
    const result = resources.parseMcpJson(
      path,
      '{"mcpServers":{"ctx":{"url":"https://h"},"ok":{"command":"npx"},"bad":null}}',
      origin,
      "project",
    );
    expect(result.resources).toEqual([
      {
        kind: "mcp",
        name: "ok",
        transport: "stdio",
        scope: "project",
        server: { transport: "stdio", command: "npx", args: [], env: {} },
        path,
        origin,
      },
    ]);
    expect(result.diagnostics).toEqual(
      ["ctx", "bad"].map((name) => ({ severity: "warn", path, origin, message: expect.stringContaining(name) })),
    );
    expect(
      resources.parseMcpJson(path, '{"mcpServers":{"ctx":{"url":"https://h"}}}', origin, "project").resources,
    ).toEqual([]);
  });
  test.each(["not JSON", "{broken"])("AC-8 malformed JSON %s yields one error", (text) => {
    expect(resources.parseMcpJson(path, text, origin, "project")).toEqual({
      resources: [],
      diagnostics: [{ severity: "error", path, origin, message: expect.any(String) }],
    });
  });
  test.each(["{}", "null", "[]", '{"mcpServers":[]}', '{"mcpServers":42}'])(
    "handles non-server objects %s without throwing",
    (text) => {
      const result = resources.parseMcpJson(path, text, origin, "project");
      expect(result.resources).toEqual([]);
      expect(result.diagnostics.length).toBeLessThanOrEqual(1);
    },
  );

  test("US-003 AC-1/2 keeps the stdio spec and project scope", () => {
    const result = parse({ ctx: { command: "npx", args: ["x"], env: { K: "v" } } });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.server).toEqual({ transport: "stdio", command: "npx", args: ["x"], env: { K: "v" } });
    expect(result.resources[0]?.scope).toBe("project");
  });
  test("US-003 AC-3/4 defaults stdio args and env", () => {
    const server = parse({ ctx: { command: "npx" } }).resources[0]?.server;
    expect(server).toMatchObject({ args: [], env: {} });
  });
  test("US-003 AC-5/6 keeps http headers and defaults them to {}", () => {
    expect(parse({ r: { type: "http", url: "https://h", headers: { A: "b" } } }).resources[0]?.server).toEqual({
      transport: "http",
      url: "https://h",
      headers: { A: "b" },
    });
    expect(parse({ r: { type: "http", url: "https://h" } }).resources[0]?.server).toMatchObject({ headers: {} });
  });
  test("US-003 AC-7 sse entry has transport sse", () => {
    expect(parse({ s: { type: "sse", url: "https://s" } }).resources[0]?.transport).toBe("sse");
  });
  test.each([
    { label: "AC-8/9 http without url", name: "r", entry: { type: "http" } },
    { label: "AC-10/11 args not an array", name: "c", entry: { command: "npx", args: "x" } },
    { label: "args array with a non-string", name: "c", entry: { command: "npx", args: ["x", 1] } },
    { label: "AC-12/13 env value not a string", name: "c", entry: { command: "npx", env: { K: 1 } } },
    { label: "env not an object", name: "c", entry: { command: "npx", env: "K=v" } },
    {
      label: "AC-17/18 header value not a string",
      name: "r",
      entry: { type: "http", url: "https://h", headers: { A: 1 } },
    },
    { label: "headers an array", name: "r", entry: { type: "http", url: "https://h", headers: ["A"] } },
    { label: "AC-19/20 sse without url", name: "s", entry: { type: "sse" } },
  ])("$label yields one warn diagnostic and no resource", ({ name, entry }) => {
    expect(parse({ [name]: entry })).toEqual({
      resources: [],
      diagnostics: [
        {
          severity: "warn",
          path,
          origin,
          message: `[resources] Unsupported MCP entry ${name} in ${path}`,
        },
      ],
    });
  });
});

describe("parseMcpServers", () => {
  test("US-003 AC-14 stamps the given scope on each resource", () => {
    const result = resources.parseMcpServers(path, { ctx: { command: "npx" } }, origin, "user");
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.scope).toBe("user");
  });
});
