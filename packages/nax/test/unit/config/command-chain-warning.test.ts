import { describe, expect, test } from "bun:test";
import { collectCommandChainWarnings } from "@/config/config-warnings";

describe("collectCommandChainWarnings", () => {
  test("warns for a string command containing &&", () => {
    const warnings = collectCommandChainWarnings({ typecheck: "tsc --noEmit && tsc -p tsconfig.test.json" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("typecheck");
    expect(warnings[0]).toContain("&&");
  });

  test("names the list form in the remedy", () => {
    const [warning] = collectCommandChainWarnings({ lint: "a && b" });
    expect(warning).toContain("list");
  });

  test("is silent for a clean string", () => {
    expect(collectCommandChainWarnings({ lint: "bun run lint" })).toEqual([]);
  });

  test("is silent for a list", () => {
    expect(collectCommandChainWarnings({ typecheck: ["tsc --noEmit", "tsc -p tsconfig.test.json"] })).toEqual([]);
  });

  test("warns once per offending key", () => {
    const warnings = collectCommandChainWarnings({ lint: "a && b", typecheck: "c && d", test: "clean" });
    expect(warnings).toHaveLength(2);
  });

  test("is silent for undefined", () => {
    expect(collectCommandChainWarnings(undefined)).toEqual([]);
  });

  // nax#1990 fix round 1 — a mixed-type array is plausible raw pre-Zod input
  // (schema is z.union([z.string(), z.array(z.string()).min(1)]), so array
  // elements aren't guaranteed to be strings before validation). Must not
  // crash calling .trim() on the non-string element; falls through to Zod's
  // own validation error downstream instead. Built via JSON.parse (returns
  // an untyped value) so this deliberately-invalid fixture needs no type cast.
  test("does not throw and is silent for a mixed-type array", () => {
    const commands = JSON.parse('{"test": ["ok", 42]}');
    expect(() => collectCommandChainWarnings(commands)).not.toThrow();
    expect(collectCommandChainWarnings(commands)).toEqual([]);
  });
});
