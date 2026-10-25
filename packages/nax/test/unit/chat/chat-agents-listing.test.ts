import { describe, expect, test } from "bun:test";
import { type ChatAgentRow, formatAgentsListing } from "@/chat";

function row(overrides: Partial<ChatAgentRow> = {}): ChatAgentRow {
  return {
    name: "reviewer",
    description: "Reviews diffs",
    model: "a/s",
    modelSource: "alias",
    tools: ["Read"],
    dropped: [],
    ...overrides,
  };
}

describe("formatAgentsListing", () => {
  test("AC-1 prints (no agents) for no rows", () => {
    expect(formatAgentsListing([])).toBe("(no agents)");
  });

  test("AC-2 AC-17 prints name, model with source, tools and description on one line", () => {
    expect(formatAgentsListing([row()])).toBe("reviewer  a/s (alias)  tools Read  Reviews diffs");
  });

  test("AC-3 prints tools all for an agent without a tools list", () => {
    expect(formatAgentsListing([row({ tools: "all" })])).toContain("  tools all  ");
  });

  test("AC-4 prints tools none for an empty tools list", () => {
    expect(formatAgentsListing([row({ tools: [] })])).toContain("  tools none  ");
  });

  test("prints several tools comma separated", () => {
    expect(formatAgentsListing([row({ tools: ["Read", "Grep"] })])).toContain("  tools Read, Grep  ");
  });

  test("AC-5 prints an indented dropped line after the agent line", () => {
    const text = formatAgentsListing([row({ dropped: [{ name: "WebFetch", reason: "no nax equivalent" }] })]);
    expect(text.split("\n")).toEqual([
      "reviewer  a/s (alias)  tools Read  Reviews diffs",
      "  dropped: WebFetch (no nax equivalent)",
    ]);
  });

  test("AC-6 cleans a multi-line description onto the agent's line", () => {
    const text = formatAgentsListing([row({ description: "a\nb" })]);
    expect(text).toBe("reviewer  a/s (alias)  tools Read  a b");
  });

  test("prints rows in order, each followed by its own dropped lines", () => {
    const text = formatAgentsListing([
      row({ name: "p:reviewer", dropped: [{ name: "X", reason: "r" }] }),
      row({ name: "planner", model: "m/n", modelSource: "inherit" }),
    ]);
    expect(text.split("\n")).toEqual([
      "p:reviewer  a/s (alias)  tools Read  Reviews diffs",
      "  dropped: X (r)",
      "planner  m/n (inherit)  tools Read  Reviews diffs",
    ]);
  });
});
