import { describe, expect, test } from "bun:test";
import { codingToolsToDefinitions } from "@/agents/native/session/tool-mapping";
import type { CodingTool } from "@/tools";

const fakeRead: CodingTool = {
  name: "Read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  scope: { pathFields: ["path"] },
  async run() {
    return { content: "body" };
  },
};

describe("codingToolsToDefinitions", () => {
  test("carries name, description and schema onto the wire shape", () => {
    expect(codingToolsToDefinitions([fakeRead])).toEqual([
      {
        name: "Read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("drops the nax-side fields — scope and run mean nothing to a provider", () => {
    const [def] = codingToolsToDefinitions([fakeRead]);
    expect(def).not.toHaveProperty("scope");
    expect(def).not.toHaveProperty("run");
  });

  test("maps an empty list to an empty list", () => {
    expect(codingToolsToDefinitions([])).toEqual([]);
  });
});
