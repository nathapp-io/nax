import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema } from "@/config";

describe("profile tier resolution", () => {
  test("a shorthand profile target binds to its canonical tier rung (spec §2)", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        agents: {
          enabled: true,
          strategy: "off",
          profiles: [{ id: "claude-sonnet", target: { agent: "claude", model: "sonnet" }, strengths: ["impl"] }],
        },
      },
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode?.escalation,
          tierOrder: [{ tier: "balanced", agent: "claude", attempts: 2 }],
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
