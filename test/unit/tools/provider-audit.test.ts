import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolPolicy } from "@/tools/policy";
import { adaptProviderTool } from "@/tools/provider-adapt";
import { advertisedSchemaBytes } from "@/tools/provider-advertise";
import { createCodingToolRuntime } from "@/tools/runtime";
import type { ToolAuditSink, ToolCallRecord } from "@/tools/tool-audit";

describe("advertisedSchemaBytes", () => {
  test("counts description and schema bytes of every advertised tool", () => {
    const tools = [
      adaptProviderTool("p", {
        localName: "a",
        description: "12345",
        inputSchema: { type: "object", properties: {} },
        run: async () => ({ content: "" }),
      }),
    ];
    // 5 description bytes + the JSON length of the schema.
    const expected = 5 + JSON.stringify({ type: "object", properties: {} }).length;
    expect(advertisedSchemaBytes(tools)).toBe(expected);
  });

  test("is zero when nothing is advertised", () => {
    expect(advertisedSchemaBytes([])).toBe(0);
  });
});

describe("provider tool audit", () => {
  test("a provider tool call ledgers with the explicit provider id", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-audit-"));
    const adapted = adaptProviderTool("acme", {
      localName: "probe",
      description: "probe tool",
      inputSchema: { type: "object", properties: {} },
      run: async () => ({ content: "" }),
    });
    const captured: ToolCallRecord[] = [];
    const sink: ToolAuditSink = {
      record(entry) {
        captured.push(entry);
      },
      async flush() {},
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: adapted.name, patterns: ["*"] }], root),
      extraTools: [adapted],
      providerIdByTool: new Map([[adapted.name, "acme"]]),
      sink,
    });

    await runtime.callTool(adapted.name, {});

    expect(captured).toHaveLength(1);
    expect(captured[0]?.provider).toBe("acme");
  });
});
