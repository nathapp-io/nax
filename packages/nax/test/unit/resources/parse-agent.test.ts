import { describe, expect, test } from "bun:test";
import * as resources from "@/resources";

const origin = { kind: "claude-user" } as const;
const path = "/agents/reviewer.md";
const agent = (fields: string) => `---\n${fields}\n---\nInstructions`;

describe("parseAgentFile", () => {
  test("AC-1 returns required metadata and optional model", () => {
    expect(
      resources.parseAgentFile(path, agent("name: code-reviewer\ndescription: Reviews\nmodel: sonnet"), origin),
    ).toEqual({
      resource: {
        kind: "agent",
        name: "code-reviewer",
        qualifiedName: "code-reviewer",
        description: "Reviews",
        model: "sonnet",
        path,
        origin,
      },
    });
  });
  test.each([
    ["AC-2 comma-separated", "Read, Grep"],
    ["AC-3 YAML list", "[Read, Grep]"],
    ["block YAML list", "\n  - Read\n  - Grep"],
  ])("%s tools are parsed", (_, tools) => {
    expect(resources.parseAgentFile(path, agent(`name: a\ndescription: d\ntools: ${tools}`), origin)).toMatchObject({
      resource: { tools: ["Read", "Grep"] },
    });
  });
  test.each([
    ["AC-4 missing description", "name: a"],
    ["missing name", "description: d"],
    ["empty name", "name: ''\ndescription: d"],
    ["invalid model", "name: a\ndescription: d\nmodel: 12"],
    ["invalid tools", "name: a\ndescription: d\ntools: [Read, 12]"],
    ["unclosed frontmatter", "name: a\ndescription: d"],
  ])("%s returns only an error diagnostic", (label, fields) => {
    const text = label === "unclosed frontmatter" ? `---\n${fields}` : agent(fields);
    expect(resources.parseAgentFile(path, text, origin)).toEqual({
      diagnostic: { severity: "error", path, origin, message: expect.any(String) },
    });
  });
  test("qualifies plugin agents without retaining executable body", () => {
    expect(
      resources.parseAgentFile(path, agent("name: a\ndescription: d"), { kind: "nax-plugin", plugin: "p" }),
    ).toEqual({
      resource: {
        kind: "agent",
        name: "a",
        qualifiedName: "p:a",
        description: "d",
        path,
        origin: { kind: "nax-plugin", plugin: "p" },
      },
    });
  });
});
