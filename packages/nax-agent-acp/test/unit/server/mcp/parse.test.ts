import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { assertCaughtInstanceOf } from "@nathapp/nax-test-kit/bun/assert-caught";
import { MCP_MAX_SERVERS, parseMcpServers } from "#src/server/mcp/parse";

const stdio = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  command: "srv",
  args: [],
  env: [],
  ...extra,
});
const http = (name: string, url = "https://mcp.example.com/x") => ({ type: "http", name, url, headers: [] });

describe("parseMcpServers", () => {
  test("an entry with no type is stdio; env and headers become records", () => {
    const out = parseMcpServers([
      stdio("fs", { args: ["--root", "/w"], env: [{ name: "TOKEN", value: "t" }] }),
      { type: "http", name: "web", url: "https://h/mcp", headers: [{ name: "X-A", value: "1" }] },
    ]);
    expect(out.servers).toEqual([
      { kind: "stdio", name: "fs", command: "srv", args: ["--root", "/w"], env: { TOKEN: "t" } },
      { kind: "http", name: "web", url: "https://h/mcp", headers: { "X-A": "1" } },
    ]);
    expect(out.skipped).toEqual([]);
  });

  test("missing args and env are empty (M-40)", () => {
    expect(parseMcpServers([{ name: "a", command: "c" }]).servers).toEqual([
      { kind: "stdio", name: "a", command: "c", args: [], env: {} },
    ]);
  });

  test("sse, acp and unknown types are skipped with a line", () => {
    const out = parseMcpServers([
      { type: "sse", name: "old", url: "https://h/sse", headers: [] },
      { type: "acp", name: "tunnel", serverId: "x" },
      { type: "carrier-pigeon", name: "p" },
    ]);
    expect(out.servers).toEqual([]);
    expect(out.skipped).toEqual([
      "`old`: SSE transport is not supported",
      "`tunnel`: ACP-tunnelled MCP is not supported",
      '`p`: unsupported transport type "carrier-pigeon"',
    ]);
  });

  test("semantic problems skip the server (I8)", () => {
    const out = parseMcpServers([
      stdio("blank", { command: "  " }),
      http("ftp", "ftp://h/x"),
      http("bad", "not a url"),
      stdio("dup"),
      stdio("dup"),
      stdio(""),
    ]);
    expect(out.servers.map((s) => s.name)).toEqual(["dup"]);
    expect(out.skipped).toEqual([
      "`blank`: empty command",
      "`ftp`: url must be http or https",
      "`bad`: url is not valid",
      "`dup`: duplicate server name (the first one is used)",
      "a server with an empty name was skipped",
    ]);
  });

  test("servers past the limit are not started", () => {
    const many = Array.from({ length: MCP_MAX_SERVERS + 2 }, (_, i) => stdio(`s${i}`));
    const out = parseMcpServers(many);
    expect(out.servers).toHaveLength(MCP_MAX_SERVERS);
    expect(out.skipped).toEqual([`MCP server limit (${MCP_MAX_SERVERS}) reached; not started: \`s20\`, \`s21\``]);
  });

  test("more than ten servers past the limit are listed only up to the cap", () => {
    const many = Array.from({ length: MCP_MAX_SERVERS + 12 }, (_, i) => stdio(`s${i}`));
    const [line = ""] = parseMcpServers(many).skipped;
    expect(line.startsWith(`MCP server limit (${MCP_MAX_SERVERS}) reached; not started: `)).toBe(true);
    expect(line).toMatch(/; and 2 more$/);
    expect(line.split(", ")).toHaveLength(10);
  });

  test("names are control-stripped in lines", () => {
    expect(parseMcpServers([stdio("a\u0007b", { command: "" })]).skipped).toEqual(["`ab`: empty command"]);
  });

  test.each([
    ["not an object", ["x"]],
    ["name not a string", [{ name: 1, command: "c" }]],
    ["command not a string", [{ name: "a", command: 1 }]],
    ["args not strings", [{ name: "a", command: "c", args: [1] }]],
    ["env item not name/value", [{ name: "a", command: "c", env: [{ name: "K" }] }]],
    ["http url not a string", [{ type: "http", name: "a", url: 1, headers: [] }]],
    ["http headers not name/value", [{ type: "http", name: "a", url: "https://h", headers: ["x"] }]],
    ["type not a string", [{ type: 3, name: "a" }]],
  ])("structural: %s -> invalid_params naming the index", (_label, raw) => {
    let error: unknown;
    try {
      parseMcpServers(raw as unknown[]);
    } catch (e) {
      error = e;
    }
    assertCaughtInstanceOf(error, RequestError);
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("mcpServers[0]");
  });
});
