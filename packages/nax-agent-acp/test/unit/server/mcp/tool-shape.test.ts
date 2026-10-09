import { describe, expect, test } from "bun:test";
import { MCP_DESCRIPTION_BYTES, MCP_SCHEMA_BYTES, shapeDescription, shapeSchema } from "#src/server/mcp/tool-shape";

describe("shapeDescription", () => {
  test("prefixes the server, strips control characters", () => {
    expect(shapeDescription("git", "Show\u0007 status")).toBe("[git] Show status");
  });
  test("an empty description is just the prefix (never empty)", () => {
    expect(shapeDescription("git", "")).toBe("[git]");
  });
  test("caps at MCP_DESCRIPTION_BYTES", () => {
    expect(Buffer.byteLength(shapeDescription("s", "x".repeat(10_000)), "utf8")).toBeLessThanOrEqual(
      MCP_DESCRIPTION_BYTES,
    );
  });
});

describe("shapeSchema", () => {
  test("keeps an object schema, drops $schema", () => {
    expect(
      shapeSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: {} } }),
    ).toEqual({
      ok: true,
      schema: { type: "object", properties: { a: {} } },
    });
  });
  test("adds missing properties", () => {
    expect(shapeSchema({ type: "object" })).toEqual({ ok: true, schema: { type: "object", properties: {} } });
  });
  test.each([
    ["not an object", "x", "input schema is not an object"],
    ["type not object", { type: "string" }, 'input schema type must be "object"'],
    ["properties not an object", { type: "object", properties: [] }, "input schema properties must be an object"],
  ])("rejects %s", (_l, schema, reason) => {
    expect(shapeSchema(schema)).toEqual({ ok: false, reason });
  });
  test("rejects a schema over MCP_SCHEMA_BYTES", () => {
    const big = { type: "object", properties: { a: { description: "x".repeat(MCP_SCHEMA_BYTES) } } };
    expect(shapeSchema(big)).toEqual({ ok: false, reason: `input schema is larger than ${MCP_SCHEMA_BYTES} bytes` });
  });
});
