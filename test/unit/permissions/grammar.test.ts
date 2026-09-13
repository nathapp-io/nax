import { describe, expect, test } from "bun:test";
import { parseRuleList, parseToolExpression } from "@/permissions";

describe("parseToolExpression", () => {
  test.each([
    ["Read", { tool: "Read", patterns: ["*"] }],
    ["Write(src/**,test/**)", { tool: "Write", patterns: ["src/**", "test/**"] }],
    ["Git(diff,log)", { tool: "Git", patterns: ["diff", "log"] }],
    ["Bash(bun test *)", { tool: "Bash", patterns: ["bun test *"] }],
    ["Write()", { tool: "Write", patterns: ["*"] }],
    ["  Read  ", { tool: "Read", patterns: ["*"] }],
  ])("parses %s", (expression, expected) => {
    expect(parseToolExpression(expression)).toEqual(expected);
  });
});

describe("parseRuleList", () => {
  test("parses each expression into a grant", () => {
    expect(parseRuleList(["Read", "Write(src/**)"])).toEqual([
      { tool: "Read", patterns: ["*"] },
      { tool: "Write", patterns: ["src/**"] },
    ]);
  });

  test("empty list yields empty array", () => {
    expect(parseRuleList([])).toEqual([]);
  });
});
