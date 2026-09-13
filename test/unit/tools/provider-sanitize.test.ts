import { describe, expect, test } from "bun:test";
import { absentValue } from "@test/helpers";
import { MAX_PROVIDER_DESCRIPTION_BYTES, sanitizeProviderTools } from "@/tools/provider-sanitize";
import type { ProviderTool } from "@/tools/provider-types";

function tool(over: Partial<ProviderTool> = {}): ProviderTool {
  return {
    localName: "t",
    description: "fine",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "" }),
    ...over,
  };
}

describe("sanitizeProviderTools", () => {
  test("static tools pass through untouched", () => {
    const long = tool({ description: "x".repeat(MAX_PROVIDER_DESCRIPTION_BYTES + 50) });
    const [out] = sanitizeProviderTools("static", [long]);
    expect(out.description).toBe(long.description);
  });

  test("discovered descriptions are truncated, not dropped", () => {
    const long = tool({ description: "x".repeat(MAX_PROVIDER_DESCRIPTION_BYTES + 50) });
    const [out] = sanitizeProviderTools("discovered", [long]);
    expect(out.description.length).toBeLessThanOrEqual(MAX_PROVIDER_DESCRIPTION_BYTES);
    expect(out.localName).toBe("t");
  });

  test("discovered control characters are stripped", () => {
    const [out] = sanitizeProviderTools("discovered", [tool({ description: "ab\u0001c" })]);
    expect(out.description).toBe("abc");
  });

  test("a non-object schema skips that tool only", () => {
    const out = sanitizeProviderTools("discovered", [
      tool({ localName: "good" }),
      // biome-ignore lint/plugin: the schema is a deliberately-absent contract violation, and the skip branch is the assertion.
      tool({ localName: "bad", inputSchema: absentValue<ProviderTool["inputSchema"]>() }),
    ]);
    expect(out.map((t) => t.localName)).toEqual(["good"]);
  });

  test("an oversized schema skips that tool only", () => {
    const huge = { type: "object", properties: { p: { description: "y".repeat(30_000) } } };
    const out = sanitizeProviderTools("discovered", [
      tool({ localName: "good" }),
      tool({ localName: "huge", inputSchema: huge }),
    ]);
    expect(out.map((t) => t.localName)).toEqual(["good"]);
  });

  test("a provider total over the schema cap drops the excess tools", () => {
    const schema = () => ({ type: "object", properties: { p: { description: "y".repeat(7_900) } } });
    const out = sanitizeProviderTools("discovered", [
      tool({ localName: "one", inputSchema: schema() }),
      tool({ localName: "two", inputSchema: schema() }),
      tool({ localName: "three", inputSchema: schema() }),
    ]);
    expect(out.map((t) => t.localName)).toEqual(["one", "two"]);
  });

  test("byte truncation never splits a code point", () => {
    const [out] = sanitizeProviderTools("discovered", [
      tool({ description: "😀".repeat(MAX_PROVIDER_DESCRIPTION_BYTES) }),
    ]);
    expect(Buffer.byteLength(out.description, "utf8")).toBeLessThanOrEqual(MAX_PROVIDER_DESCRIPTION_BYTES);
    // A split surrogate pair would leave an odd number of UTF-16 units.
    expect(out.description.length % 2).toBe(0);
  });
});
