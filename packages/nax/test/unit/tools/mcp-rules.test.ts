import { describe, expect, test } from "bun:test";
import { expandMcpRuleGrants, mcpRuleAdmits, partitionMcpRules } from "@/tools";

describe("partitionMcpRules", () => {
  test("Mcp entries leave the grant list and their patterns are returned", () => {
    const { grants, mcpPatterns } = partitionMcpRules([
      { tool: "Read", patterns: ["*"] },
      { tool: "Mcp", patterns: ["context7", "graph:query"] },
      { tool: "Bash", patterns: ["bun test *"] },
    ]);
    expect(grants.map((grant) => grant.tool)).toEqual(["Read", "Bash"]);
    expect(mcpPatterns).toEqual(["context7", "graph:query"]);
  });

  test("several Mcp expressions merge, never overwrite", () => {
    const { mcpPatterns } = partitionMcpRules([
      { tool: "Mcp", patterns: ["a"] },
      { tool: "Mcp", patterns: ["b:one"] },
    ]);
    expect([...mcpPatterns].sort()).toEqual(["a", "b:one"]);
  });

  test("a list with no Mcp entry is returned unchanged", () => {
    const grants = [{ tool: "Read", patterns: ["*"] }];
    expect(partitionMcpRules(grants)).toEqual({ grants, mcpPatterns: [] });
  });
});

describe("mcpRuleAdmits", () => {
  test.each([
    [["context7"], "context7", "query-docs", true],
    [["context7"], "graph", "query-docs", false],
    [["context7:query-docs"], "context7", "query-docs", true],
    [["context7:query-docs"], "context7", "resolve-id", false],
    [["context7:*"], "context7", "anything", true],
    [["*"], "context7", "query-docs", true],
    [[], "context7", "query-docs", false],
  ])("%o admits %s__%s -> %s", (patterns, providerId, localName, expected) => {
    expect(mcpRuleAdmits(patterns, providerId, localName)).toBe(expected);
  });
});

describe("expandMcpRuleGrants", () => {
  test('expands to concrete namespaced grants, never the key "Mcp"', () => {
    const grants = expandMcpRuleGrants(
      ["context7:query-docs"],
      [
        { providerId: "context7", localNames: ["query-docs", "resolve-id"] },
        { providerId: "graph", localNames: ["query"] },
      ],
    );
    expect(grants).toEqual([{ tool: "context7__query-docs", patterns: ["*"] }]);
    expect(grants.some((grant) => grant.tool === "Mcp")).toBe(false);
  });

  test("a server-level pattern expands to every surviving tool of that server", () => {
    const grants = expandMcpRuleGrants(
      ["context7"],
      [{ providerId: "context7", localNames: ["query-docs", "resolve-id"] }],
    );
    expect(grants.map((grant) => grant.tool)).toEqual(["context7__query-docs", "context7__resolve-id"]);
  });
});
