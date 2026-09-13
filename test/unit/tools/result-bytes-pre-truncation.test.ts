import { describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "@/tools";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

function runtimeWith(result: { content: string; resultBytesPreTruncation?: number }) {
  const calls: ToolCallRecord[] = [];
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "probe__t", patterns: ["*"] }], "/w"),
    sink: { record: (entry) => calls.push(entry), flush: async () => {} },
    providerIdByTool: new Map([["probe__t", "probe"]]),
    extraTools: [
      {
        name: "probe__t",
        description: "d",
        inputSchema: { type: "object" },
        scope: { pathFields: [] },
        run: async () => result,
      },
    ],
  });
  return { runtime, calls };
}

describe("ToolCallRecord.resultBytesPreTruncation", () => {
  test("is recorded when the tool reports it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short", resultBytesPreTruncation: 2_000_000 });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]?.resultBytesPreTruncation).toBe(2_000_000);
    expect(calls[0]?.resultBytes).toBe(5);
    expect(calls[0]?.provider).toBe("probe");
  });

  test("is absent when the tool does not report it", async () => {
    const { runtime, calls } = runtimeWith({ content: "short" });
    runtime.advertised(["probe__t"]);
    await runtime.callTool("probe__t", {});
    expect(calls[0]).not.toHaveProperty("resultBytesPreTruncation");
  });
});
