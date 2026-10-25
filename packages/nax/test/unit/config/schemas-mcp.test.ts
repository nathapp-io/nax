import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";
import { McpConfigSchema } from "@/config/schemas-mcp";

const server = { command: "codebase-memory-mcp", stages: ["run"] };

describe("McpConfigSchema", () => {
  test("parses two servers with disjoint stages", () => {
    const parsed = McpConfigSchema.parse({
      servers: {
        "codebase-memory": { ...server, allowedTools: ["search_graph"] },
        docs: { command: "docs-mcp", stages: ["review"] },
      },
    });
    expect(Object.keys(parsed.servers)).toEqual(["codebase-memory", "docs"]);
    expect(parsed.servers["codebase-memory"]?.stages).toEqual(["run"]);
    expect(parsed.servers.docs?.stages).toEqual(["review"]);
  });

  test("applies defaults: args, env, timeoutMs, enabled", () => {
    const parsed = McpConfigSchema.parse({ servers: { a: { command: "x" } } });
    expect(parsed.servers.a).toEqual({
      command: "x",
      args: [],
      env: {},
      headers: {},
      stages: [],
      timeoutMs: 60_000,
      enabled: true,
    });
  });

  test("rejects an unknown key inside a server block", () => {
    const result = McpConfigSchema.safeParse({ servers: { a: { command: "x", stage: ["run"] } } });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown stage name", () => {
    // There is no `implement` stage — implementation runs under `run`.
    expect(McpConfigSchema.safeParse({ servers: { a: { command: "x", stages: ["implement"] } } }).success).toBe(false);
  });

  test("accepts the wildcard stage", () => {
    expect(McpConfigSchema.parse({ servers: { a: { command: "x", stages: ["*"] } } }).servers.a?.stages).toEqual(["*"]);
  });

  test("rejects a server id that is not a valid provider id", () => {
    for (const bad of ["Codebase", "-leading", "has space", "double__underscore", ""]) {
      expect(McpConfigSchema.safeParse({ servers: { [bad]: { command: "x" } } }).success).toBe(false);
    }
  });

  test("rejects an empty command", () => {
    expect(McpConfigSchema.safeParse({ servers: { a: { command: "" } } }).success).toBe(false);
  });

  describe("HTTP servers (US-002)", () => {
    const EXACTLY_ONE = "set exactly one of command or url";
    const messages = (input: unknown): string[] => {
      const result = McpConfigSchema.safeParse(input);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };

    test("AC-7: a url-only server parses with its url", () => {
      expect(McpConfigSchema.parse({ servers: { a: { url: "https://h/mcp" } } }).servers.a?.url).toBe("https://h/mcp");
    });

    test("AC-8: headers default to {} for a url server", () => {
      expect(McpConfigSchema.parse({ servers: { a: { url: "https://h/mcp" } } }).servers.a?.headers).toEqual({});
    });

    test("AC-9: configured headers are kept literally", () => {
      const parsed = McpConfigSchema.parse({
        servers: { a: { url: "https://h/mcp", headers: { Authorization: "Bearer t" } } },
      });
      expect(parsed.servers.a?.headers.Authorization).toBe("Bearer t");
    });

    test("AC-10: command together with url is rejected", () => {
      expect(messages({ servers: { a: { command: "x", url: "https://h" } } })).toContain(EXACTLY_ONE);
    });

    test("AC-11: neither command nor url is rejected", () => {
      expect(messages({ servers: { a: { args: ["x"] } } })).toContain(EXACTLY_ONE);
    });

    test("AC-12: a malformed url is rejected", () => {
      expect(McpConfigSchema.safeParse({ servers: { a: { url: "not a url" } } }).success).toBe(false);
    });

    test("AC-13: a stdio server also gets headers {}", () => {
      expect(McpConfigSchema.parse({ servers: { a: { command: "x" } } }).servers.a?.headers).toEqual({});
    });
  });

  test("mounts on NaxConfigSchema and defaults to no servers", () => {
    const config = NaxConfigSchema.parse({ name: "x" });
    expect(config.mcp).toEqual({ servers: {} });
  });
});
