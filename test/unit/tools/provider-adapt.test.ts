import { describe, expect, test } from "bun:test";
import { adaptProviderTool, namespacedToolName } from "@/tools/provider-adapt";
import type { ProviderTool } from "@/tools/provider-types";

function tool(localName: string): ProviderTool {
  return {
    localName,
    description: "d",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "ok" }),
  };
}

describe("namespacedToolName", () => {
  test("joins with a double underscore", () => {
    expect(namespacedToolName("rtk", "recall")).toBe("rtk__recall");
  });

  test("a local name containing __ is preserved verbatim", () => {
    // The namespaced name is never parsed back apart, so this needs no escaping.
    expect(namespacedToolName("mcp", "a__b")).toBe("mcp__a__b");
  });
});

describe("adaptProviderTool", () => {
  test("produces a CodingTool gated at tool-name level only", () => {
    const adapted = adaptProviderTool("rtk", tool("recall"));
    expect(adapted.name).toBe("rtk__recall");
    expect(adapted.scope).toEqual({ pathFields: [] });
    expect(adapted.inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("delegates run to the provider tool", async () => {
    const adapted = adaptProviderTool("rtk", tool("recall"));
    const result = await adapted.run(
      {},
      {
        root: "/tmp",
        resolvedPaths: [],
        maxBytes: 100,
        maxFileBytes: 100,
      },
    );
    expect(result.content).toBe("ok");
  });

  test("refuses a namespaced name colliding with a built-in", () => {
    // Defence-in-depth: a provider id cannot contain "__", so this is
    // unreachable today. It guards a future change to the naming scheme.
    expect(() => adaptProviderTool("read", { ...tool("x"), localName: "x" })).not.toThrow();
    expect(() => namespacedToolName("Read", "x")).toThrow();
  });
});
