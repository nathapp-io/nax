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

  test("mounts on NaxConfigSchema and defaults to no servers", () => {
    const config = NaxConfigSchema.parse({ name: "x" });
    expect(config.mcp).toEqual({ servers: {} });
  });
});
