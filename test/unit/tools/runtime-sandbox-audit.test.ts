import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;
beforeAll(() => {
  root = makeTempDir("rt-sbx-audit-");
});
afterAll(() => cleanupTempDir(root));

function runtimeFor(tool: CodingTool, records: ToolCallRecord[]) {
  return createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: tool.name, patterns: ["*"] }], root),
    sink: { record: (e) => void records.push(e), flush: async () => {} },
    extraTools: [tool],
  });
}

describe("tool-audit sandbox field", () => {
  test("a tool's audit.sandbox reaches the recorded row", async () => {
    const records: ToolCallRecord[] = [];
    const tool: CodingTool = {
      name: "Wrapped",
      description: "Wrapped",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "ok", audit: { executed: ["x"], sandbox: { backend: "srt", wrapped: true } } }),
    };
    await runtimeFor(tool, records).callTool("Wrapped", {});
    expect(records[0]?.sandbox).toEqual({ backend: "srt", wrapped: true });
    expect(records[0]?.executed).toEqual(["x"]);
  });

  test("a tool with no sandbox record produces a row WITHOUT the key", async () => {
    const records: ToolCallRecord[] = [];
    const tool: CodingTool = {
      name: "Plain",
      description: "Plain",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: [] },
      run: async () => ({ content: "ok" }),
    };
    await runtimeFor(tool, records).callTool("Plain", {});
    expect(records[0] !== undefined && "sandbox" in records[0]).toBe(false);
  });
});
