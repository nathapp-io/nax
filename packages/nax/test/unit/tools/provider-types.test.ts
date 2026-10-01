import { describe, expect, test } from "bun:test";
import { providerAttachesTo, validateProviderId } from "@/tools/provider-types";

describe("validateProviderId", () => {
  test("accepts lowercase, digits, dash and underscore", () => {
    expect(() => validateProviderId("codebase-memory")).not.toThrow();
    expect(() => validateProviderId("rtk")).not.toThrow();
    expect(() => validateProviderId("a1_b-c")).not.toThrow();
  });

  test("rejects ids that would make the namespace ambiguous", () => {
    for (const bad of ["", "-lead", "Upper", "has space", "has__dunder", "has.dot"]) {
      expect(() => validateProviderId(bad)).toThrow();
    }
  });
});

describe("providerAttachesTo", () => {
  const base = { id: "p", kind: "static" as const, tools: async () => [] };

  test("matches a listed stage", () => {
    expect(providerAttachesTo({ ...base, stages: ["run", "verify"] }, "run")).toBe(true);
  });

  test("does not match an unlisted stage", () => {
    expect(providerAttachesTo({ ...base, stages: ["run"] }, "review")).toBe(false);
  });

  test("wildcard matches every stage", () => {
    expect(providerAttachesTo({ ...base, stages: ["*"] }, "acceptance")).toBe(true);
  });

  test("empty stages matches nothing", () => {
    expect(providerAttachesTo({ ...base, stages: [] }, "run")).toBe(false);
  });
});
