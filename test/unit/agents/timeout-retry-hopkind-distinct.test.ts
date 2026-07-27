/**
 * US-002 — AC4: { kind: "timeout-retry", attempt: 1 } and
 * { kind: "stale-retry", attempt: 1 } are distinguishable.
 *
 * The discriminated union on HopKind.kind ensures any consumer can switch
 * on `hopKind.kind` and treat each variant independently. This test pins
 * that the value-level distinction is enforceable.
 */

import { describe, expect, test } from "bun:test";
import type { HopKind } from "@/agents";

describe("HopKind discrimination — AC4", () => {
  test("timeout-retry and stale-retry are distinguishable by their kind fields", () => {
    const a: HopKind = { kind: "timeout-retry", attempt: 1 };
    const b: HopKind = { kind: "stale-retry", attempt: 1 };

    expect(a.kind).toBe("timeout-retry");
    expect(b.kind).toBe("stale-retry");
    expect(a.kind).not.toBe(b.kind);
  });

  test("a dispatcher switching on kind routes timeout-retry and stale-retry differently", () => {
    function classify(k: HopKind): "fresh-session" | "reuse-session" | "primary" | "swap" {
      switch (k.kind) {
        case "primary":
          return "primary";
        case "swap":
          return "swap";
        case "timeout-retry":
          return "fresh-session";
        case "stale-retry":
          return "reuse-session";
      }
    }

    expect(classify({ kind: "primary" })).toBe("primary");
    expect(classify({ kind: "timeout-retry", attempt: 1 })).toBe("fresh-session");
    expect(classify({ kind: "stale-retry", attempt: 1 })).toBe("reuse-session");
  });
});
