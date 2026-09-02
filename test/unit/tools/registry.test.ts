import { afterEach, describe, expect, test } from "bun:test";
import type { CodingTool } from "@/tools";
import { _resetRegistryForTest, getCodingTool, listCodingTools, registerCodingTool } from "@/tools";

function fakeTool(name: string): CodingTool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: { type: "object", properties: {} },
    scope: { pathFields: [] },
    async run() {
      return { content: "ok" };
    },
  };
}

afterEach(() => {
  _resetRegistryForTest();
});

describe("coding tool registry", () => {
  test("registers and retrieves a third-party tool", () => {
    registerCodingTool(fakeTool("Fetch"));
    expect(getCodingTool("Fetch")?.name).toBe("Fetch");
  });

  test("lists registered tools", () => {
    registerCodingTool(fakeTool("Fetch"));
    expect(listCodingTools().map((t) => t.name)).toContain("Fetch");
  });

  test("returns undefined for an unknown name", () => {
    expect(getCodingTool("Nope")).toBeUndefined();
  });

  // A registered "Write" would shadow the gated implementation: privilege
  // escalation. It must fail at registration, not at call time.
  test("refuses to shadow a reserved built-in name", () => {
    expect(() => registerCodingTool(fakeTool("Write"))).toThrow(/reserved/i);
  });

  test("refuses a duplicate registration", () => {
    registerCodingTool(fakeTool("Fetch"));
    expect(() => registerCodingTool(fakeTool("Fetch"))).toThrow(/already registered/i);
  });

  test("refuses a tool declaring a verb field with no allowedVerbs", () => {
    const bad = { ...fakeTool("Verby"), scope: { pathFields: [], verbField: "cmd" } };
    expect(() => registerCodingTool(bad)).toThrow(/allowedVerbs/i);
  });
});
