// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { toToolDefinitions } from "@/agents/native/session/tool-mapping";
import type { ToolDescriptor } from "@/context/engine";

const descriptor: ToolDescriptor = {
  name: "query_neighbor",
  description: "Fetch a neighbouring file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  maxCallsPerSession: 5,
  maxTokensPerCall: 2000,
};

describe("toToolDefinitions", () => {
  test("carries name, description and schema across", () => {
    expect(toToolDefinitions([descriptor])).toEqual([
      {
        name: "query_neighbor",
        description: "Fetch a neighbouring file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("drops the budget fields — they are enforced nax-side, not on the wire", () => {
    const [def] = toToolDefinitions([descriptor]);
    expect(def).not.toHaveProperty("maxCallsPerSession");
    expect(def).not.toHaveProperty("maxTokensPerCall");
  });

  test("an empty descriptor list yields no definitions", () => {
    expect(toToolDefinitions([])).toEqual([]);
  });
});
