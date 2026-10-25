import { describe, expect, test } from "bun:test";
import * as resources from "@/resources";

const origin = { kind: "claude-project" } as const;
const path = "/repo/.mcp.json";

describe("parseMcpJson", () => {
  test.each([
    ["AC-5", { command: "npx", args: ["x"] }, "stdio"],
    ["AC-6", { type: "http", url: "https://h" }, "http"],
    ["sse wins over command", { type: "sse", command: "unused" }, "sse"],
  ])("%s parses transport", (_, entry, transport) => {
    expect(resources.parseMcpJson(path, JSON.stringify({ mcpServers: { ctx: entry } }), origin)).toEqual({
      resources: [{ kind: "mcp", name: "ctx", transport, path, origin }],
      diagnostics: [],
    });
  });
  test("AC-7 skips invalid entries with warnings, preserving valid siblings", () => {
    const result = resources.parseMcpJson(
      path,
      '{"mcpServers":{"ctx":{"url":"https://h"},"ok":{"command":"npx"},"bad":null}}',
      origin,
    );
    expect(result.resources).toEqual([{ kind: "mcp", name: "ok", transport: "stdio", path, origin }]);
    expect(result.diagnostics).toEqual(
      ["ctx", "bad"].map((name) => ({ severity: "warn", path, origin, message: expect.stringContaining(name) })),
    );
    expect(resources.parseMcpJson(path, '{"mcpServers":{"ctx":{"url":"https://h"}}}', origin).resources).toEqual([]);
  });
  test.each(["not JSON", "{broken"])("AC-8 malformed JSON %s yields one error", (text) => {
    expect(resources.parseMcpJson(path, text, origin)).toEqual({
      resources: [],
      diagnostics: [{ severity: "error", path, origin, message: expect.any(String) }],
    });
  });
  test.each(["{}", "null", "[]", '{"mcpServers":[]}', '{"mcpServers":42}'])(
    "handles non-server objects %s without throwing",
    (text) => {
      const result = resources.parseMcpJson(path, text, origin);
      expect(result.resources).toEqual([]);
      expect(result.diagnostics.length).toBeLessThanOrEqual(1);
    },
  );
});
