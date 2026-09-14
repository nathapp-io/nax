import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { validatePermissionsBlock } from "@/config/config-guards";

const block = (permissions: Record<string, unknown>) => ({ execution: { permissions } });

describe("Mcp(...) expressions at load", () => {
  test.each([["Mcp(context7)"], ["Mcp(context7:query-docs)"], ["Mcp(context7:*)"], ["Mcp(a,b:one)"]])(
    "%s is accepted",
    (expression) => {
      expect(() => validatePermissionsBlock(block({ run: { allow: [expression] } }))).not.toThrow();
    },
  );

  test("an unknown server is NOT a load error (a config is shared across machines)", () => {
    expect(() => validatePermissionsBlock(block({ run: { allow: ["Mcp(never-configured)"] } }))).not.toThrow();
  });

  // The repo idiom for a thrown NaxError is `toThrow(/regex/i)` on the message
  // (see test/unit/config/scoped-profile-accepted.test.ts:38-66). `assertNaxError`
  // from @test/helpers is something else entirely — it narrows an already-CAUGHT
  // value (`assertNaxError(err, label)`), so do not reach for it here.
  test.each([["Mcp(Context7)"], ["Mcp(has spaces)"], ["Mcp(:no-server)"], ["Mcp(a__b)"]])(
    "%s is a malformed-pattern error",
    (expression) => {
      expect(() => validatePermissionsBlock(block({ run: { allow: [expression] } }))).toThrow(/malformed Mcp pattern/i);
    },
  );

  test("the malformed-pattern refusal carries the CONFIG_PERMISSIONS_BAD_PATTERN code", () => {
    try {
      validatePermissionsBlock(block({ run: { allow: ["Mcp(Context7)"] } }));
      throw new Error("expected validatePermissionsBlock to throw");
    } catch (err) {
      assertNaxError(err, "validatePermissionsBlock rejection");
      expect(err.code).toBe("CONFIG_PERMISSIONS_BAD_PATTERN");
    }
  });

  test("Mcp rules are legal in deny and ask lists too", () => {
    expect(() =>
      validatePermissionsBlock(block({ run: { deny: ["Mcp(graph)"], ask: ["Mcp(graph:mutate)"] } })),
    ).not.toThrow();
  });
});
