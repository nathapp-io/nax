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
});
