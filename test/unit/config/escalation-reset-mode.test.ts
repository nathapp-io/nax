/**
 * Tests for autoMode.escalation.resetMode config field (ADR-025 gap #4)
 *
 * Verifies that the resetMode field defaults to "initial", accepts "last",
 * and rejects unknown values.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("autoMode.escalation.resetMode (ADR-025 gap #4)", () => {
  test("defaults to 'initial' when omitted", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.autoMode.escalation.resetMode).toBe("initial");
  });

  test("accepts 'last'", () => {
    const parsed = NaxConfigSchema.parse({
      autoMode: {
        enabled: true,
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 2 }], resetMode: "last" },
      },
    } as never);
    expect(parsed.autoMode.escalation.resetMode).toBe("last");
  });

  test("rejects an unknown mode", () => {
    const result = NaxConfigSchema.safeParse({
      autoMode: {
        enabled: true,
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 2 }], resetMode: "bogus" },
      },
    } as never);
    expect(result.success).toBe(false);
  });
});
